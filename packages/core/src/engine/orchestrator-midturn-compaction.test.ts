/**
 * ADR-119: авто-компактификация ПОСРЕДИ хода основного цикла.
 *
 * Сжатие срабатывает на границе шага (между вызовами инструментов), а не
 * только по факту переполнения окна: длинный ход не должен съедать контекст.
 *
 * Проверяем:
 * - сжатие происходит МЕЖДУ шагами (не на первом шаге хода);
 * - `currentMessages` пересобирается: запрос начинается с user-чекпоинта
 *   `[CONTEXT CHECKPOINT]`, покрытый прошлый ход в запросе отсутствует;
 * - сжатие не съедает шаг: индексы шагов contiguous, `toolIteration` не
 *   сдвигается;
 * - потолок `MAX_MID_TURN_COMPRESSIONS` (2) соблюдается;
 * - отмена во время сжатия закрывает ход как отменённый и НЕ оставляет
 *   cooldown (иначе следующий ход не смог бы сжаться ещё 10 минут);
 * - сбой сжатия не ломает ход: шаг продолжается, cooldown выставлен.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ContextOptimizer } from './context/optimizer.js';
import type { BaseProvider, LLMMessage, CancellationToken } from '../providers/base.js';
import type {
  LLMChunk,
  Message,
  LLMResponse,
  TokenUsage,
  PermissionConfig,
  ToolDefinition,
} from '@itphx/synth-shared';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider as ProviderBase } from '../providers/base.js';
import { createToolRegistry } from './tools/index.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart, ToolCapability } from '@itphx/synth-shared';

const USAGE: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Шаг сценария провайдера. */
interface ScriptStep {
  content: string;
  toolCalls?: Array<{ id: string; name: string }>;
}

function toToolCall(tc: { id: string; name: string }): Record<string, unknown> {
  return { id: tc.id, type: 'function', function: { name: tc.name, arguments: '{}' } };
}

/** Провайдер-сценарий: шаги из `script`, дальше — последний шаг. */
class MidTurnProvider extends ProviderBase {
  static script: ScriptStep[] = [];
  static calls = 0;
  /**
   * Снимки запросов по шагам. Копия массива, а не ссылка: `currentMessages`
   * переиспользуется оркестратором (пересборка после сжатия) — ссылка
   * изменилась бы задним числом.
   */
  static requests: LLMMessage[][] = [];

  private _next(): ScriptStep {
    const step = MidTurnProvider.script[
      Math.min(MidTurnProvider.calls, MidTurnProvider.script.length - 1)
    ]!;
    MidTurnProvider.calls += 1;
    return step;
  }

  async chat(): Promise<LLMResponse> {
    const step = this._next();
    return {
      content: step.content,
      model: this.model,
      usage: USAGE,
      ...(step.toolCalls ? { toolCalls: step.toolCalls.map(toToolCall) } : {}),
    };
  }

  async *chatAsync(messages: LLMMessage[]): AsyncGenerator<LLMChunk> {
    const step = this._next();
    MidTurnProvider.requests.push([...messages]);
    yield {
      content: step.content,
      isFinal: true,
      ...(step.toolCalls ? { toolCalls: step.toolCalls.map(toToolCall) } : {}),
      model: this.model,
      usage: USAGE,
    };
  }

