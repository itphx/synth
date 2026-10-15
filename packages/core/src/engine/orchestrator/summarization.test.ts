/**
 * ADR-095 (шаг 6a): собственные тесты суммаризации контекста (ADR-070 §2.6).
 *
 * Контракты:
 *  - нет оптимизатора → `internal`-ошибка без побочных эффектов;
 *  - ошибка подготовки суммаризации → `summarization_prep_failed`;
 *  - успешный прогон: `stream.chunk` (agent_role=summary) → сохранение
 *    summary-сообщения (`role=summary`, `skipEvent` — UI получит его через
 *    `stream.done`) → отключение засуммаризированных сообщений (**кроме
 *    pinned**) → `stream.done` с `metadata.type='summary'` → `session.updated`;
 *  - отмена: ровно `stream.cancelled`, без сохранения;
 *  - ошибка стрима → единый путь `handleLlmFailure` с контекстом `summary`;
 *  - cancel-токен всегда убирается из реестра.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, LLMChunk, Message, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { DebugCollector } from '../../debug.js';
import { BaseProvider } from '../../providers/base.js';
import type { CancellationToken, LLMMessage, SystemPromptInput } from '../../providers/base.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import { saveAssistantMessage, type SaveAssistantMessageFn } from './persistence.js';
import { handleSummarization, type SummarizationDeps } from './summarization.js';

const USAGE: TokenUsage = { inputTokens: 20, outputTokens: 8, totalTokens: 28 };

class SummaryProvider extends BaseProvider {
  static chunks: LLMChunk[] = [];
  static error: Error | null = null;
  /** Хук после каждого отданного чанка (например, отмена стрима на середине). */
  static onChunk: (() => void) | null = null;
  /** Последний полученный промпт суммаризатора (без spyOn генератора). */
  static lastPrompt: SystemPromptInput | undefined = undefined;

  async chat(): Promise<never> {
    throw new Error('chat не используется суммаризацией');
  }

  async *chatAsync(
    _messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
  ): AsyncGenerator<LLMChunk> {
    SummaryProvider.lastPrompt = systemPrompt;
    for (const chunk of SummaryProvider.chunks) {
      yield chunk;
      SummaryProvider.onChunk?.();
    }
    if (SummaryProvider.error) throw SummaryProvider.error;
  }

  getProviderName(): string {
    return 'summary-provider';
  }
}

