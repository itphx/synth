/**
 * ADR-095 (шаг 6a): собственные тесты суммаризации контекста (ADR-070 §2.6).
 *
 * Контракты:
 *  - нет оптимизатора → `internal`-ошибка без побочных эффектов;
 *  - ошибка подготовки суммаризации → `summarization_prep_failed`;
 *  - успешный прогон: `turn.started` → `step.started` → `part.delta` (текст) /
 *    `part.updated` (рассуждения) → сохранение summary-сообщения (`role=summary`,
 *    `skipEvent` — UI получит его через `step.started`/`part.delta`) → отключение
 *    засуммаризированных сообщений (**кроме pinned**) → `step.finished` →
 *    `turn.finished` → `session.updated`;
 *  - отмена: `stream.cancelled`, без сохранения;
 *  - ошибка стрима → единый путь `handleLlmFailure` с контекстом `summary`;
 *  - cancel-токен всегда убирается из реестра.
 *
 * ADR-118 §4: `stream.chunk`/`stream.done` удалены — дельты текста идут
 * `part.delta` (partId `msg:text:0`), рассуждения — `part.updated`
 * (partId `msg:reasoning:0`), закрытие шага — `step.finished`, хода —
 * `turn.finished`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, LLMChunk, Message, Session, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { DebugCollector } from '../../debug.js';
import { BaseProvider } from '../../providers/base.js';
import type { CancellationToken, LLMMessage, SystemPromptInput } from '../../providers/base.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import { CompressionValidationError } from '../context/optimizer.js';
import { saveAssistantMessage, type SaveAssistantMessageFn } from './persistence.js';
import { handleSummarization, type SummarizationDeps } from './summarization.js';
import { handleLlmFailure as handleLlmFailureReal } from './errors.js';

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

  it('успешный прогон: summary-сообщение, отключение индексов, step.finished, session.updated', async () => {
    SummaryProvider.chunks = [
      { content: 'часть ', isFinal: false, model: 'summary-model' },
      { content: 'и середина', isFinal: false, model: 'summary-model' },
      { content: 'итог всей истории диалога', isFinal: true, usage: USAGE, model: 'summary-model', reasoning: 'размышление' },
    ];
    const sessionId = await makeSession([userMessage('a'), userMessage('b', true), userMessage('c')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({});

    // ADR-118 §4: текст шага — дельтами (финальный чанк текста не несёт).
    const deltas = published.filter((p) => p.event === 'part.delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.data).toMatchObject({ partId: 'msg:text:0', field: 'text', delta: 'часть ' });
    expect(deltas[1]!.data).toMatchObject({ partId: 'msg:text:0', field: 'text', delta: 'и середина' });
    const updated = published.filter((p) => p.event === 'part.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.data).toMatchObject({
      partId: 'msg:reasoning:0',
      part: { id: 'msg:reasoning:0', type: 'reasoning', data: 'размышление' },
    });

    // Summary-сообщение сохранено (skipEvent: UI получит его через step.started/part.delta).
    // Финальный чанк несёт полный текст и заменяет накопленное (контракт провайдеров).
    const stored = (await sessionManager.getSession(sessionId))!;
    const summary = stored.messages.find((m) => m.role === MessageRole.SUMMARY)!;
    expect(summary).toMatchObject({
      content: 'итог всей истории диалога',
      agentRole: 'summary',
      reasoning: 'размышление',
      summaryOf: [0, 1],
      metadata: { status: 'completed', type: 'auto_summary', mode: 'summarization' },
    });
    expect(events.filter((e) => e.type === 'message.added')).toHaveLength(0);

    // Засуммаризированные (indices [0,1]) отключены, pinned — нет; сообщения
    // вне indices не трогаются
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[0]!.metadata?.compactedBy).toBe('summarization');
    expect(stored.messages[1]!.disabled).toBe(false);
    expect(stored.messages[2]!.disabled).toBe(false);

    const turnId = 'turn_stream1';
    expect(published.find((p) => p.event === 'step.started')!.data).toMatchObject({
      turnId,
      stepIndex: 0,
      messageId: summary.id,
    });
    const finished = published.find((p) => p.event === 'step.finished')!;
    expect(finished.data).toMatchObject({
      turnId,
      stepIndex: 0,
      messageId: summary.id,
      status: 'completed',
      model: 'summary-model',
      provider: 'summary-provider',
      usage: USAGE,
      agentRole: 'summary',
    });
    expect(published.find((p) => p.event === 'turn.finished')!.data).toMatchObject({
      turnId,
      status: 'completed',
    });

    expect(events.find((e) => e.type === 'session.updated')).toMatchObject({
      data: { session_id: sessionId, summarization_pending: false, can_summarize: true },
    });
  });

  it('стоимость добавляется в step.finished только при известных ценах', async () => {
    SummaryProvider.chunks = [{ content: 'итог всей истории диалога', isFinal: true, usage: USAGE, model: 'summary-model' }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const withoutCost = makeDeps();
    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, withoutCost,
    );
    expect(published.find((p) => p.event === 'step.finished')!.data.costUsd).toBeUndefined();

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
    expect(published.find((p) => p.event === 'step.finished')!.data).toMatchObject({ costUsd: 0.5, costCurrency: 'USD' });
  });

  it('отмена на середине стрима: stream.cancelled без сохранения и без step.finished c контентом', async () => {
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
    expect(published.map((p) => p.event)).toEqual([
      'turn.started',
      'step.started',
      'part.delta',
      'stream.cancelled',
      'step.finished',
      'turn.finished',
    ]);
    const cancelled = published.find((p) => p.event === 'stream.cancelled')!;
    expect(cancelled.data).toMatchObject({
      stream_id: 'stream1',
      content: 'часть ',
      status: 'cancelled',
    });
    expect(published.find((p) => p.event === 'step.finished')!.data).toMatchObject({
      turnId: 'turn_stream1',
      stepIndex: 0,
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
    SummaryProvider.chunks = [{ content: 'итог всей истории диалога', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({ optimizer: makeOptimizer({ canSummarize: false }) });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect((await sessionManager.getSession(sessionId))!.canSummarize).toBe(false);
    expect(events.find((e) => e.type === 'session.updated')!.data.can_summarize).toBe(false);
  });

  it('тайминги шага в step.finished считаются по фактическим чанкам', async () => {
    SummaryProvider.chunks = [{ content: 'итог всей истории диалога', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, makeDeps(),
    );

    // ADR-118 §4: счётчик чанков шага едет в `step.finished.timings`.
    const timings = published.find((p) => p.event === 'step.finished')!.data.timings as { chunks: number };
    expect(timings.chunks).toBe(1);
  });

  it('keepFrom: покрыт только префикс, хвост остаётся живым, metadata.mode/keepFrom', async () => {
    const content = '## Objective\nсделать\n\n## Work State\n- готово';
    SummaryProvider.chunks = [{ content, isFinal: true, usage: USAGE, model: 'summary-model' }];
    const sessionId = await makeSession([userMessage('a'), userMessage('b'), userMessage('c')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [session.messages[0]!],
          coveredIndices: [0],
          keepFromIndex: 1,
          keepFromId: session.messages[1]!.id,
          keepMessages: [session.messages[1]!, session.messages[2]!],
        }),
        canSummarize: () => true,
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({});
    const stored = (await sessionManager.getSession(sessionId))!;
    const summary = stored.messages.find((m) => m.role === MessageRole.SUMMARY)!;
    expect(summary.metadata).toMatchObject({
      type: 'auto_summary',
      mode: 'compaction',
      keepFrom: session.messages[1]!.id,
    });
    expect(summary.summaryOf).toEqual([0]);
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[0]!.metadata?.compactedBy).toBe('compaction');
    expect(stored.messages[1]!.disabled).toBe(false);
    expect(stored.messages[2]!.disabled).toBe(false);

    const applied = events.filter((e) => e.type === 'context.summarization_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.data).toMatchObject({
      session_id: sessionId,
      reason: 'auto',
      mode: 'compaction',
      covered_indices: [0],
      keep_from: session.messages[1]!.id,
    });
    expect(published.some((p) => p.event === 'stream.done')).toBe(false);
  });

  it('m7: nudge-повтор публикует part.updated с финальным текстом (лента = история)', async () => {
    SummaryProvider.chunks = [{ content: 'итог', isFinal: true, usage: USAGE, model: 'summary-model' }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const finalText = 'итог всей истории диалога и подробности';
    const completeCompression = vi.fn(async () => ({
      content: finalText,
      response: { content: finalText, model: 'summary-model', usage: USAGE },
    }));
    const deps = makeDeps({
      optimizer: {
        prepareCompression: () => ({
          mode: 'summarization',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'SUMMARIZER',
          messagesToCompress: [],
          coveredIndices: [0],
          keepFromIndex: -1,
          keepMessages: [],
        }),
        completeCompression,
        canSummarize: () => true,
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({});
    const updatedPart = published.find(
      (p) => p.event === 'part.updated' && p.data.partId === 'msg:text:0',
    );
    expect(updatedPart).toBeDefined();
    expect((updatedPart!.data.part as { data?: string }).data).toBe(finalText);
    expect(published.filter((p) => p.event === 'step.finished')).toHaveLength(1);
    expect(published.filter((p) => p.event === 'turn.finished')).toHaveLength(1);
    const summary = (await sessionManager.getSession(sessionId))!.messages.find(
      (m) => m.role === MessageRole.SUMMARY,
    )!;
    expect(summary.content).toBe(finalText);

    // m7: nudge не дублирует событие применения сжатия.
    const applied = events.filter((e) => e.type === 'context.summarization_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.data).toMatchObject({ mode: 'summarization', covered_indices: [0] });
  });

  it('summarizerPrompt уходит в провайдера (не в system prompt основного агента)', async () => {
    SummaryProvider.chunks = [{ content: 'итог всей истории диалога', isFinal: true, usage: USAGE }];
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

  it('невалидный ответ сжатия: без ретраев (validation) + cooldown, повтор без nudge', async () => {
    SummaryProvider.chunks = [{ content: 'совсем не шаблон', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const completeCompression = vi.fn(async () => {
      throw new CompressionValidationError('Compression response does not match the required template');
    });
    const noteCompressionFailure = vi.fn();
    const deps = makeDeps({
      // Настоящий `handleLlmFailure` — проверяем решение о ретрае, а не мок.
      handleLlmFailure: ((
        sid: string, streamId: string, error: unknown, attempt: number | undefined, ctx: never,
      ) => handleLlmFailureReal(sid, streamId, error, attempt, ctx, { sessionManager })) as never,
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [],
          coveredIndices: [0],
          keepFromIndex: -1,
          keepMessages: [],
        }),
        completeCompression,
        canSummarize: () => true,
        shouldCompress: () => ({ triggered: false, reason: 'none', mode: 'compaction' }),
        noteCompressionFailure,
        clearCompressionFailure: vi.fn(),
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    // `validation` — невосстановимый тип: очередь не ретраит служебное сообщение.
    expect(result).toMatchObject({ errorType: 'validation', canRetry: false });
    // Ровно один непотоковый вызов и **без** внутреннего nudge.
    expect(completeCompression).toHaveBeenCalledTimes(1);
    expect(completeCompression).toHaveBeenCalledWith(expect.anything(), { nudge: false });
    // Cooldown включён — авто-триггер больше не зовёт LLM по кругу.
    expect(noteCompressionFailure).toHaveBeenCalledWith(sessionId);
    // Summary не сохранён.
    expect((await sessionManager.getSession(sessionId))!.messages.some((m) => m.role === MessageRole.SUMMARY)).toBe(false);
  });

  it('сетевая ошибка повторного вызова: обычная классификация, без cooldown', async () => {
    SummaryProvider.chunks = [{ content: 'совсем не шаблон', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const completeCompression = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const noteCompressionFailure = vi.fn();
    const deps = makeDeps({
      handleLlmFailure: ((
        sid: string, streamId: string, error: unknown, attempt: number | undefined, ctx: never,
      ) => handleLlmFailureReal(sid, streamId, error, attempt, ctx, { sessionManager })) as never,
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [],
          coveredIndices: [0],
          keepFromIndex: -1,
          keepMessages: [],
        }),
        completeCompression,
        canSummarize: () => true,
        shouldCompress: () => ({ triggered: false, reason: 'none', mode: 'compaction' }),
        noteCompressionFailure,
        clearCompressionFailure: vi.fn(),
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    // Сетевая ошибка — не «провал валидации»: errorType не задан, ретрай
    // разрешён по обычной классификации.
    expect(result).toMatchObject({ errorType: 'network_error', canRetry: true });
    expect(result.errorType).not.toBe('validation');
    // Cooldown не включаем: сжатие «не помогло» — не факт.
    expect(noteCompressionFailure).not.toHaveBeenCalled();
  });

  it('прогресс-гард игнорирует активный cooldown (shouldCompress с ignoreCooldown)', async () => {
    SummaryProvider.chunks = [{ content: '## Objective\nчего добиваемся\n\n## Work State\n- готово', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a'), userMessage('b')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const shouldCompress = vi.fn((_s: Session, opts?: { ignoreCooldown?: boolean }) => ({
      triggered: true,
      reason: 'tokens' as const,
      mode: 'compaction' as const,
      ...(opts?.ignoreCooldown ? { ignoreCooldown: true } : {}),
    }));
    const noteCompressionFailure = vi.fn();
    const deps = makeDeps({
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [session.messages[0]!],
          coveredIndices: [0],
          keepFromIndex: 1,
          keepMessages: [session.messages[1]!],
        }),
        canSummarize: () => true,
        shouldCompress,
        noteCompressionFailure,
        clearCompressionFailure: vi.fn(),
      } as unknown as ContextOptimizer,
    });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    // Прогресс-гард зовёт shouldCompress с ignoreCooldown — активный cooldown
    // не должен маскировать «сжатие не помогло».
    expect(shouldCompress).toHaveBeenCalledWith(expect.anything(), { ignoreCooldown: true });
    const applied = events.filter((e) => e.type === 'context.summarization_applied');
    expect(applied[0]!.data).toMatchObject({ insufficient: true });
    expect(noteCompressionFailure).toHaveBeenCalledWith(sessionId);
  });

  it('прогресс-гард: сжатие не сняло порог → insufficient в событии + cooldown', async () => {
    SummaryProvider.chunks = [{ content: '## Objective\nчего добиваемся\n\n## Work State\n- готово', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a'), userMessage('b')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const noteCompressionFailure = vi.fn();
    const clearCompressionFailure = vi.fn();
    const deps = makeDeps({
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [session.messages[0]!],
          coveredIndices: [0],
          keepFromIndex: 1,
          keepMessages: [session.messages[1]!],
        }),
        canSummarize: () => true,
        // Порог после сжатия всё ещё превышен.
        shouldCompress: () => ({ triggered: true, reason: 'tokens', mode: 'compaction' }),
        noteCompressionFailure,
        clearCompressionFailure,
      } as unknown as ContextOptimizer,
    });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    const applied = events.filter((e) => e.type === 'context.summarization_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.data).toMatchObject({ insufficient: true });
    expect(noteCompressionFailure).toHaveBeenCalledWith(sessionId);
    expect(clearCompressionFailure).not.toHaveBeenCalled();
  });

  /**
   * ADR-128: модель ответила содержательным резюме в **своём** формате
   * (без заголовков шаблона) — деградированный режим: сжатие применяется,
   * SUMMARY сохраняется, повторного вызова не было.
   */
  it('degraded: свободный текст 200+ символов — SUMMARY сохранён, сжатие применено', async () => {
    const freeform = 'Свободное резюме без заголовков шаблона. '.repeat(8);
    SummaryProvider.chunks = [{ content: freeform, isFinal: true, usage: USAGE, model: 'summary-model' }];
    const sessionId = await makeSession([userMessage('a'), userMessage('b')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const completeCompression = vi.fn(async () => {
      throw new Error('повтор не должен вызываться');
    });
    const deps = makeDeps({
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [session.messages[0]!],
          coveredIndices: [0],
          keepFromIndex: 1,
          keepMessages: [session.messages[1]!],
        }),
        completeCompression,
        canSummarize: () => true,
        shouldCompress: () => ({ triggered: false, reason: 'none', mode: 'compaction' }),
        noteCompressionFailure: vi.fn(),
        clearCompressionFailure: vi.fn(),
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toEqual({});
    // Содержательное резюме принято — повторный вызов не потребовался.
    expect(completeCompression).not.toHaveBeenCalled();
    const stored = (await sessionManager.getSession(sessionId))!;
    const summary = stored.messages.find((m) => m.role === MessageRole.SUMMARY)!;
    expect(summary).toBeDefined();
    expect(summary.content).toBe(freeform);
    expect(stored.messages[0]!.disabled).toBe(true);

    const applied = events.filter((e) => e.type === 'context.summarization_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.data).toMatchObject({ mode: 'compaction', covered_indices: [0] });
    // Провала нет — событие о провале не публикуется.
    expect(events.filter((e) => e.type === 'context.summarization_failed')).toHaveLength(0);
  });

  it('провал валидации: публикуется context.summarization_failed (reason: validation)', async () => {
    SummaryProvider.chunks = [{ content: 'совсем не шаблон', isFinal: true, usage: USAGE }];
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const completeCompression = vi.fn(async () => {
      throw new CompressionValidationError('Compression response does not match the required template');
    });
    const deps = makeDeps({
      handleLlmFailure: ((
        sid: string, streamId: string, error: unknown, attempt: number | undefined, ctx: never,
      ) => handleLlmFailureReal(sid, streamId, error, attempt, ctx, { sessionManager })) as never,
      optimizer: {
        prepareCompression: () => ({
          mode: 'compaction',
          provider: new SummaryProvider({ url: '', apiKey: '', model: 'm', type: 'summary-provider' }),
          llmMessages: [] as LLMMessage[],
          systemPrompt: 'COMPACTOR',
          messagesToCompress: [],
          coveredIndices: [0],
          keepFromIndex: -1,
          keepMessages: [],
        }),
        completeCompression,
        canSummarize: () => true,
        shouldCompress: () => ({ triggered: false, reason: 'none', mode: 'compaction' }),
        noteCompressionFailure: vi.fn(),
        clearCompressionFailure: vi.fn(),
      } as unknown as ContextOptimizer,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    expect(result).toMatchObject({ errorType: 'validation', canRetry: false });
    const failed = events.filter((e) => e.type === 'context.summarization_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({
      session_id: sessionId,
      reason: 'validation',
      mode: 'compaction',
    });
    expect(String(failed[0]!.data.message)).not.toBe('');
  });

  it('ошибка стрима: публикуется context.summarization_failed (reason: error)', async () => {
    SummaryProvider.chunks = [{ content: 'частично', isFinal: false }];
    SummaryProvider.error = new Error('fetch failed');
    const sessionId = await makeSession([userMessage('a')]);
    const session = (await sessionManager.getSession(sessionId))!;

    const deps = makeDeps({
      handleLlmFailure: ((
        sid: string, streamId: string, error: unknown, attempt: number | undefined, ctx: never,
      ) => handleLlmFailureReal(sid, streamId, error, attempt, ctx, { sessionManager })) as never,
    });

    const result = await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', 2, deps,
    );

    expect(result).toMatchObject({ errorType: 'network_error' });
    const failed = events.filter((e) => e.type === 'context.summarization_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({
      session_id: sessionId,
      reason: 'error',
      mode: 'summarization',
    });
  });
});
