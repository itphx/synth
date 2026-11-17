/**
 * PROP-143: durable-запись причины остановки в **основной** сессии.
 *
 * Контракты:
 *  - невосстановимая ошибка провайдера → ровно одна запись
 *    `execution_stopped` (`reason: 'provider_error'`, `error_type`, `attempts`,
 *    тело — текст ошибки);
 *  - повторный терминальный исход того же хода (тот же `streamId`) вторую
 *    запись не добавляет;
 *  - recoverable-попытка (повтор ещё будет) записи не оставляет;
 *  - пользовательский «Стоп» → запись `reason: 'stopped_by_user'`;
 *  - обфускация тела вызывается (ADR-036).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, Message, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { DebugCollector } from '../../debug.js';
import { BaseProvider } from '../../providers/base.js';
import type { LLMMessage } from '../../providers/base.js';
import { STOP_MESSAGE_TYPE } from '../stop-reason.js';
import { saveAssistantMessage, resolveAssistantStatus, type SaveAssistantMessageFn } from './persistence.js';
import { resolveMessageModel, estimateUsage } from './usage.js';
import { handleLlmFailure, type LlmFailureContext } from './errors.js';
import {
  runProcessFinalize,
  type ProcessFinalizeArgs,
  type ProcessFinalizeDeps,
  type ProcessFinalizeState,
} from './phases/process-finalize.js';

class FakeProvider extends BaseProvider {
  constructor() {
    super({ url: '', apiKey: '', model: 'm', name: 'fake' });
  }

  async chat(): Promise<never> {
    throw new Error('not used');
  }

  async *chatAsync(): AsyncGenerator<never> {
    yield { content: '', isFinal: true, model: this.model } as never;
  }

  getProviderName(): string {
    return 'fake';
  }
}

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe('PROP-143: durable-запись причины остановки (основная сессия)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-stop-record-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(withUserMessage = true): Promise<string> {
    const session = await sessionManager.createSession({ title: 'Stop', settings: { agentRole: 'fixer' } as never });
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
        metadata: { stream_id: 'stream1' },
      };
      await sessionManager.addMessage(session.id, message);
    }
    return session.id;
  }

  /** Записи причины остановки в истории сессии. */
  async function stopRecords(sessionId: string): Promise<Message[]> {
    const session = await sessionManager.getSession(sessionId);
    return (session?.messages ?? []).filter((m) => m.metadata?.type === STOP_MESSAGE_TYPE);
  }

  function failureContext(overrides: Partial<LlmFailureContext> = {}): LlmFailureContext {
    return { durationMs: 10, model: 'm', providerName: 'p', agentRole: 'fixer', ...overrides };
  }

  it('(a) невосстановимая ошибка → одна запись: reason/error_type/attempts и текст ошибки в теле', async () => {
    const sessionId = await makeSession();

    await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, failureContext(),
      { sessionManager, eventBus },
    );

    const records = await stopRecords(sessionId);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.role).toBe(MessageRole.USER);
    expect(record.author).toBe('System');
    expect(record.metadata?.reason).toBe('provider_error');
    expect(record.metadata?.error_type).toBe('auth_error');
    expect(record.metadata?.attempts).toBe(1);
    expect(record.metadata?.max_retries).toBe(3);
    expect(record.metadata?.retryable).toBe(false);
    expect(record.metadata?.provider).toBe('p');
    expect(record.metadata?.model).toBe('m');
    // Тело конверта — сырой текст провайдера.
    expect(record.content).toContain('401 Unauthorized');
  });

  it('(b) повторный терминальный исход с тем же streamId → запись не дублируется', async () => {
    const sessionId = await makeSession();

    const deps = { sessionManager, eventBus };
    await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, failureContext(), deps,
    );
    await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 2, failureContext(), deps,
    );

    expect(await stopRecords(sessionId)).toHaveLength(1);
  });

  it('(c) recoverable-попытка (повтор ещё будет) → записи нет', async () => {
    const sessionId = await makeSession();

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('fetch failed'), 1, failureContext(),
      { sessionManager, eventBus },
    );

    expect(result.canRetry).toBe(true);
    expect(await stopRecords(sessionId)).toHaveLength(0);
  });

  it('(e) обфускация тела вызвана и применена', async () => {
    const sessionId = await makeSession();
    const obfuscate = vi.fn(async (sid: string, message: Message): Promise<Message> => {
      // Обфускация обновляет и текст, и части: слой хранения восстанавливает
      // `content` из `parts` (ADR-096, `buildContentFromParts`).
      const text = message.content.replace('401 Unauthorized', '[REDACTED]');
      return { ...message, content: text, parts: [makeTextPart(text)] };
    });

    await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, failureContext(),
      { sessionManager, eventBus, obfuscate },
    );

    expect(obfuscate).toHaveBeenCalledTimes(1);
    expect(obfuscate.mock.calls[0]![0]).toBe(sessionId);
    const records = await stopRecords(sessionId);
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toContain('[REDACTED]');
    expect(records[0]!.content).not.toContain('401 Unauthorized');
    // Метаданные записи не потерялись.
    expect(records[0]!.metadata?.reason).toBe('provider_error');
  });

  describe('(d) пользовательский «Стоп»', () => {
    function makeArgs(sessionId: string): ProcessFinalizeArgs {
      return {
        session: { id: sessionId, settings: {} } as never,
        streamId: 'stream1',
        publishChunk: () => {},
        debugCollector: new DebugCollector(false),
        streamStartedAt: Date.now() - 10,
      };
    }

    function makeState(overrides: Partial<ProcessFinalizeState> = {}): ProcessFinalizeState {
      return {
        cancelledBeforeFinal: true,
        lastChunkModel: undefined,
        finalModel: 'm',
        finalUsage: { ...USAGE },
        turnUsage: { ...USAGE },
        finalContent: '',
        fallbackI18n: undefined,
        hadDeny: false,
        toolIteration: 1,
        maxIterations: 10,
        stepLimitExecuted: false,
        lastIterationPromptChars: 400,
        allReasoning: [],
        allIntermediateTexts: [],
        allToolCalls: [],
        currentMessages: [] as LLMMessage[],
        promptMeta: { agentRole: 'fixer', generation: 1, expected: 'miss', cachedTokens: 0, validated: false },
        loadedTokenRatio: undefined,
        routingDecision: undefined,
        provider: new FakeProvider(),
        finalSystemPrompt: { text: 'sys', cacheKey: 'session-cache-key' },
        providerName: 'p',
        effectiveAgentRole: 'fixer',
        effectiveReasoningLevel: undefined,
        turnId: 'turn1',
        finalStepIndex: 0,
        finalStepMessageId: 'msg-step-0',
        ...overrides,
      };
    }

    function makeDeps(overrides: Partial<ProcessFinalizeDeps> = {}): ProcessFinalizeDeps {
      return {
        sessionManager,
        eventBus,
        router: null,
        agentRegistry: null,
        optimizer: null,
        resolveMessageModel,
        estimateUsage,
        computeMessageCost: () => null,
        saveAssistantMessage: ((...args: Parameters<SaveAssistantMessageFn>) =>
          saveAssistantMessage(
            { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null, blobRefs: undefined },
            ...args,
          )) as unknown as SaveAssistantMessageFn,
        resolveAssistantStatus,
        getAssistantSecrets: vi.fn(async () => ({})) as never,
        calibrateTokenRatio: vi.fn(async () => {}) as never,
        getProvider: vi.fn(() => new FakeProvider()) as never,
        unregister: vi.fn(),
        ...overrides,
      };
    }

    it('«Стоп» → запись reason=stopped_by_user, ровно одна', async () => {
      const sessionId = await makeSession();

      await runProcessFinalize(makeArgs(sessionId), makeState(), makeDeps());

      const records = await stopRecords(sessionId);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.role).toBe(MessageRole.USER);
      expect(record.author).toBe('System');
      expect(record.metadata?.reason).toBe('stopped_by_user');
      expect(record.metadata?.turn_id).toBe('turn1');
      expect(record.metadata?.stream_id).toBe('stream1');
      expect(record.metadata?.provider).toBe('p');
      expect(record.metadata?.agent_role).toBe('fixer');
    });

    it('повторная финализация того же хода → запись не дублируется', async () => {
      const sessionId = await makeSession();
      const deps = makeDeps();

      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);
      await runProcessFinalize(makeArgs(sessionId), makeState(), deps);

      expect(await stopRecords(sessionId)).toHaveLength(1);
    });

    it('отказ прав (session.denied_blocked) → запись reason=denied, ровно одна', async () => {
      const sessionId = await makeSession();

      await runProcessFinalize(
        makeArgs(sessionId),
        // Ход не отменён, но модель не дала ответа, а отказ прав закрыл
        // финализацию: фоллбек `session.denied_blocked` → статус `stopped`.
        makeState({ cancelledBeforeFinal: false, finalContent: '', hadDeny: true }),
        makeDeps(),
      );

      const records = await stopRecords(sessionId);
      expect(records).toHaveLength(1);
      expect(records[0]!.metadata?.reason).toBe('denied');
      expect(records[0]!.metadata?.turn_id).toBe('turn1');
      expect(records[0]!.metadata?.stream_id).toBe('stream1');
    });
  });
});
