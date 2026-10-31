/**
 * ADR-102 + ADR-118: расход **хода** в статистике (история, счётчики
 * сессии, аналитика).
 *
 * С ADR-118 шаг (итерация) = отдельный вызов LLM. Раньше в финальное
 * сообщение и в счётчики сессии/аналитику попадал только расход последней
 * итерации (`finalUsage`), а расход промежуточных шагов терялся (в живой
 * сессии `Session.inputTokens` совпадал с суммой финальных сообщений, а не
 * с расходом хода).
 *
 * Теперь в финальное/отменённое сообщение идёт `turnUsage` — сумма расходов
 * всех шагов хода, при этом:
 *  - `step.finished` по-прежнему несёт расход **своего** шага (метрики
 *    Prometheus не меняются: сумма по шагам = расход хода);
 *  - запись usage на ход одна (`requests=1`, `messages=1`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { CancellationToken, LLMMessage, SystemPromptInput } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { AnalyticsRecorder } from '../analytics/recorder.js';
import type { AnalyticsRollupBucket, AnalyticsRollupQuery, AnalyticsRollupRow } from '@itphx/synth-shared';
import type { LLMChunk, LLMResponse, Message, TokenUsage } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';

/** Расход шага-инструмента (первый вызов LLM). */
const USAGE_STEP_1: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
/** Расход финального шага (второй вызов LLM). */
const USAGE_STEP_2: TokenUsage = { inputTokens: 20, outputTokens: 8, totalTokens: 28 };
/** Сумма расходов хода (два вызова LLM). */
const USAGE_TURN: TokenUsage = {
  inputTokens: 30,
  outputTokens: 13,
  totalTokens: 43,
};

interface ScriptStep {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
  usage?: TokenUsage;
  /** Отменить ход сразу после выдачи чанка (имитация «Стоп» в стриме). */
  cancelAfterYield?: boolean;
}

/** Провайдер-сценарий: каждый вызов LLM отдаёт свой шаг сценария. */
class TurnUsageProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _call = 0;

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._call = 0;
  }

  static get calls(): number {
    return this._call;
  }

  async chat(): Promise<LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    const idx = Math.min(TurnUsageProvider._call, Math.max(0, TurnUsageProvider._script.length - 1));
    const step = TurnUsageProvider._script[idx] ?? {};
    TurnUsageProvider._call++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      ...(step.usage ? { usage: step.usage } : {}),
      ...(step.toolCalls
        ? {
          toolCalls: step.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          })),
        }
        : {}),
    };
    // Отмена приходит по факту выдачи чанка — без гонки с таймером.
    if (step.cancelAfterYield) cancellationToken?.cancel();
  }

  getProviderName(): string {
    return 'turnusage';
  }
}

/** Порт роллапов аналитики: считает инкременты (по одному на запись usage). */
class CountingRollupRepo {
  readonly buckets: AnalyticsRollupBucket[] = [];

  async increment(bucket: AnalyticsRollupBucket): Promise<void> {
    this.buckets.push(bucket);
  }

  async set(): Promise<void> {
    // не используется
  }

  async query(_query: AnalyticsRollupQuery): Promise<AnalyticsRollupRow[]> {
    return [];
  }

  async prune(): Promise<number> {
    return 0;
  }

