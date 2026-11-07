/**
 * ADR-119: авто-компактификация дочерней сессии саб-агента (граница шага).
 *
 * У ребёнка свой режим оптимизации контекста (`compaction`) — иначе длинный
 * прогон упирается в окно модели/предохранитель `subagentMaxInputTokens`.
 * Сжатие применяется к живой сессии ребёнка, а в текущий запрос подставляется
 * пересобранный контекст (`[CONTEXT CHECKPOINT]` + живой хвост).
 *
 * Проверяем:
 * - сжатие срабатывает и контекст пересобирается (чекпоинт + хвост);
 * - потолок сжатий за прогон соблюдается;
 * - без зависимостей сжатие пропускается (fail-open);
 * - сбой сжатия ставит cooldown (авто-триггер не зовёт LLM по кругу);
 * - отмена **не** оставляет cooldown (иначе следующий прогон не сможет
 *   сжаться ещё 10 минут).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';
import type { ContextOptimizer } from '../../context/optimizer.js';
import type { CompressionPlan } from '../../context/optimizer.js';
import type { BaseProvider, CancellationToken, LLMMessage } from '../../../providers/base.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { EventBus } from '../../../events/bus.js';
import {
  tryCompactChildSession,
  MAX_SUBAGENT_MID_TURN_COMPRESSIONS,
} from './child-compaction.js';
import type { TaskExtra } from './types.js';

let tmpDir: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-child-compaction-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeMsg(content: string, role: MessageRole = MessageRole.USER): Message {
  return {
    id: generateId(),
    role,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
  };
}

interface StubOptions {
  /** Индексы покрываемых сообщений (план сжатия). */
  coveredIndices?: number[];
  /** Триггер сжатия не срабатывает. */
  noTrigger?: boolean;
  /** `completeCompression` бросает (сбой сжатия). */
  failComplete?: boolean;
  /** Отменить токен прямо во время сжатия (успешного). */
  cancelDuringCompression?: boolean;
  /** Cooldown активен (сжатие не запускается). */
  coolingDown?: boolean;
  /** Порог триггера всё ещё превышен после сжатия → cooldown. */
  stillTriggeredAfter?: boolean;
}

interface StubOptimizer extends ContextOptimizer {
  prepareCalls: number;
  completeCalls: number;
  noteFailureCalls: number;
  clearFailureCalls: number;
}

function makeStubOptimizer(opts: StubOptions = {}): StubOptimizer {
  const covered = opts.coveredIndices ?? [0, 1];
  const stub = {
    prepareCalls: 0,
    completeCalls: 0,
    noteFailureCalls: 0,
    clearFailureCalls: 0,
    setGatewayHooks: () => {},
    getContextWindow: () => 100_000,
    estimatePromptTokens: () => 0,
    estimateTokens: () => 0,
    effectiveMode: () => 'compaction',
    canSummarize: () => true,
    canCompress: () => true,
    isCompressionCoolingDown: () => opts.coolingDown === true,
    noteCompressionFailure: () => {
      stub.noteFailureCalls += 1;
    },
    clearCompressionFailure: () => {
      stub.clearFailureCalls += 1;
    },
    shouldCompress: (_session: unknown, o?: { ignoreCooldown?: boolean }) => ({
      triggered: o?.ignoreCooldown === true
        ? opts.stillTriggeredAfter === true
        : opts.noTrigger !== true,
      reason: 'tokens' as const,
      mode: 'compaction' as const,
    }),
    getMessagesForLlm: (session: { messages: Message[] }) =>
      session.messages.filter((m) => !m.disabled),
    prepareCompression: () => {
      stub.prepareCalls += 1;
      return {
        mode: 'compaction',
        provider: {} as BaseProvider,
        llmMessages: [],
        systemPrompt: 'COMPACTOR',
        messagesToCompress: [],
        coveredIndices: covered,
        keepFromIndex: -1,
        keepMessages: [],
      } as unknown as CompressionPlan;
    },
    completeCompression: async (
      _plan: unknown,
      o?: { cancelToken?: CancellationToken },
    ) => {
      stub.completeCalls += 1;
      if (opts.cancelDuringCompression) o?.cancelToken?.cancel();
      if (opts.failComplete) throw new Error('compression failed');
      return {
        content: '## Objective\nцель\n\n## Work State\n- готово',
        response: {
          content: 's',
          model: 'm',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      };
    },
  };
  return stub as unknown as StubOptimizer;
}

/** Провайдер-заглушка (нужны только имя/модель). */
function makeProvider(): BaseProvider {
  return {
    model: 'test-model',
    name: 'test-provider',
    getProviderName: () => 'test-provider',
  } as unknown as BaseProvider;
}

/**
 * Сохранение резюме — как настоящий шов (`createCompressionSummarySaver`):
 * SUMMARY-сообщение пишется в историю ребёнка.
 */
function makeSaveSummary(): TaskExtra['saveSummary'] {
  return async (input) => {
    await sessionManager.addMessage(input.session.id, {
      id: generateId(),
      role: MessageRole.SUMMARY,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(input.content)],
      content: input.content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      summaryOf: input.plan.coveredIndices,
      model: input.response.model,
      usage: input.response.usage,
      metadata: { type: 'auto_summary', mode: input.plan.mode },
    });
  };
}