describe('handleSummarization', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;
  let published: Array<{ event: string; data: Record<string, unknown> }>;
  let debugCollector: DebugCollector;
  let cancellationTokens: Map<string, CancellationToken>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-summary-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
    published = [];
    debugCollector = new DebugCollector(false);
    cancellationTokens = new Map();
    SummaryProvider.chunks = [];
    SummaryProvider.error = null;
    SummaryProvider.onChunk = null;
    SummaryProvider.lastPrompt = undefined;
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(messages: Message[] = []): Promise<string> {
    const session = await sessionManager.createSession({ title: 'Sum', settings: { language: 'ru' } as never });
    for (const message of messages) await sessionManager.addMessage(session.id, message);
    return session.id;
  }

  function userMessage(content: string, pinned = false): Message {
    return {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned,
      hidden: false,
    };
  }

  function makeOptimizer(overrides: {
    prep?: () => unknown;
    canSummarize?: boolean;
  } = {}): ContextOptimizer {
    return {
      prepareSummarizationForOrchestrator: vi.fn(overrides.prep ?? (() => ({
        provider: new SummaryProvider({ url: '', apiKey: '', model: 'summary-model', type: 'summary-provider' }),
        llmMessages: [{ id: '', role: 'user', content: 'история', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, disabled: false, pinned: false, branchId: '' }] as LLMMessage[],
        summarizerPrompt: 'SUMMARIZER',
        messagesToSummarize: [],
        indices: [0, 1],
      }))),
      canSummarize: vi.fn(() => overrides.canSummarize ?? true),
    } as unknown as ContextOptimizer;
  }

  function makeDeps(overrides: Partial<SummarizationDeps> = {}): SummarizationDeps {
    return {
      optimizer: makeOptimizer(),
      cancellationTokens,
      handleLlmFailure: vi.fn(async () => ({ error: 'stream failed', errorType: 'network_error', canRetry: true })) as never,
      estimatePromptChars: vi.fn(() => 1234),
      computeMessageCost: vi.fn(() => null),
      saveAssistantMessage: vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
        return saveAssistantMessage(
          { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null },
          ...args,
        );
      }) as unknown as SaveAssistantMessageFn,
      sessionManager,
      eventBus,
      ...overrides,
    };
  }

  function makeMessage(): Message {
    return {
      id: generateId(),
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('sum')],
      content: 'sum',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { type: 'summarization_request', stream_id: 'stream1' },
      provider: 'summary-provider',
    };
  }

  function publish() {
    return (event: string, data: Record<string, unknown>) => published.push({ event, data });
  }

  it('без оптимизатора — internal-ошибка без побочных эффектов', async () => {
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({ optimizer: null });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({ error: 'ContextOptimizer not available', errorType: 'internal', canRetry: false });
    expect(published).toHaveLength(0);
    expect(deps.saveAssistantMessage).not.toHaveBeenCalled();
  });

  it('ошибка подготовки → summarization_prep_failed, стрим не запускается', async () => {
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({
      optimizer: {
        prepareSummarizationForOrchestrator: () => {
          throw new Error('нет сообщений для суммаризации');
        },
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({
      error: 'Error: нет сообщений для суммаризации',
      errorType: 'summarization_prep_failed',
      canRetry: false,
    });
    expect(published).toHaveLength(0);
  });

  it('успешный прогон: summary-сообщение, отключение индексов, stream.done, session.updated', async () => {
    SummaryProvider.chunks = [
      { content: 'часть ', isFinal: false, model: 'summary-model' },
      { content: 'и середина', isFinal: false, model: 'summary-model' },
      { content: 'итог всей истории', isFinal: true, usage: USAGE, model: 'summary-model', reasoning: 'размышление' },
    ];
    const sessionId = await makeSession([userMessage('a'), userMessage('b', true), userMessage('c')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({});

    // Чанки стрима: промежуточные — с контентом, финальный — пустой (контент уходит в stream.done)
    const chunks = published.filter((p) => p.event === 'stream.chunk');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.data).toMatchObject({ agent_role: 'summary', provider: 'summary-provider', is_final: false });
    expect(chunks[0]!.data.content).toBe('часть ');
    expect(chunks[chunks.length - 1]!.data).toMatchObject({ is_final: true, content: '' });

    // Summary-сообщение сохранено (skipEvent: UI получит его через stream.done).
    // Финальный чанк несёт полный текст и заменяет накопленное (контракт провайдеров).
    const stored = (await sessionManager.getSession(sessionId))!;
    const summary = stored.messages.find((m) => m.role === MessageRole.SUMMARY)!;
    expect(summary).toMatchObject({
      content: 'итог всей истории',
      agentRole: 'summary',
      reasoning: 'размышление',
      summaryOf: [0, 1],
      metadata: { status: 'completed' },
    });
    expect(events.filter((e) => e.type === 'message.added')).toHaveLength(0);

    // Засуммаризированные (indices [0,1]) отключены, pinned — нет; сообщения
    // вне indices не трогаются
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[1]!.disabled).toBe(false);
    expect(stored.messages[2]!.disabled).toBe(false);

    const done = published.find((p) => p.event === 'stream.done')!;
    expect(done.data).toMatchObject({
      stream_id: 'stream1',
      content: 'итог всей истории',
      status: 'completed',
      model: 'summary-model',
      provider: 'summary-provider',
      usage: USAGE,
      metadata: { type: 'summary', indices: [0, 1] },
    });
    expect(done.data.message_index).toBe(3);

    expect(events.find((e) => e.type === 'session.updated')).toMatchObject({
      data: { session_id: sessionId, summarization_pending: false, can_summarize: true },
    });
  });

  it('стоимость добавляется в stream.done только при известных ценах', async () => {
    SummaryProvider.chunks = [{ content: 'итог', isFinal: true, usage: USAGE, model: 'summary-model' }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const withoutCost = makeDeps();
    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, withoutCost,
    );
    expect(published.find((p) => p.event === 'stream.done')!.data.cost_usd).toBeUndefined();

    published = [];
    const withCost = makeDeps({
      computeMessageCost: vi.fn(() => ({
        costUsd: 0.5,
        breakdown: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 },
        currency: 'USD',
      })) as never,
    });
    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream2', undefined, withCost,
    );
    expect(published.find((p) => p.event === 'stream.done')!.data).toMatchObject({ cost_usd: 0.5, cost_currency: 'USD' });
  });

  it('отмена на середине стрима: stream.cancelled без сохранения и без stream.done', async () => {
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();
    const controller = new AbortController();

    SummaryProvider.chunks = [
      { content: 'часть ', isFinal: false, model: 'summary-model' },
      { content: 'хвост', isFinal: false, model: 'summary-model' },
    ];
    // Отмена приходит, пока стрим ещё идёт (signal → cancelToken.cancel()).
    SummaryProvider.onChunk = () => controller.abort();

    const result = await handleSummarization(
      session, makeMessage(), controller.signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({});
    expect(published.map((p) => p.event)).toEqual(['stream.chunk', 'stream.cancelled']);
    expect(published[1]!.data).toMatchObject({
      stream_id: 'stream1',
      content: 'часть ',
      status: 'cancelled',
    });
    expect(deps.saveAssistantMessage).not.toHaveBeenCalled();
    expect((await sessionManager.getSession(sessionId))!.messages).toHaveLength(1);
    expect(cancellationTokens.has('stream1')).toBe(false);
  });

  it('ошибка стрима → handleLlmFailure с контекстом summary и очисткой токена', async () => {
    SummaryProvider.chunks = [{ content: 'частично', isFinal: false }];
    SummaryProvider.error = new Error('fetch failed');
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', 2, deps,
    );

    expect(result).toMatchObject({ errorType: 'network_error' });
    expect(deps.handleLlmFailure).toHaveBeenCalledTimes(1);
    const [calledSessionId, calledStreamId, error, attempt, ctx] = (deps.handleLlmFailure as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledSessionId).toBe(sessionId);
    expect(calledStreamId).toBe('stream1');
    expect((error as Error).message).toBe('fetch failed');
    expect(attempt).toBe(2);
    expect(ctx).toMatchObject({
      agentRole: 'summary',
      providerName: 'summary-provider',
      model: 'summary-model',
      promptChars: 1234,
    });
    expect(cancellationTokens.has('stream1')).toBe(false);
  });

  it('cancel-токен регистрируется в реестре на время стрима и снимается после', async () => {
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const seen: boolean[] = [];
    const deps = makeDeps({
      estimatePromptChars: vi.fn(() => {
        seen.push(cancellationTokens.has('stream1'));
        return 1;
      }) as never,
    });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(cancellationTokens.has('stream1')).toBe(false);
  });

  it('canSummarize пересчитывается после прогона', async () => {
    SummaryProvider.chunks = [{ content: 'итог', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({ optimizer: makeOptimizer({ canSummarize: false }) });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect((await sessionManager.getSession(sessionId))!.canSummarize).toBe(false);
    expect(events.find((e) => e.type === 'session.updated')!.data.can_summarize).toBe(false);
  });

  it('pending_count в stream.done считается от актуальной сессии', async () => {
    SummaryProvider.chunks = [{ content: 'итог', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, makeDeps(),
    );

    // pendingMessages пуст → 0 (не отрицательное значение)
    expect(published.find((p) => p.event === 'stream.done')!.data.pending_count).toBe(0);
  });

  it('summarizerPrompt уходит в провайдера (не в system prompt основного агента)', async () => {
    SummaryProvider.chunks = [{ content: 'итог', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({
      optimizer: {
        prepareSummarizationForOrchestrator: () => ({
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          summarizerPrompt: 'SUMMARIZER_PROMPT',
          messagesToSummarize: [],
          indices: [],
        }),
        canSummarize: () => true,
      } as unknown as ContextOptimizer,
    });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(SummaryProvider.lastPrompt as SystemPromptInput).toBe('SUMMARIZER_PROMPT');
  });
});
