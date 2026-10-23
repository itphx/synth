/**
 * ADR-104: вплетение инъекций в активный ход — строго на границе шага
 * (пары toolUse/toolResult не рвутся), персист `metadata.steer` и события.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig, Message } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import { enqueueSteerMessage } from '../queue/processor.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(content = 'выполни задачу'): Message {
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

/**
 * Провайдер с двумя вызовами:
 * - вызов 0 — tool call (`read_file`) + побочный эффект `onCall` (постановка
 *   инъекции в очередь — эмуляция отправки во время хода);
 * - вызов 1 — финальный текст.
 *
 * Запросы к провайдеру сохраняются, чтобы проверить, что инъекция попала
 * в контекст ПОСЛЕ пары assistant(toolUse) → tool(toolResult).
 */
class MockSteerProvider extends BaseProvider {
  static calls = 0;
  static captures: LLMMessage[][] = [];
  static onCall: ((n: number) => Promise<void> | void) | null = null;
  /** Tool call первого шага (ADR-104 этап 3 — разные сценарии ask/plan). */
  static toolCall: { name: string; args: Record<string, unknown> } = {
    name: 'read_file',
    args: { file_path: 'missing.txt' },
  };

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Готово', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockSteerProvider.calls++;
    MockSteerProvider.captures.push(messages.map((m) => ({ ...m })));
    if (MockSteerProvider.onCall) await MockSteerProvider.onCall(n);
    if (n === 0) {
      yield {
        content: 'Шаг 1: читаю файл', isFinal: true,
        toolCalls: [{
          id: 'call_s0',
          function: {
            name: MockSteerProvider.toolCall.name,
            arguments: JSON.stringify(MockSteerProvider.toolCall.args),
          },
        }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    yield {
      content: 'Готово', isFinal: true,
      model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mocksteer';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
}

/** Опции тестового стенда (ADR-104 этап 3): правила прав и режим сессии. */
interface HarnessOptions {
  /** Правила permission-слоя (например `{ read_file: 'ask' }`). */
  rules?: Record<string, 'allow' | 'deny' | 'ask'>;
  /** Режим сессии (`plan` — мутирующие тулы запрещены). */
  sessionMode?: 'plan' | 'act' | 'yolo';
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-steer-orch-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('Steer', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'mocksteer', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry: createToolRegistry(),
    permissionConfig: { rules: options.rules ?? {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });
  const session = await sessionManager.createSession({
    title: 'Steer',
    projectId: project.id,
    settings: { provider: 'mocksteer', model: 'm', systemPrompt: 'test', agentRole: 'developer' },
  });
  if (options.sessionMode) {
    await sessionManager.withLock(session.id, async (s) => {
      s.mode = options.sessionMode;
      await sessionManager.updateSession(s);
    });
  }
  await sessionManager.addMessage(session.id, makeMessage());
  return { orchestrator, sessionManager, eventBus, tmpDir, sessionId: session.id };
}

async function run(
  h: Harness,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
): Promise<import('./orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, new AbortController().signal, publishChunk);
}

describe('ChatOrchestrator: инъекции в активный ход (ADR-104)', () => {
  beforeEach(() => {
    ProviderFactory.register('mocksteer', MockSteerProvider);
    MockSteerProvider.calls = 0;
    MockSteerProvider.captures = [];
    MockSteerProvider.onCall = null;
    MockSteerProvider.toolCall = { name: 'read_file', args: { file_path: 'missing.txt' } };
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mocksteer');
  });

  it('инъекция попадает в ход на границе шага — после пары toolUse/toolResult', async () => {
    const h = await makeHarness();
    // Отправка «во время хода»: инъекция попадает в очередь после первого
    // шага (пока идёт tool call).
    MockSteerProvider.onCall = async (n) => {
      if (n === 0) {
        await enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('СТОП, сделай иначе'),
        );
      }
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Два вызова провайдера: первый (tool call) и второй (после инъекции).
    expect(MockSteerProvider.captures).toHaveLength(2);
    const second = MockSteerProvider.captures[1]!;

    const assistantIdx = second.findIndex((m) => m.role === 'assistant' && !!m.toolUse?.length);
    const toolIdx = second.findIndex((m) => m.role === 'tool');
    const injectedIdx = second.findIndex(
      (m) => m.role === 'user' && m.content.includes('СТОП, сделай иначе'),
    );

    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBe(assistantIdx + 1);
    // Инъекция — ПОСЛЕ результата инструмента: пара toolUse/toolResult не разорвана.
    expect(injectedIdx).toBe(toolIdx + 1);

    // Первая итерация инъекцию ещё не видела.
    const first = MockSteerProvider.captures[0]!;
    expect(first.some((m) => m.content.includes('СТОП, сделай иначе'))).toBe(false);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('инъекция персистится в истории как user-сообщение с metadata.steer', async () => {
    const h = await makeHarness();
    MockSteerProvider.onCall = async (n) => {
      if (n === 0) {
        await enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('вмешательство'),
        );
      }
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, (event, data) => chunks.push({ event, data }));

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const injected = session.messages.find((m) => m.content === 'вмешательство');
    expect(injected).toBeDefined();
    expect(injected!.role).toBe(MessageRole.USER);
    expect(injected!.metadata?.steer).toBe(true);

    // Событие message.injected — с позицией сообщения в истории.
    const evt = chunks.find((c) => c.event === 'message.injected');
    expect(evt).toBeDefined();
    expect(evt!.data.content).toBe('вмешательство');
    expect(evt!.data.message_index).toBe(session.messages.indexOf(injected!));

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('лишние инъекции сверх лимита хода отбрасываются событием steer.dropped', async () => {
    const h = await makeHarness();
    MockSteerProvider.onCall = async (n) => {
      if (n === 0) {
        // 7 сообщений в очередь: лимит хода — 5, остаток отбрасывается.
        for (let i = 0; i < 7; i++) {
          await h.sessionManager.enqueueSteerMessage(h.sessionId, makeMessage(`вмешательство ${i}`), 10);
        }
      }
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, (event, data) => chunks.push({ event, data }));

    const dropped = chunks.find((c) => c.event === 'steer.dropped');
    expect(dropped).toBeDefined();
    expect(dropped!.data.reason).toBe('limit');
    expect(dropped!.data.dropped_count).toBe(2);

    // В ленту попали только 5 инъекций (лимит хода).
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const injected = session.messages.filter((m) => m.metadata?.steer === true);
    expect(injected).toHaveLength(5);
    expect(injected.map((m) => m.content)).toEqual([
      'вмешательство 0', 'вмешательство 1', 'вмешательство 2',
      'вмешательство 3', 'вмешательство 4',
    ]);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('приоритет (этап 3): interrupt вплетается в контекст раньше steer, внутри класса — FIFO', async () => {
    const h = await makeHarness();
    // Порядок постановки: steer → interrupt → steer. В контексте хода
    // инъекции должны лечь: interrupt, затем steer'ы (FIFO внутри класса).
    MockSteerProvider.onCall = async (n) => {
      if (n === 0) {
        await enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('вмешательство 1'),
        );
        await enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('прерывание 1'),
          undefined, undefined, { interrupt: true },
        );
        await enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('вмешательство 2'),
        );
      }
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, (event, data) => chunks.push({ event, data }));

    const second = MockSteerProvider.captures[1]!;
    const injectedOrder = second
      .filter((m) => m.role === 'user' && (
        m.content.includes('вмешательство') || m.content.includes('прерывание')
      ))
      .map((m) => m.content);
    expect(injectedOrder).toEqual(['прерывание 1', 'вмешательство 1', 'вмешательство 2']);

    // Порядок сохраняется и в истории сессии.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const injected = session.messages.filter((m) => m.metadata?.steer === true);
    expect(injected.map((m) => m.content)).toEqual([
      'прерывание 1', 'вмешательство 1', 'вмешательство 2',
    ]);

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});

/**
 * ADR-104, этап 3: поведение инъекции при ожидании подтверждения прав (`ask`)
 * и в режиме `plan`.
 *
 * Правило: инъекция — это ввод в тот же ход, а не ответ пользователя:
 * - она НЕ отвечает за пользователя на `permission.asked`;
 * - она НЕ отменяет ожидающее подтверждение (инъекция ждёт границы шага,
 *   а ход, стоящий на `ask`, применяет её на границе ПОСЛЕ ответа);
 * - она НЕ расширяет права: в режиме `plan` мутирующий тул остаётся запрещённым.
 */
describe('ChatOrchestrator: инъекция при `ask` и в режиме `plan` (ADR-104 этап 3)', () => {
  beforeEach(() => {
    ProviderFactory.register('mocksteer', MockSteerProvider);
    MockSteerProvider.calls = 0;
    MockSteerProvider.captures = [];
    MockSteerProvider.onCall = null;
    MockSteerProvider.toolCall = { name: 'read_file', args: { file_path: 'missing.txt' } };
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mocksteer');
  });

  it('инъекция при активном ask не отвечает за пользователя; применяется на границе после ответа', async () => {
    const h = await makeHarness({ rules: { read_file: 'ask' } });
    const asked: Array<Record<string, unknown>> = [];
    let repliedByTest = 0;
    // Счётчик вызовов провайдера на момент запроса подтверждения: инъекция
    // не должна «убежать» вперёд, пока ход стоит на `ask`.
    let providerCallsAtAsk = -1;
    let pendingAtAsk = -1;

    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.asked') {
        const data = event.data as Record<string, unknown>;
        asked.push(data);
        providerCallsAtAsk = MockSteerProvider.captures.length;
        // Пользователь пишет в чат, пока висит подтверждение прав.
        void enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('продолжай, но осторожно'),
        ).then((result) => {
          pendingAtAsk = result.pending;
        });
        // Ответ на подтверждение — только явный (от пользователя), не инъекция.
        h.eventBus.publish(h.sessionId, 'permission.replied', {
          approval_id: data.approval_id,
          session_id: h.sessionId,
          approved: true,
        });
        repliedByTest++;
      }
    });

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Подтверждение прав было запрошено ровно один раз.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.tool).toBe('read_file');
    // Ответ дал пользователь (тест), а не инъекция: ответов ровно один.
    expect(repliedByTest).toBe(1);
    // На момент `ask` второй вызов провайдера ещё не был (ход стоял на подтверждении).
    expect(providerCallsAtAsk).toBe(1);
    // Инъекция ждала в очереди, а не была применена вместо ответа.
    expect(pendingAtAsk).toBe(1);

    // Инъекция применена на границе ПОСЛЕ ответа: во втором вызове провайдера
    // она идёт после результата инструмента (инструмент выполнился).
    expect(MockSteerProvider.captures).toHaveLength(2);
    const second = MockSteerProvider.captures[1]!;
    const toolIdx = second.findIndex((m) => m.role === 'tool');
    const injectedIdx = second.findIndex(
      (m) => m.role === 'user' && m.content.includes('продолжай, но осторожно'),
    );
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(injectedIdx).toBe(toolIdx + 1);

    // Тул реально выполнился (ответ «allow»), а не отклонён по правам.
    const toolMessage = second[toolIdx]!;
    expect(toolMessage.content ?? '').not.toMatch(/denied|not allowed|запрещ/i);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('в режиме plan мутирующий тул остаётся запрещённым после инъекции', async () => {
    const h = await makeHarness({ sessionMode: 'plan' });
    const denied: Array<Record<string, unknown>> = [];
    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.denied') denied.push(event.data as Record<string, unknown>);
    });
    const target = join(h.tmpDir, 'plan-denied.txt');
    MockSteerProvider.toolCall = {
      name: 'write_file',
      args: { file_path: target, content: 'не должно быть записано' },
    };
    // Инъекция приходит на первом шаге — до решения по мутирующему тулу.
    MockSteerProvider.onCall = async (n) => {
      if (n === 0) {
        await enqueueSteerMessage(
          h.sessionManager, h.eventBus, h.sessionId, makeMessage('запиши файл, я разрешаю'),
        );
      }
    };

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Инъекция применена (это обычное сообщение хода).
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const injected = session.messages.filter((m) => m.metadata?.steer === true);
    expect(injected.map((m) => m.content)).toEqual(['запиши файл, я разрешаю']);

    // Но права не расширились: мутирующий тул отклонён, файл не создан.
    expect(existsSync(target)).toBe(false);
    expect(denied).toHaveLength(1);
    // Отказ — именно plan-рестрикция permission-слоя (ADR-025), а не «нет подтверждения».
    expect(denied[0]!.matched_rule).toBe('plan.deny');
    expect(denied[0]!.tool).toBe('write_file');
    const second = MockSteerProvider.captures[1]!;
    const toolMessage = second.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content ?? '').toContain('unavailable in the current mode');

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
