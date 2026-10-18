/**
 * ADR-095 (шаг 6b-1): собственные тесты эпилога `runProcessFinalize`.
 *
 * Контракты (порядок side-effect'ов и отсутствие двойных публикаций):
 *  - отмена до финального сохранения → assistant (status=cancelled) → ровно
 *    одно `stream.cancelled`, **без** `stream.done`; tool-chain уже записан
 *    пошагово в цикле (шаг 2а) — в эпилоге его нет;
 *  - фоллбек-тексты (лимит итераций / deny / пустой ответ) и статус в `stream.done`;
 *  - quality-check/escalation (ADR-034): перевызов на fallback-модели без
 *    assistant-сообщений с toolUse, событие `message.quality_check`;
 *  - secrets в `stream.done`, `unregister` ровно один раз.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, LLMChunk, LLMResponse, Message, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { EventBus } from '../../../events/bus.js';
import { DebugCollector } from '../../../debug.js';
import { BaseProvider } from '../../../providers/base.js';
import type { LLMMessage } from '../../../providers/base.js';
import type { ModelRouter, RoutingDecision } from '../../router/router.js';
import { t as sm } from '../../system-messages.js';
import {
  saveAssistantMessage,
  resolveAssistantStatus,
  joinAccumulatedTexts,
  type SaveAssistantMessageFn,
} from '../persistence.js';
import { resolveMessageModel, estimateUsage } from '../usage.js';
import {
  runProcessFinalize,
  type ProcessFinalizeArgs,
  type ProcessFinalizeDeps,
  type ProcessFinalizeState,
} from './process-finalize.js';

class FakeProvider extends BaseProvider {
  constructor(private readonly _response: LLMResponse | Error = new Error('not used')) {
    super({ url: '', apiKey: '', model: 'm', name: 'fake' });
  }

  async chat(): Promise<LLMResponse> {
    if (this._response instanceof Error) throw this._response;
    return this._response;
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: '', isFinal: true, model: this.model };
  }

  getProviderName(): string {
    return 'fake';
  }
}

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe('runProcessFinalize', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;
  let published: Array<{ event: string; data: Record<string, unknown> }>;
  let order: string[];
  let debugCollector: DebugCollector;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-finalize-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
    published = [];
    order = [];
    debugCollector = new DebugCollector(false);
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(withUserMessage = true): Promise<string> {
    const session = await sessionManager.createSession({ title: 'Fin', settings: { agentRole: 'developer' } as never });
    if (withUserMessage) {
      const message: Message = {
        id: generateId(),
        role: MessageRole.USER,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart('вопрос')],
        content: 'вопрос',
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
      };
      await sessionManager.addMessage(session.id, message);
    }
    return session.id;
  }

  function makeArgs(sessionId: string, overrides: Partial<ProcessFinalizeArgs> = {}): ProcessFinalizeArgs {
    return {
      session: { id: sessionId, settings: {} } as never,
      streamId: 'stream1',
      publishChunk: (event, data) => published.push({ event, data }),
      debugCollector,
      streamStartedAt: Date.now() - 10,
      ...overrides,
    };
  }

  function makeState(overrides: Partial<ProcessFinalizeState> = {}): ProcessFinalizeState {
    return {
      cancelledBeforeFinal: false,
      lastChunkModel: undefined,
      finalModel: 'm',
      finalUsage: { ...USAGE },
      finalContent: 'ответ модели',
      fallbackI18n: undefined,
      hadDeny: false,
      stopAfterDeny: false,
      denyStopReason: undefined,
      toolIteration: 1,
      maxIterations: 10,
      lastIterationPromptChars: 400,
      allReasoning: [],
      allIntermediateTexts: [],
      allToolCalls: [],
      currentMessages: [],
      promptMeta: { agentRole: 'developer', generation: 1, expected: 'miss', cachedTokens: 0, validated: false },
      loadedTokenRatio: undefined,
      routingDecision: undefined,
      provider: new FakeProvider(),
      finalSystemPrompt: { text: 'sys', cacheKey: 'session-cache-key' },
      providerName: 'prov',
      effectiveAgentRole: 'developer',
      effectiveReasoningLevel: undefined,
      ...overrides,
    };
  }

  function makeDeps(overrides: Partial<ProcessFinalizeDeps> = {}): ProcessFinalizeDeps {
    const saveSpy = vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
      order.push('saveAssistantMessage');
      return saveAssistantMessage(
        { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null },
        ...args,
      );
    });

    return {
      sessionManager,
      eventBus,
      router: null,
      agentRegistry: null,
      optimizer: null,
      resolveMessageModel,
      joinAccumulatedTexts,
      estimateUsage,
      computeMessageCost: (model, usage) => {
        if (!model || !usage) return null;
        return { costUsd: 0.25, breakdown: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0 }, currency: 'USD' };
      },
      saveAssistantMessage: saveSpy as unknown as SaveAssistantMessageFn,
      resolveAssistantStatus,
      getAssistantSecrets: vi.fn(async () => ({})) as never,
      calibrateTokenRatio: vi.fn(async () => {}) as never,
      getProvider: vi.fn(() => new FakeProvider()) as never,
      unregister: vi.fn((streamId: string) => {
        order.push(`unregister:${streamId}`);
      }),
      ...overrides,
    };
  }

  describe('ветка отмены', () => {
    it('assistant(status=cancelled) → stream.cancelled, без stream.done', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();
      const state = makeState({ cancelledBeforeFinal: true, finalContent: '' });

      const result = await runProcessFinalize(makeArgs(sessionId), state, deps);

      expect(result).toEqual({});
      expect(order).toEqual(['saveAssistantMessage', 'unregister:stream1']);

      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[1]).toBe('');           // контент отмены
      expect(saveCall[8]).toBe(true);         // isCancelled
      expect(saveCall[17]).toMatchObject({ duration_ms: expect.any(Number) });

      expect(published.map((p) => p.event)).toEqual(['stream.cancelled']);
      expect(published[0]!.data).toMatchObject({
        stream_id: 'stream1',
        content: '',
        status: 'cancelled',
        model: 'm',
        provider: 'prov',
        usage: USAGE,
      });

      // Сообщение сохранено со статусом cancelled (статистика отмены не теряется)
      const stored = (await sessionManager.getSession(sessionId))!;
      const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
      expect(assistant.metadata!.status).toBe('cancelled');
    });

    it('частичный ответ из завершённых итераций + best-effort оценка usage', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();
      const state = makeState({
        cancelledBeforeFinal: true,
        finalContent: 'обрывок',
        finalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        allIntermediateTexts: [{ text: 'первая', iteration: 0 }, { text: 'вторая', iteration: 1 }],
        allReasoning: [{ text: 'думал', iteration: 0 }],
      });

      await runProcessFinalize(makeArgs(sessionId), state, deps);

      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[1]).toBe('первая\n\nвторая');
      expect(saveCall[6]).toBe('думал');
      // отсутствующие токены дозаполняются оценкой → usage_estimated
      expect(saveCall[17]).toMatchObject({ usage_estimated: true });
      expect(published[0]!.data.usage_estimated).toBe(true);
      expect(published[0]!.data.content).toBe('первая\n\nвторая');
    });

    it('последняя итерация без финального чанка: модель берётся из provider/settings', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();
      const provider = new FakeProvider();
      provider.model = 'provider-model';
      const state = makeState({
        cancelledBeforeFinal: true,
        lastChunkModel: undefined,
        finalModel: undefined,
        provider,
      });

      await runProcessFinalize(
        makeArgs(sessionId, { session: { id: sessionId, settings: { model: 's-model' } } as never }),
        state, deps,
      );

      expect(published[0]!.data.model).toBe('provider-model');
    });
  });

  describe('фоллбек-тексты и статус', () => {
    it('лимит итераций при пустом ответе → session.max_iterations, статус limit', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: '', toolIteration: 10, maxIterations: 10 }),
        deps,
      );

      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[1]).toBe(sm('session.max_iterations'));
      expect(saveCall[17]).toMatchObject({ i18n: { key: 'session.max_iterations' } });
      expect(published[0]!.data).toMatchObject({
        content: sm('session.max_iterations'),
        status: 'limit',
      });
    });

    it('непустой финальный ответ не заменяется фоллбеком лимита', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId), makeState({ finalContent: 'готово', toolIteration: 12, maxIterations: 10 }), deps,
      );

      expect(published[0]!.data).toMatchObject({ content: 'готово', status: 'completed' });
    });

    it('deny: контент остановки, флаг stopped_by_deny и причина в событии', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: '', stopAfterDeny: true, denyStopReason: 'the user denied the request' }),
        deps,
      );

      expect(published[0]!.data).toMatchObject({
        content: sm('session.stopped', { reason: 'the user denied the request' }),
        status: 'stopped',
        stopped_by_deny: true,
        deny_reason: 'the user denied the request',
      });
    });

    it('deny без причины → дефолтная причина', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: '', stopAfterDeny: true, denyStopReason: undefined }),
        deps,
      );

      expect(published[0]!.data.content).toBe(
        sm('session.stopped', { reason: sm('session.stopped_reason_denied') }),
      );
    });

    it('пустой ответ после deny-блокировок → denied_blocked (status stopped); без deny → empty_response (status error)', async () => {
      const sessionId = await makeSession();
      const denied = makeDeps();
      await runProcessFinalize(makeArgs(sessionId), makeState({ finalContent: '', hadDeny: true }), denied);
      expect(published[0]!.data).toMatchObject({
        content: sm('session.denied_blocked'),
        status: 'stopped',
      });

      const plain = makeDeps();
      await runProcessFinalize(makeArgs(sessionId), makeState({ finalContent: '' }), plain);
      expect(published[1]!.data).toMatchObject({
        content: sm('session.empty_response'),
        status: 'error',
      });
    });
  });

  describe('успешный путь', () => {
    it('assistant сохраняется до stream.done, ровно одно stream.done', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      expect(order).toEqual(['saveAssistantMessage', 'unregister:stream1']);
      expect(published.map((p) => p.event)).toEqual(['stream.done']);
      expect(published[0]!.data).toMatchObject({
        stream_id: 'stream1',
        content: 'ответ модели',
        status: 'completed',
        model: 'm',
        provider: 'prov',
        usage: USAGE,
        message_index: 1,
        pending_count: 0,
      });
      expect(deps.calibrateTokenRatio).toHaveBeenCalledWith('m', 400, USAGE, undefined);
    });

    it('reasoning_blocks/intermediate_text_blocks только при наличии', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();
      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);
      expect(published[0]!.data.reasoning_blocks).toBeUndefined();
      expect(published[0]!.data.intermediate_text_blocks).toBeUndefined();

      const withBlocks = makeDeps();
      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({
          allReasoning: [{ text: 'r1', iteration: 0 }],
          allIntermediateTexts: [{ text: 't1', iteration: 0 }],
        }),
        withBlocks,
      );
      expect(published[1]!.data).toMatchObject({
        reasoning_blocks: [{ text: 'r1', iteration: 0 }],
        intermediate_text_blocks: [{ text: 't1', iteration: 0 }],
      });
    });

    it('secrets из ответа уходят в metadata stream.done (ADR-036)', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps({ getAssistantSecrets: vi.fn(async () => ({ '⟦SYNTH_SECRET_1⟧': 'sk' })) as never });

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      expect(deps.getAssistantSecrets).toHaveBeenCalledWith(sessionId, 'ответ модели');
      expect(published[0]!.data.metadata).toEqual({ secrets: { '⟦SYNTH_SECRET_1⟧': 'sk' } });
    });

    it('tool_results и usage попадают в сохранённое сообщение', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ allToolCalls: [{ id: 'call_1', name: 'read_file', result: { content: 'x' } }] }),
        deps,
      );

      const stored = (await sessionManager.getSession(sessionId))!;
      const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
      expect(assistant.metadata!.tool_results).toHaveLength(1);
      expect(stored.inputTokens).toBe(10);
    });
  });

  describe('quality check + escalation (ADR-034)', () => {
    const decision: RoutingDecision = {
      providerName: 'prov', modelName: 'm', reason: 'test', strategy: 'default',
    };

    function routerWith(options: {
      enabled: boolean;
      pass?: boolean;
      fallback?: { provider: string; model: string };
      fallbackProvider?: BaseProvider | null;
      fbContent?: string;
    }): ModelRouter {
      return {
        getEscalationConfig: () => ({
          enabled: options.enabled,
          fallbackProvider: options.fallback?.provider ?? '',
          fallbackModel: options.fallback?.model ?? '',
        }),
        checkQuality: vi.fn(async () => ({ pass: options.pass ?? false, reason: 'Response is shorter than 10 characters' })),
        getProvider: vi.fn(() => (options.fallbackProvider === undefined
          ? new FakeProvider({
              content: options.fbContent ?? 'эскалированный ответ',
              model: 'fb-model',
              usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
            })
          : options.fallbackProvider)),
      } as unknown as ModelRouter;
    }

    it('провал QC без пары fallback → qa_pass=false, контент не меняется', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: false });
      const deps = makeDeps({ router });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      const quality = events.find((e) => e.type === 'message.quality_check')!;
      expect(quality.data).toMatchObject({ qa_pass: false, qa_reason: 'Response is shorter than 10 characters' });
      expect(published[0]!.data.content).toBe('ответ модели');
      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[15]).toBe(false);
    });

    it('провал QC + fallback-пара → перевызов LLM, qa_pass=true, причина escalation', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: false, fallback: { provider: 'fb', model: 'fb-model' } });
      const deps = makeDeps({ router });

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({
          routingDecision: decision,
          currentMessages: [
            { role: 'assistant', content: 'частичный', toolUse: [{ id: 'c1' }], toolCallId: undefined } as unknown as LLMMessage,
            { role: 'user', content: 'вопрос' } as unknown as LLMMessage,
          ],
        }),
        deps,
      );

      expect((router.getProvider as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({ providerName: 'fb', modelName: 'fb-model', reason: 'escalation_fallback' }),
        undefined,
        undefined,
      );
      expect(published[0]!.data).toMatchObject({ content: 'эскалированный ответ', model: 'fb-model', status: 'completed' });
      expect(events.find((e) => e.type === 'message.quality_check')!.data).toMatchObject({
        qa_pass: true,
        qa_reason: sm('router.escalation', { provider: 'fb', model: 'fb-model', reason: 'Response is shorter than 10 characters' }),
      });
    });

    it('сессионная пара fallback приоритетнее конфигурации эскалации', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: false, fallback: { provider: 'cfg', model: 'cfg-model' } });
      const deps = makeDeps({ router });

      await runProcessFinalize(
        makeArgs(sessionId, {
          session: {
            id: sessionId,
            settings: { routingEscalation: { fallbackProvider: 'sess', fallbackModel: 'sess-model' } },
          } as never,
        }),
        makeState({ routingDecision: decision }),
        deps,
      );

      expect((router.getProvider as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({ providerName: 'sess', modelName: 'sess-model' }),
        undefined,
        undefined,
      );
    });

    it('успешный QC → qa_pass=true, перевызова нет', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: true });
      const deps = makeDeps({ router });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      expect((router.getProvider as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(events.find((e) => e.type === 'message.quality_check')!.data).toMatchObject({ qa_pass: true });
      expect(published[0]!.data.content).toBe('ответ модели');
    });

    it('эскалация выключена → QC не вызывается и событие не публикуется', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: false, pass: false });
      const deps = makeDeps({ router });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      expect((router.checkQuality as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(events.find((e) => e.type === 'message.quality_check')).toBeUndefined();
    });

    it('ошибка fallback-вызова не ломает ход: остаётся исходный контент', async () => {
      const sessionId = await makeSession();
      const router = routerWith({
        enabled: true, pass: false, fallback: { provider: 'fb', model: 'fb-model' },
        fallbackProvider: new FakeProvider(new Error('fallback недоступен')),
      });
      const deps = makeDeps({ router });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      expect(published[0]!.data.content).toBe('ответ модели');
      expect(events.find((e) => e.type === 'message.quality_check')!.data).toMatchObject({ qa_pass: false });
    });
  });
});