  async clear(): Promise<number> {
    this.buckets.length = 0;
    return 0;
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

function makeUserMessage(content = 'сделай задачу'): Message {
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

type Published = { event: string; data: Record<string, unknown> };

describe('ChatOrchestrator — расход хода (сумма шагов) в статистике', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let rollups: CountingRollupRepo;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-turn-usage-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    rollups = new CountingRollupRepo();
    ProviderFactory.register('turnusage', TurnUsageProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('turnusage');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(script: ScriptStep[]): Promise<{
    sessionId: string;
    events: Published[];
  }> {
    TurnUsageProvider.configure(script);

    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'turnusage',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      analytics: new AnalyticsRecorder({ repo: rollups as never }),
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'TurnUsage',
      userId: 'u1',
      settings: { provider: 'turnusage', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const events: Published[] = [];
    await orchestrator.createProcessMessage()(
      fresh,
      msg,
      new AbortController().signal,
      (event, data) => events.push({ event, data }),
    );

    return { sessionId: session.id, events };
  }

  /** Последнее сохранённое assistant-сообщение хода. */
  async function finalAssistant(sessionId: string): Promise<Message> {
    const stored = (await sessionManager.getSession(sessionId))!;
    return stored.messages.filter((m) => m.role === MessageRole.ASSISTANT).at(-1)!;
  }

  /** События закрытия шагов — расход каждого шага. */
  function stepEvents(events: Published[]): Published[] {
    return events.filter((e) => e.event === 'step.finished');
  }

  /** Дождаться фоновой записи роллапа аналитики (`recordUsage` — fire-and-forget). */
  async function waitForRollups(count = 1): Promise<AnalyticsRollupBucket[]> {
    for (let i = 0; i < 100 && rollups.buckets.length < count; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return rollups.buckets;
  }

  it('ход из двух вызовов LLM: usage финального сообщения = сумма шагов', async () => {
    const { sessionId } = await run([
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'read_file' }], usage: USAGE_STEP_1 },
      { content: 'готово', usage: USAGE_STEP_2 },
    ]);

    expect(TurnUsageProvider.calls).toBe(2);
    const assistant = await finalAssistant(sessionId);
    expect(assistant.usage).toEqual(USAGE_TURN);
  });

  it('ход из двух вызовов LLM: счётчики сессии = сумма шагов', async () => {
    const { sessionId } = await run([
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'read_file' }], usage: USAGE_STEP_1 },
      { content: 'готово', usage: USAGE_STEP_2 },
    ]);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.inputTokens).toBe(30);
    expect(session.outputTokens).toBe(13);
    expect(session.totalTokens).toBe(43);
  });

  it('ход из двух вызовов LLM: аналитика — одна запись usage с суммой (requests=1)', async () => {
    const { sessionId } = await run([
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'read_file' }], usage: USAGE_STEP_1 },
      { content: 'готово', usage: USAGE_STEP_2 },
    ]);

    const buckets = await waitForRollups();
    const usageBuckets = buckets.filter((b) => b.family === 'usage');
    expect(usageBuckets).toHaveLength(1);
    expect(usageBuckets[0]!.measures).toMatchObject({
      input_tokens: 30,
      output_tokens: 13,
      requests: 1,
      messages: 1,
    });
    // Стоимость финального сообщения — по расходу хода (не только финала).
    void sessionId;
  });

  it('step.finished несёт расход своего шага (не суммарный)', async () => {
    const { events } = await run([
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'read_file' }], usage: USAGE_STEP_1 },
      { content: 'готово', usage: USAGE_STEP_2 },
    ]);

    const steps = stepEvents(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.data.usage).toEqual(USAGE_STEP_1);
    expect(steps[1]!.data.usage).toEqual(USAGE_STEP_2);
  });

  it('одношаговый ход (без инструментов) — без изменений', async () => {
    const { sessionId, events } = await run([
      { content: 'ответ', usage: USAGE_STEP_1 },
    ]);

    const assistant = await finalAssistant(sessionId);
    expect(assistant.usage).toEqual(USAGE_STEP_1);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.inputTokens).toBe(10);
    expect(session.outputTokens).toBe(5);
    expect(session.totalTokens).toBe(15);

    const steps = stepEvents(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.data.usage).toEqual(USAGE_STEP_1);

    const buckets = await waitForRollups();
    const usageBuckets = buckets.filter((b) => b.family === 'usage');
    expect(usageBuckets).toHaveLength(1);
    expect(usageBuckets[0]!.measures).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      requests: 1,
      messages: 1,
    });
  });

  it('отмена во время второго шага: расход хода не теряется и не удваивается', async () => {
    const { sessionId, events } = await run([
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'read_file' }], usage: USAGE_STEP_1 },
      { content: 'обрыв', usage: USAGE_STEP_2, cancelAfterYield: true },
    ]);

    // Сообщение отмены несёт расход хода (шаг 1 + шаг 2).
    const assistant = await finalAssistant(sessionId);
    expect(assistant.usage).toEqual(USAGE_TURN);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.inputTokens).toBe(30);
    expect(session.outputTokens).toBe(13);
    expect(session.totalTokens).toBe(43);

    // Отмена опубликована, ход закрыт.
    expect(events.some((e) => e.event === 'stream.cancelled')).toBe(true);

    // `step.finished` каждого шага — расход **своего** шага (метрики
    // Prometheus не меняются): сумма по шагам = расход хода.
    const steps = stepEvents(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.data.usage).toEqual(USAGE_STEP_1);
    expect(steps[1]!.data.status).toBe('cancelled');
    expect(steps[1]!.data.usage).toEqual(USAGE_STEP_2);
  });

  it('отмена во втором шаге: аналитика — одна запись с суммой', async () => {
    await run([
      { content: 'шаг 1', toolCalls: [{ id: 'call_1', name: 'read_file' }], usage: USAGE_STEP_1 },
      { content: 'обрыв', usage: USAGE_STEP_2, cancelAfterYield: true },
    ]);

    const buckets = await waitForRollups();
    const usageBuckets = buckets.filter((b) => b.family === 'usage');
    expect(usageBuckets).toHaveLength(1);
    expect(usageBuckets[0]!.measures).toMatchObject({
      input_tokens: 30,
      output_tokens: 13,
      requests: 1,
      messages: 1,
    });
  });
});