  getProviderName(): string {
    return 'midturn-script';
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function makeAssistantMessage(content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.ASSISTANT,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'assistant',
    agentRole: 'fixer',
  };
}

/** Наблюдаемое состояние оптимизатора-стаба. */
interface StubOptimizer extends ContextOptimizer {
  /** Сколько раз готовился план сжатия. */
  prepareCalls: number;
  /** Сколько раз вызывалось завершение сжатия. */
  completeCalls: number;
  /** Сколько раз отмечен провал сжатия (cooldown). */
  noteFailureCalls: number;
  /** Сколько вызовов провайдера было к моменту подготовки сжатия. */
  providerCallsAtPrepare: number;
  /** Токен отмены, дошедший до `completeCompression`. */
  lastCancelToken: CancellationToken | undefined;
}

interface StubOptions {
  /** Индексы покрываемых сообщений (план сжатия). */
  coveredIndices: number[];
  /** Отменить токен прямо во время сжатия (успешного). */
  cancelDuringCompression?: boolean;
  /** `completeCompression` бросает (сбой сжатия). */
  failComplete?: boolean;
  /** Порог триггера всё ещё превышен после сжатия → cooldown. */
  stillTriggeredAfter?: boolean;
}

function makeStubOptimizer(opts: StubOptions): StubOptimizer {
  const stub = {
    prepareCalls: 0,
    completeCalls: 0,
    noteFailureCalls: 0,
    providerCallsAtPrepare: -1,
    lastCancelToken: undefined as CancellationToken | undefined,
    setGatewayHooks: () => {},
    getContextWindow: () => 100_000,
    estimateTokens: () => 0,
    estimatePromptTokens: () => 0,
    effectiveMode: () => 'compaction',
    canSummarize: () => true,
    canCompress: () => true,
    isCompressionCoolingDown: () => false,
    noteCompressionFailure: () => {
      stub.noteFailureCalls += 1;
    },
    clearCompressionFailure: () => {},
    shouldCompress: (_session: unknown, o?: { ignoreCooldown?: boolean }) => ({
      triggered: o?.ignoreCooldown === true ? opts.stillTriggeredAfter === true : true,
      reason: 'tokens' as const,
      mode: 'compaction' as const,
    }),
    getMessagesForLlm: (session: { messages: Message[] }) =>
      session.messages.filter((m) => !m.disabled),
    prepareCompression: () => {
      stub.prepareCalls += 1;
      stub.providerCallsAtPrepare = MidTurnProvider.calls;
      return {
        mode: 'compaction',
        provider: {} as BaseProvider,
        llmMessages: [],
        systemPrompt: 'COMPACTOR',
        messagesToCompress: [],
        coveredIndices: opts.coveredIndices,
        keepFromIndex: -1,
        keepMessages: [],
      };
    },
    completeCompression: async (
      _plan: unknown,
      o?: { cancelToken?: CancellationToken },
    ) => {
      stub.completeCalls += 1;
      stub.lastCancelToken = o?.cancelToken;
      if (opts.cancelDuringCompression) o?.cancelToken?.cancel();
      if (opts.failComplete) throw new Error('compression failed');
      return {
        content: '## Objective\nцель\n\n## Work State\n- готово',
        response: { content: 's', model: 'm', usage: USAGE },
      };
    },
  };
  return stub as unknown as StubOptimizer;
}

/** Тул без побочных эффектов (вызывается моделью между шагами). */
function makeProbeTool(onCall?: () => void): ToolDefinition {
  return {
    name: 'probe',
    description: 'тул-зонд: без побочных эффектов',
    parameters: z.object({}).passthrough(),
    capabilities: [ToolCapability.RUNTIME],
    async execute() {
      onCall?.();
      return { content: 'probe: ok' };
    },
  } as unknown as ToolDefinition;
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  sessionId: string;
  tmpDir: string;
}

async function makeHarness(opts: {
  optimizer: StubOptimizer;
  seed?: Message[];
  onToolCall?: () => void;
}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-midturn-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const toolRegistry = createToolRegistry();
  toolRegistry.register(makeProbeTool(opts.onToolCall));
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    contextOptimizer: opts.optimizer,
    providerLoader: (name: string) => ({
      name,
      type: 'midturn-script',
      baseUrl: '',
      apiKey: '',
      defaultModel: 'm',
    }) as unknown as import('@itphx/synth-shared').ProviderConfig,
    toolRegistry,
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    defaultWorkingDir: tmpDir,
  });
  const session = await sessionManager.createSession({
    title: 'MidTurn',
    settings: {
      provider: 'midturn-script',
      model: 'm',
      systemPrompt: 'test',
      agentRole: 'fixer',
      contextOptimization: 'compaction',
    },
  });
  for (const message of opts.seed ?? []) await sessionManager.addMessage(session.id, message);
  return { orchestrator, sessionManager, eventBus, sessionId: session.id, tmpDir };
}

