/**
 * ADR-095 (шаг 6b-1): собственные тесты эпилога `runProcessFinalize`.
 *
 * Контракты (порядок side-effect'ов и отсутствие двойных публикаций):
 *  - отмена до финального сохранения → assistant (status=cancelled) → ровно
 *    одно `stream.cancelled`, **без** `step.finished`; tool-chain уже записан
 *    пошагово в цикле (шаг 2а) — в эпилоге его нет;
 *  - фоллбек-тексты (лимит итераций / deny / пустой ответ) — в сохранённом
 *    assistant-сообщении, статус — в `step.finished` (статус сообщения шага) и
 *    `turn.finished` (терминальный статус хода);
 *  - quality-check/escalation (ADR-034): перевызов на fallback-модели без
 *    assistant-сообщений с toolUse, событие `message.quality_check`;
 *  - secrets из ответа — в metadata сохранённого сообщения (ADR-036),
 *    `unregister` ровно один раз.
 *
 * ADR-118 §4: `stream.done` удалён без dual-emit — финал шага публикуется
 * `step.finished` (статус, usage, вложения ответа, тайминги), ход закрывает
 * `turn.finished`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeMediaPart, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, LLMChunk, LLMResponse, Message, Part, TokenUsage } from '@itphx/synth-shared';
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
  /** ADR-115 (outbound): ссылки на объекты вложений ответа (best-effort). */
  let blobRefs: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-finalize-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
    published = [];
    order = [];
    debugCollector = new DebugCollector(false);
    blobRefs = { add: vi.fn(async () => undefined) };
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(withUserMessage = true): Promise<string> {
    const session = await sessionManager.createSession({ title: 'Fin', settings: { agentRole: 'fixer' } as never });
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
      toolIteration: 1,
      maxIterations: 10,
      stepLimitExecuted: false,
      lastIterationPromptChars: 400,
      allReasoning: [],
      allIntermediateTexts: [],
      allToolCalls: [],
      currentMessages: [],
      promptMeta: { agentRole: 'fixer', generation: 1, expected: 'miss', cachedTokens: 0, validated: false },
      loadedTokenRatio: undefined,
      routingDecision: undefined,
      provider: new FakeProvider(),
      finalSystemPrompt: { text: 'sys', cacheKey: 'session-cache-key' },
      providerName: 'prov',
      effectiveAgentRole: 'fixer',
      effectiveReasoningLevel: undefined,
      // ADR-118 §1: ход и финальный шаг.
      turnId: 'turn1',
      finalStepIndex: 0,
      finalStepMessageId: 'msg-step-0',
      ...overrides,
    };
  }

  function makeDeps(overrides: Partial<ProcessFinalizeDeps> = {}): ProcessFinalizeDeps {
    const saveSpy = vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
      order.push('saveAssistantMessage');
      return saveAssistantMessage(
        { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null, blobRefs: blobRefs as never },
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

  /** Событие по имени (шаг и ход закрываются ровно одним событием). */
  function eventOf(name: string): { event: string; data: Record<string, unknown> } {
    const found = published.find((p) => p.event === name);
    expect(found, `событие ${name} не опубликовано`).toBeDefined();
    return found!;
  }

  /** Последнее событие по имени — второй прогон в одном тесте. */
  function lastEventOf(name: string): { event: string; data: Record<string, unknown> } {
    const found = [...published].reverse().find((p) => p.event === name);
    expect(found, `событие ${name} не опубликовано`).toBeDefined();
    return found!;
  }

  /** ADR-118 §4: шаг закрывается `step.finished`, ход — `turn.finished`. */
  const stepFinished = () => eventOf('step.finished');
  const turnFinished = () => eventOf('turn.finished');

  /** Последнее сохранённое assistant-сообщение (текст живёт только в нём). */
  async function storedAssistant(sessionId: string): Promise<Message> {
    const stored = (await sessionManager.getSession(sessionId))!;
    return stored.messages.filter((m) => m.role === MessageRole.ASSISTANT).at(-1)!;
  }

  describe('ветка отмены', () => {
    it('assistant(status=cancelled) → stream.cancelled, без step.finished', async () => {
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

      // ADR-118 §4: отмена закрывает ход (`turn.finished`), шага в полёте нет —
      // `step.finished` в эпилоге не публикуется.
      expect(published.map((p) => p.event)).toEqual(['stream.cancelled', 'turn.finished']);
      expect(published[0]!.data).toMatchObject({
        stream_id: 'stream1',
        content: '',
        status: 'cancelled',
        model: 'm',
        provider: 'prov',
        usage: USAGE,
      });
      expect(published[1]!.data).toMatchObject({ turnId: 'turn1', status: 'cancelled' });

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
    it('шаг-лимит при пустом ответе → session.steps_limit + step_limit_reached, статус limit', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: '', toolIteration: 10, maxIterations: 10, stepLimitExecuted: true }),
        deps,
      );

      const expected = sm('session.steps_limit', { limit: '10' });
      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[1]).toBe(expected);
      expect(saveCall[17]).toMatchObject({
        i18n: { key: 'session.steps_limit', params: { limit: '10' } },
        step_limit_reached: true,
      });
      // ADR-118 §4: текст фоллбека — в сообщении шага (в `step.finished`
      // контента нет); статус `limit` сводится к `completed` у шага
      // (ошибки не было) и `stopped` у хода — вместо прежнего
      // `status: 'limit'` в `stream.done`.
      expect(await storedAssistant(sessionId)).toMatchObject({
        content: expected,
        metadata: { step_limit_reached: true, status: 'limit' },
      });
      expect(stepFinished().data).toMatchObject({
        turnId: 'turn1',
        stepIndex: 0,
        status: 'completed',
      });
      expect(turnFinished().data).toMatchObject({ turnId: 'turn1', status: 'stopped' });
    });

    it('непустой финальный ответ на шаге-лимите → текст сохраняется, step_limit_reached=true', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: 'готово', toolIteration: 10, maxIterations: 10, stepLimitExecuted: true }),
        deps,
      );

      expect(await storedAssistant(sessionId)).toMatchObject({
        content: 'готово',
        metadata: { step_limit_reached: true, status: 'completed' },
      });
      expect(stepFinished().data).toMatchObject({ status: 'completed' });
      expect(turnFinished().data).toMatchObject({ status: 'completed' });
    });

    it('непустой финальный ответ не заменяется фоллбеком лимита', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId), makeState({ finalContent: 'готово', toolIteration: 12, maxIterations: 10 }), deps,
      );

      expect(await storedAssistant(sessionId)).toMatchObject({
        content: 'готово',
        metadata: { status: 'completed' },
      });
      expect(stepFinished().data).toMatchObject({ status: 'completed' });
    });

    it('deny без финального текста → denied_blocked; поля stopped_by_deny/deny_reason не публикуются', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: '', hadDeny: true }),
        deps,
      );

      expect(await storedAssistant(sessionId)).toMatchObject({
        content: sm('session.denied_blocked'),
        metadata: { status: 'stopped' },
      });
      const step = stepFinished().data;
      expect(step).toMatchObject({ status: 'completed' });
      expect(step.stopped_by_deny).toBeUndefined();
      expect(step.deny_reason).toBeUndefined();
      expect(turnFinished().data).toMatchObject({ status: 'stopped' });
    });

    it('пустой ответ после deny-блокировок → denied_blocked (ход stopped); без deny → empty_response (ход error)', async () => {
      const sessionId = await makeSession();
      const denied = makeDeps();
      await runProcessFinalize(makeArgs(sessionId), makeState({ finalContent: '', hadDeny: true }), denied);
      expect(await storedAssistant(sessionId)).toMatchObject({
        content: sm('session.denied_blocked'),
        metadata: { status: 'stopped' },
      });
      expect(lastEventOf('step.finished').data).toMatchObject({ status: 'completed' });
      expect(lastEventOf('turn.finished').data).toMatchObject({ status: 'stopped' });

      const plain = makeDeps();
      await runProcessFinalize(makeArgs(sessionId), makeState({ finalContent: '' }), plain);
      expect(await storedAssistant(sessionId)).toMatchObject({
        content: sm('session.empty_response'),
        metadata: { status: 'error' },
      });
      expect(lastEventOf('step.finished').data).toMatchObject({ status: 'error' });
      expect(lastEventOf('turn.finished').data).toMatchObject({ status: 'error' });
    });

    it('ролевой deny + пустой ответ → role_tool_blocked с tool/agent (ход stopped)', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({
          finalContent: '',
          hadDeny: true,
          roleBlocked: true,
          roleBlockedTool: 'execute_shell',
          roleBlockedAgent: 'assistant',
        }),
        deps,
      );

      const expected = sm('session.role_tool_blocked', {
        tool: 'execute_shell',
        agent: 'assistant',
      });
      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[1]).toBe(expected);
      expect(saveCall[17]).toMatchObject({
        i18n: {
          key: 'session.role_tool_blocked',
          params: { tool: 'execute_shell', agent: 'assistant' },
        },
      });
      const stored = await storedAssistant(sessionId);
      expect(stored).toMatchObject({ content: expected, metadata: { status: 'stopped' } });
      expect(stepFinished().data).toMatchObject({ status: 'completed' });
      expect(turnFinished().data).toMatchObject({ status: 'stopped' });
      // Ролевой отказ не маскируется под «заблокировано политикой безопасности».
      expect(stored.content).not.toBe(sm('session.denied_blocked'));
    });

    it('ролевой deny не перетирает непустой ответ модели', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({
          finalContent: 'Сам не смог — предлагаю делегировать @fixer',
          hadDeny: true,
          roleBlocked: true,
          roleBlockedTool: 'execute_shell',
          roleBlockedAgent: 'assistant',
        }),
        deps,
      );

      const saveCall = (deps.saveAssistantMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(saveCall[1]).toBe('Сам не смог — предлагаю делегировать @fixer');
      expect(await storedAssistant(sessionId)).toMatchObject({
        content: 'Сам не смог — предлагаю делегировать @fixer',
        metadata: { status: 'completed' },
      });
      expect(stepFinished().data).toMatchObject({ status: 'completed' });
    });
  });

  describe('успешный путь', () => {
    it('assistant сохраняется до step.finished/turn.finished, по одному событию на шаг и ход', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      expect(order).toEqual(['saveAssistantMessage', 'unregister:stream1']);
      // ADR-118 §4: `stream.done` заменён парой `step.finished` + `turn.finished`.
      expect(published.map((p) => p.event)).toEqual(['step.finished', 'turn.finished']);
      expect(stepFinished().data).toEqual({
        turnId: 'turn1',
        stepIndex: 0,
        messageId: 'msg-step-0',
        status: 'completed',
        usage: USAGE,
        provider: 'prov',
        model: 'm',
        costUsd: 0.25,
        costCurrency: 'USD',
        agentRole: 'fixer',
      });
      expect(turnFinished().data).toEqual({ turnId: 'turn1', status: 'completed' });
      // Текст ответа — в сообщении шага (в событии шага контента нет).
      expect((await storedAssistant(sessionId)).content).toBe('ответ модели');
      expect(deps.calibrateTokenRatio).toHaveBeenCalledWith('m', 400, USAGE, undefined);
    });

    it('reasoning-части и intermediate_text_blocks — только при наличии', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();
      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);
      const plain = await storedAssistant(sessionId);
      expect(plain.parts.map((p) => p.type)).toEqual(['text']);
      expect(plain.metadata!.intermediate_text_blocks).toBeUndefined();

      const withBlocks = makeDeps();
      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({
          allReasoning: [{ text: 'r1', iteration: 0 }],
          allIntermediateTexts: [{ text: 't1', iteration: 0 }],
        }),
        withBlocks,
      );
      const rich = await storedAssistant(sessionId);
      expect(rich.parts.map((p) => p.type)).toEqual(['text', 'reasoning']);
      expect(rich.metadata!.intermediate_text_blocks).toEqual([{ text: 't1', iteration: 0 }]);
    });

    it('secrets из ответа — в metadata сообщения, не в событии шага (ADR-036)', async () => {
      const sessionId = await makeSession();
      const secretMap = { '⟦SYNTH_SECRET_1⟧': 'sk' };
      const obfMapStore = { get: vi.fn(async () => secretMap) };
      const save = vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
        order.push('saveAssistantMessage');
        return saveAssistantMessage(
          {
            sessionManager,
            eventBus,
            obfMapStore: obfMapStore as never,
            modelPriceLoader: null,
            blobRefs: blobRefs as never,
          },
          ...args,
        );
      });
      const deps = makeDeps({ saveAssistantMessage: save as unknown as SaveAssistantMessageFn });

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ finalContent: 'ключ ⟦SYNTH_SECRET_1⟧' }),
        deps,
      );

      const stored = await storedAssistant(sessionId);
      expect(stored.metadata!.secrets).toEqual(secretMap);
      // ADR-118 §4: `stream.done` (единственный носитель `metadata`) удалён —
      // в `step.finished` секретов нет.
      expect(stepFinished().data).not.toHaveProperty('metadata');
      expect(stepFinished().data).not.toHaveProperty('secrets');
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
      expect((await storedAssistant(sessionId)).content).toBe('ответ модели');
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
        undefined,
        undefined,
        undefined,
        undefined,
      );
      // ADR-118 §4: текст эскалации — в сообщении шага, модель — в `step.finished`.
      expect(stepFinished().data).toMatchObject({ model: 'fb-model', status: 'completed' });
      expect((await storedAssistant(sessionId)).content).toBe('эскалированный ответ');      expect(events.find((e) => e.type === 'message.quality_check')!.data).toMatchObject({
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
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('topP/topK агента хода уходят в пул при эскалации', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: false, fallback: { provider: 'fb', model: 'fb-model' } });
      const deps = makeDeps({
        router,
        agentRegistry: {
          get: (id: string) => (id === 'fixer' ? { id: 'fixer', topP: 0.9, topK: 40 } : undefined),
        } as never,
      });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      const call = (router.getProvider as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[5]).toBe(0.9);
      expect(call[6]).toBe(40);
    });

    it('без topP/topK у агента — в пул уходят undefined', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: false, fallback: { provider: 'fb', model: 'fb-model' } });
      const deps = makeDeps({
        router,
        agentRegistry: {
          get: (id: string) => (id === 'fixer' ? { id: 'fixer', topP: 0, topK: 0 } : undefined),
        } as never,
      });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      const call = (router.getProvider as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[5]).toBeUndefined();
      expect(call[6]).toBeUndefined();
    });

    it('успешный QC → qa_pass=true, перевызова нет', async () => {
      const sessionId = await makeSession();
      const router = routerWith({ enabled: true, pass: true });
      const deps = makeDeps({ router });

      await runProcessFinalize(makeArgs(sessionId), makeState({ routingDecision: decision }), deps);

      expect((router.getProvider as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(events.find((e) => e.type === 'message.quality_check')!.data).toMatchObject({ qa_pass: true });
      expect((await storedAssistant(sessionId)).content).toBe('ответ модели');
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

      expect((await storedAssistant(sessionId)).content).toBe('ответ модели');
      expect(events.find((e) => e.type === 'message.quality_check')!.data).toMatchObject({ qa_pass: false });
    });
  });

  describe('вложения ответа (ADR-115, outbound)', () => {
    /** sha256 виду «aa…»/«bb…» — валидная 64-символьная hex-строка. */
    function shaOf(fill: string): string {
      return fill.repeat(64).slice(0, 64);
    }

    function mediaPart(type: 'image' | 'audio' | 'video' | 'file', fill: string, name?: string): Part {
      const sha256 = shaOf(fill);
      return makeMediaPart(type, {
        blobPath: `attachments/${sha256.slice(0, 2)}/${sha256}`,
        sha256,
        mime: type === 'file' ? 'application/pdf' : `${type}/png`,
        size: 1024,
        ...(name ? { name } : {}),
      });
    }

    /**
     * Зависимости с сохранением ответа «с медиа-частями»: реальный
     * `saveAssistantMessage` пишет только текстовую часть, поэтому части
     * проставляются сразу после сохранения (так выглядит ответ с вложениями).
     */
    function depsWithParts(parts: Part[]): ProcessFinalizeDeps {
      const save = vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
        const content = await saveAssistantMessage(
          { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null },
          ...args,
        );
        const [sessionId, , streamId] = args;
        const messages = (await sessionManager.getSession(sessionId))?.messages ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]!;
          if (message.role !== MessageRole.ASSISTANT) continue;
          if (message.metadata?.stream_id !== streamId) continue;
          await sessionManager.updateMessage(sessionId, { ...message, parts });
          break;
        }
        return content;
      });
      return makeDeps({ saveAssistantMessage: save as unknown as SaveAssistantMessageFn });
    }

    it('image + pdf → step.finished.attachments с sha/mime/size/name в порядке частей', async () => {
      const sessionId = await makeSession();
      const deps = depsWithParts([
        makeTextPart('вот файлы'),
        mediaPart('image', 'a', 'photo.png'),
        mediaPart('file', 'b', 'report.pdf'),
      ]);

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      const done = stepFinished().data;
      expect(done.attachments).toEqual([
        { sha256: shaOf('a'), mime: 'image/png', size: 1024, name: 'photo.png' },
        { sha256: shaOf('b'), mime: 'application/pdf', size: 1024, name: 'report.pdf' },
      ]);
    });

    it('без медиа — поля attachments нет (прежний контракт события)', async () => {
      const sessionId = await makeSession();

      await runProcessFinalize(makeArgs(sessionId), makeState(), makeDeps());

      const done = stepFinished().data;
      expect('attachments' in done).toBe(false);
    });

    it('части без валидной формы игнорируются, вложения пользователя не попадают', async () => {
      const sessionId = await makeSession();
      // Медиа-часть в сообщении пользователя — не ответ: в шаге её нет.
      const user = (await sessionManager.getSession(sessionId))!.messages[0]!;
      await sessionManager.updateMessage(sessionId, {
        ...user,
        parts: [makeTextPart('вопрос'), mediaPart('image', 'c', 'user.png')],
      });

      const deps = depsWithParts([
        makeTextPart('ответ'),
        // битые формы: без данных, без blobPath, sha не 64 hex, size не число
        { id: generateId(), type: 'image', data: {} },
        { id: generateId(), type: 'file', data: { sha256: shaOf('d'), mime: 'text/plain', size: 1 } },
        {
          id: generateId(),
          type: 'image',
          data: { blobPath: 'attachments/zz/zz', sha256: 'zz', mime: 'image/png', size: 1 },
        },
        {
          id: generateId(),
          type: 'audio',
          data: { blobPath: `attachments/${shaOf('e').slice(0, 2)}/${shaOf('e')}`, sha256: shaOf('e'), mime: 'audio/mpeg', size: 'много' },
        },
        mediaPart('image', 'f'),
      ]);

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      const done = stepFinished().data;
      expect(done.attachments).toEqual([
        { sha256: shaOf('f'), mime: 'image/png', size: 1024 },
      ]);
    });

    it('часть из коллектора (`outboundParts`) попадает в финальное сообщение и step.finished', async () => {
      const sessionId = await makeSession();
      const part = mediaPart('image', '1', 'diagram.png');

      // Реальный производитель (`send_attachment`) — часть в коллекторе хода;
      // финализация обязана сама добавить её к финальному сообщению.
      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ outboundParts: [part] }),
        makeDeps(),
      );

      const stored = (await sessionManager.getSession(sessionId))!;
      const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
      expect(assistant.parts).toHaveLength(2);
      expect(assistant.parts[0]!.type).toBe('text');
      expect(assistant.parts[1]).toMatchObject({ type: 'image', data: { name: 'diagram.png' } });

      const done = stepFinished().data;
      expect(done.attachments).toEqual([
        { sha256: shaOf('1'), mime: 'image/png', size: 1024, name: 'diagram.png' },
      ]);

      // Ссылка на объект учтена с id **сохранённого** сообщения (GC, ADR-115).
      expect(blobRefs.add).toHaveBeenCalledWith({
        blobPath: `attachments/${shaOf('1').slice(0, 2)}/${shaOf('1')}`,
        ownerKind: 'message',
        ownerId: assistant.id,
      });
    });

    it('без коллектора (`outboundParts` не задан) — прежнее поведение', async () => {
      const sessionId = await makeSession();

      await runProcessFinalize(makeArgs(sessionId), makeState(), makeDeps());

      const stored = (await sessionManager.getSession(sessionId))!;
      const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
      expect(assistant.parts).toHaveLength(1);
      expect(assistant.parts[0]!.type).toBe('text');
      expect(blobRefs.add).not.toHaveBeenCalled();
    });

    it('ветка отмены части не сохраняет и не отправляет (объект остаётся до GC)', async () => {
      const sessionId = await makeSession();

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ cancelledBeforeFinal: true, finalContent: 'обрывок', outboundParts: [mediaPart('image', '2', 'x.png')] }),
        makeDeps(),
      );

      const stored = (await sessionManager.getSession(sessionId))!;
      const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
      expect(assistant.parts).toHaveLength(1);
      // ADR-118 §4: отмена закрывает и ход — `turn.finished` без вложений.
      expect(published.map((p) => p.event)).toEqual(['stream.cancelled', 'turn.finished']);
      expect(published[0]!.data).not.toHaveProperty('attachments');
      expect(blobRefs.add).not.toHaveBeenCalled();
    });
  });

  /**
   * ADR-111/ADR-113 × ADR-104: остаток steer-очереди в конце хода.
   * Уведомление фонового прогона не дропается — отдаётся в
   * `requeueBackgroundNotices` (и при обычном завершении, и при «Стопе»).
   */
  describe('возврат уведомлений фоновых прогонов в очередь', () => {
    function backgroundNotice(content = '<process>ok</process>'): Message {
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
        author: 'Process',
        metadata: { type: 'background_run_result', kind: 'process' },
      };
    }

    it('turn_ended: уведомление возвращается в очередь, steer.dropped не публикуется', async () => {
      const sessionId = await makeSession();
      await sessionManager.enqueueSteerMessage(sessionId, backgroundNotice());
      const requeue = vi.fn<
        (sessionId: string, messages: Message[], opts: { autostart: boolean }) => Promise<void>
      >(async () => {});
      const deps = makeDeps({ requeueBackgroundNotices: requeue });

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      expect(requeue).toHaveBeenCalledTimes(1);
      expect(requeue.mock.calls[0]![0]).toBe(sessionId);
      expect(requeue.mock.calls[0]![1]).toHaveLength(1);
      expect(requeue.mock.calls[0]![2]).toEqual({ autostart: true });
      expect(published.some((p) => p.event === 'steer.dropped')).toBe(false);
      expect((await sessionManager.getSession(sessionId))!.steerInbox ?? []).toHaveLength(0);
    });

    it('aborted: уведомление тоже возвращается в очередь', async () => {
      const sessionId = await makeSession();
      await sessionManager.enqueueSteerMessage(sessionId, backgroundNotice());
      const requeue = vi.fn<
        (sessionId: string, messages: Message[], opts: { autostart: boolean }) => Promise<void>
      >(async () => {});
      const deps = makeDeps({ requeueBackgroundNotices: requeue });

      await runProcessFinalize(
        makeArgs(sessionId),
        makeState({ cancelledBeforeFinal: true, finalContent: '' }),
        deps,
      );

      expect(requeue).toHaveBeenCalledTimes(1);
      expect(requeue.mock.calls[0]![1]).toHaveLength(1);
      // «Стоп» не должен автостартовать ход.
      expect(requeue.mock.calls[0]![2]).toEqual({ autostart: false });
    });

    it('без зависимости поведение прежнее: сообщение снимается через steer.dropped', async () => {
      const sessionId = await makeSession();
      await sessionManager.enqueueSteerMessage(sessionId, backgroundNotice());

      await runProcessFinalize(makeArgs(sessionId), makeState(), makeDeps());

      const dropped = published.find((p) => p.event === 'steer.dropped');
      expect(dropped).toBeDefined();
      expect(dropped!.data.reason).toBe('turn_ended');
      expect((await sessionManager.getSession(sessionId))!.steerInbox ?? []).toHaveLength(0);
      expect(
        (await sessionManager.getSession(sessionId))!.pendingMessages,
      ).toHaveLength(0);
    });
  });

  /**
   * Авто-тайтл запускается только при **одной** реплике пользователя. Steer-
   * инъекция персистится на границе шага до финализации — без фильтра
   * служебных сообщений ход выглядел «вторым» и заголовок не ставился.
   */
  describe('авто-тайтл: служебные user-сообщения не считаются репликами', () => {
    it('первое сообщение + steer-инъекция → заголовок всё равно генерируется', async () => {
      const session = await sessionManager.createSession({ settings: { agentRole: 'fixer' } as never });
      const addUser = async (content: string, metadata?: Record<string, unknown>): Promise<void> => {
        await sessionManager.addMessage(session.id, {
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
          ...(metadata ? { metadata } : {}),
        });
      };
      await addUser('вопрос пользователя');
      await addUser('Первй тест', { steer: true });

      const provider = new FakeProvider({ content: 'Заголовок хода' } as LLMResponse);
      await runProcessFinalize(
        makeArgs(session.id),
        makeState({ finalContent: 'ответ модели', provider }),
        makeDeps(),
      );

      await vi.waitFor(async () => {
        expect((await sessionManager.getSession(session.id))!.title).toBe('Заголовок хода');
      });
    });
  });
});