async function makeChild(): Promise<Session> {
  const parent = await sessionManager.createSession({ title: 'P' });
  const child = await sessionManager.createSession({
    title: 'C',
    parentId: parent.id,
    sessionOrigin: 'subagent',
  });
  await sessionManager.addMessage(child.id, makeMsg('старый вопрос'));
  await sessionManager.addMessage(child.id, makeMsg('старый ответ', MessageRole.ASSISTANT));
  await sessionManager.addMessage(child.id, makeMsg('текущий вопрос'));
  return (await sessionManager.getSession(child.id))!;
}

function makeExtra(over: Partial<TaskExtra> = {}): TaskExtra {
  return {
    sessionManager,
    eventBus: new EventBus(),
    contextOptimizer: makeStubOptimizer(),
    saveSummary: makeSaveSummary(),
    ...over,
  } as unknown as TaskExtra;
}

function makeCancelToken(): CancellationToken {
  const token: CancellationToken = { cancelled: false, cancel: () => { token.cancelled = true; } };
  return token;
}

describe('ADR-119: авто-компактификация дочерней сессии саб-агента', () => {
  it('сжатие срабатывает и контекст пересобирается (чекпоинт + живой хвост)', async () => {
    const child = await makeChild();
    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1] });
    const eventBus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe(child.id, (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));

    const rebuilt = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer, eventBus }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });

    expect(rebuilt).not.toBeNull();
    expect(optimizer.prepareCalls).toBe(1);
    expect(optimizer.completeCalls).toBe(1);
    // Первое сообщение запроса — user-чекпоинт.
    expect(rebuilt![0]!.role).toBe('user');
    expect(rebuilt![0]!.content).toContain('[CONTEXT CHECKPOINT]');
    // Покрытый прошлый ход в запросе отсутствует, живой хвост — на месте.
    expect(rebuilt!.some((m) => m.content === 'старый вопрос')).toBe(false);
    expect(rebuilt!.some((m) => m.content === 'текущий вопрос')).toBe(true);

    // Событие сжатия помечено фазой `mid_turn` (аддитивное поле).
    const applied = events.filter((e) => e.type === 'context.summarization_applied');
    expect(applied.length).toBe(1);
    expect(applied[0]!.data.phase).toBe('mid_turn');
    expect(applied[0]!.data.reason).toBe('auto');

    // Покрытые сообщения ребёнка отключены, резюме — в истории.
    const stored = (await sessionManager.getSession(child.id))!;
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages.some((m) => m.role === MessageRole.SUMMARY)).toBe(true);
  });

  it('потолок сжатий за прогон соблюдается (третье сжатие не запускается)', async () => {
    const child = await makeChild();
    const optimizer = makeStubOptimizer();

    const rebuilt = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: MAX_SUBAGENT_MID_TURN_COMPRESSIONS,
    });

    expect(rebuilt).toBeNull();
    expect(optimizer.prepareCalls).toBe(0);
    expect(optimizer.completeCalls).toBe(0);
  });

  it('без зависимостей сжатие пропускается (fail-open)', async () => {
    const child = await makeChild();
    const optimizer = makeStubOptimizer();

    // Нет сохранения резюме.
    const withoutSaver = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer, saveSummary: undefined }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });
    expect(withoutSaver).toBeNull();

    // Нет оптимизатора.
    const withoutOptimizer = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: undefined }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });
    expect(withoutOptimizer).toBeNull();

    // Нет дочерней сессии.
    const withoutChild = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer }),
      childSessionId: undefined,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });
    expect(withoutChild).toBeNull();

    expect(optimizer.prepareCalls).toBe(0);
  });

  it('без триггера и при cooldown сжатие не запускается', async () => {
    const child = await makeChild();
    const noTrigger = makeStubOptimizer({ noTrigger: true });
    const cooling = makeStubOptimizer({ coolingDown: true });

    const first = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: noTrigger }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });
    expect(first).toBeNull();
    expect(noTrigger.prepareCalls).toBe(0);

    const second = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: cooling }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });
    expect(second).toBeNull();
    expect(cooling.prepareCalls).toBe(0);
  });

  it('сбой сжатия ставит cooldown (авто-триггер не зовёт LLM по кругу)', async () => {
    const child = await makeChild();
    const optimizer = makeStubOptimizer({ failComplete: true });
    const eventBus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe(child.id, (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));

    const rebuilt = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer, eventBus }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });

    expect(rebuilt).toBeNull();
    expect(optimizer.prepareCalls).toBe(1);
    expect(optimizer.noteFailureCalls).toBe(1);

    // Провал виден пользователю: событие в канале child-сессии (ADR-128).
    const failed = events.filter((e) => e.type === 'context.summarization_failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.data.phase).toBe('mid_turn');
    expect(failed[0]!.data.reason).toBe('error');
    expect(String(failed[0]!.data.message)).toContain('compression failed');
  });

  it('отмена во время сжатия не оставляет cooldown', async () => {
    const child = await makeChild();
    const optimizer = makeStubOptimizer({ cancelDuringCompression: true, failComplete: true });

    const rebuilt = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });

    expect(rebuilt).toBeNull();
    expect(optimizer.prepareCalls).toBe(1);
    // Отмена — не провал сжатия: cooldown не выставляется.
    expect(optimizer.noteFailureCalls).toBe(0);
  });

  it('прогресс-гард: порог не снят → cooldown, но пересобранный контекст возвращается', async () => {
    const child = await makeChild();
    const optimizer = makeStubOptimizer({ stillTriggeredAfter: true });

    const rebuilt = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });

    expect(rebuilt).not.toBeNull();
    expect(rebuilt![0]!.content).toContain('[CONTEXT CHECKPOINT]');
    // Cooldown выставлен (прогресс-гард): и сам `forceCompression`, и хелпер
    // отмечают провал — отметка идемпотентна.
    expect(optimizer.noteFailureCalls).toBeGreaterThanOrEqual(1);
  });

  it('пары tool-вызовов хвоста не рвутся (пересборка валидна)', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({
      title: 'C',
      parentId: parent.id,
      sessionOrigin: 'subagent',
    });
    await sessionManager.addMessage(child.id, makeMsg('старый вопрос'));
    await sessionManager.addMessage(child.id, makeMsg('старый ответ', MessageRole.ASSISTANT));
    // Шаг с вызовом инструмента и его результат — в хвосте.
    await sessionManager.addMessage(child.id, {
      ...makeMsg('', MessageRole.ASSISTANT),
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    });
    await sessionManager.addMessage(child.id, {
      ...makeMsg('noop ok', MessageRole.TOOL),
      toolCallId: 'call_1',
    });

    const optimizer = makeStubOptimizer({ coveredIndices: [0, 1] });
    const rebuilt = await tryCompactChildSession({
      extra: makeExtra({ contextOptimizer: optimizer }),
      childSessionId: child.id,
      subagentType: 'explore',
      provider: makeProvider(),
      cancelToken: makeCancelToken(),
      attempts: 0,
    });

    expect(rebuilt).not.toBeNull();
    const messages: LLMMessage[] = rebuilt!;
    expect(messages.some((m) => m.role === 'assistant' && m.toolUse?.length)).toBe(true);
    expect(messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_1')).toBe(true);
  });
});