async function run(
  h: Harness,
): Promise<{
  result: import('./orchestrator.js').ProcessMessageResult;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  busEvents: Array<{ type: string; data: Record<string, unknown> }>;
}> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.filter((m) => m.role === MessageRole.USER).slice(-1)[0]!;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const busEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const unsubscribe = h.eventBus.subscribe(h.sessionId, (event) => {
    busEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
  });
  try {
    const result = await processMessage(
      fresh,
      userMsg,
      new AbortController().signal,
      (event, data) => events.push({ event, data }),
    );
    return { result, events, busEvents };
  } finally {
    unsubscribe();
  }
}

/** Старый ход (покрывается первым сжатием) + реплика текущего хода. */
function seedMessages(): Message[] {
  return [
    makeUserMessage('старый вопрос'),
    makeAssistantMessage('старый ответ'),
    makeUserMessage('текущий вопрос'),
  ];
}

describe('ADR-119: авто-компактификация посреди хода (основной цикл)', () => {
  beforeEach(() => {
    ProviderFactory.register('midturn-script', MidTurnProvider);
    MidTurnProvider.calls = 0;
    MidTurnProvider.requests = [];
    MidTurnProvider.script = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('midturn-script');
  });

  it('сжатие срабатывает между шагами (не на первом шаге) и пересобирает запрос', async () => {
    MidTurnProvider.script = [
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'probe' }] },
      { content: 'готово' },
    ];
    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1] });
    const h = await makeHarness({ optimizer, seed: seedMessages() });

    const { result, busEvents } = await run(h);
    expect(result.error).toBeUndefined();

    // Сжатие было ровно одно и подготовлено ПОСЛЕ первого шага.
    expect(optimizer.prepareCalls).toBe(1);
    expect(optimizer.completeCalls).toBe(1);
    expect(optimizer.providerCallsAtPrepare).toBe(1);

    // Первый запрос — без чекпоинта (на шаге 0 сжатия не было).
    expect(MidTurnProvider.requests[0]!.some((m) => m.content.includes('[CONTEXT CHECKPOINT]'))).toBe(false);
    // Второй запрос — пересобран: первым идёт user-чекпоинт.
    const second = MidTurnProvider.requests[1]!;
    expect(second[0]!.role).toBe('user');
    expect(second[0]!.content).toContain('[CONTEXT CHECKPOINT]');
    // Покрытый прошлый ход в запросе отсутствует, текущий — на месте.
    expect(second.some((m) => m.content === 'старый вопрос')).toBe(false);
    expect(second.some((m) => m.content === 'текущий вопрос')).toBe(true);
    // Пары tool-вызовов целы: assistant(toolUse) → tool.
    const toolUse = second.find((m) => m.role === 'assistant' && m.toolUse?.length);
    expect(toolUse).toBeDefined();
    expect(second.some((m) => m.role === 'tool' && m.toolCallId === 'call_1')).toBe(true);

    // Событие сжатия помечено фазой `mid_turn` (аддитивное поле).
    const applied = busEvents.filter((e) => e.type === 'context.summarization_applied');
    expect(applied.length).toBe(1);
    expect(applied[0]!.data.phase).toBe('mid_turn');
    expect(applied[0]!.data.reason).toBe('auto');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('сжатие не съедает шаг: индексы шагов contiguous, лимит шагов не сдвинут', async () => {
    MidTurnProvider.script = [
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'probe' }] },
      { content: 'шаг 2', toolCalls: [{ id: 'call_2', name: 'probe' }] },
      { content: 'готово' },
    ];
    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1] });
    const h = await makeHarness({ optimizer, seed: seedMessages() });

    const { result, events } = await run(h);
    expect(result.error).toBeUndefined();

    // Сжатие было (между шагами), но шагов столько же, сколько вызовов
    // провайдера: сжатие не съело ни одного шага (индексы шагов contiguous).
    expect(optimizer.prepareCalls).toBe(2);
    expect(MidTurnProvider.calls).toBe(3);
    const started = events.filter((e) => e.event === 'step.started');
    expect(started.map((e) => e.data.stepIndex)).toEqual([0, 1, 2]);
    const finished = events.filter((e) => e.event === 'step.finished');
    expect(finished.map((e) => e.data.stepIndex)).toEqual([0, 1, 2]);
    // Пересобранный контекст живёт дальше: следующий запрос тоже начинается
    // с чекпоинта (старая база сообщений не вернулась).
    expect(MidTurnProvider.requests[2]![0]!.content).toContain('[CONTEXT CHECKPOINT]');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('потолок сжатий за ход соблюдается (третий триггер сжатие не запускает)', async () => {
    MidTurnProvider.script = [
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'probe' }] },
      { content: 'шаг 2', toolCalls: [{ id: 'call_2', name: 'probe' }] },
      { content: 'шаг 3', toolCalls: [{ id: 'call_3', name: 'probe' }] },
      { content: 'готово' },
    ];
    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1] });
    const h = await makeHarness({ optimizer, seed: seedMessages() });

    const { result } = await run(h);
    expect(result.error).toBeUndefined();

    // MAX_MID_TURN_COMPRESSIONS = 2: три шага с инструментами дали ровно
    // две сжатия (шаги 1 и 2), третье — уже за потолком.
    expect(optimizer.prepareCalls).toBe(2);
    expect(optimizer.completeCalls).toBe(2);
    expect(MidTurnProvider.calls).toBe(4);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отмена во время сжатия закрывает ход как отменённый и не оставляет cooldown', async () => {
    MidTurnProvider.script = [
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'probe' }] },
      { content: 'готово' },
    ];
    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1], cancelDuringCompression: true });
    const h = await makeHarness({ optimizer, seed: seedMessages() });

    const { result, events } = await run(h);

    // Ход закрыт отменой (не ошибкой).
    expect(result.error).toBeUndefined();
    expect(events.some((e) => e.event === 'stream.cancelled')).toBe(true);
    expect(events.some((e) => e.event === 'turn.finished' && e.data.status === 'cancelled')).toBe(true);
    // Сжатие состоялось, но провала не было — cooldown не выставлен.
    expect(optimizer.prepareCalls).toBe(1);
    expect(optimizer.noteFailureCalls).toBe(0);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('сбой сжатия не ломает ход: шаг продолжается, cooldown выставлен', async () => {
    MidTurnProvider.script = [
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'probe' }] },
      { content: 'готово' },
    ];
    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1], failComplete: true });
    const h = await makeHarness({ optimizer, seed: seedMessages() });

    const { result, busEvents } = await run(h);

    // Ход не упал: сжатие не состоялось, но агент ответил.
    expect(result.error).toBeUndefined();
    expect(MidTurnProvider.calls).toBe(2);
    // Провал сжатия отмечен (cooldown) — авто-триггер не будет звать LLM по кругу.
    expect(optimizer.prepareCalls).toBe(1);
    expect(optimizer.noteFailureCalls).toBe(1);

    // Провал виден пользователю: событие `context.summarization_failed`
    // (фаза `mid_turn`).
    const failed = busEvents.filter((e) => e.type === 'context.summarization_failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.data.phase).toBe('mid_turn');
    expect(failed[0]!.data.reason).toBe('error');
    expect(String(failed[0]!.data.message)).toContain('compression failed');

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
