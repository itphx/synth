/**
 * ADR-095 (шаг 6a): собственные тесты обработки ошибок LLM-стрима.
 *
 * Контракты:
 *  - `formatLlmError`/`errorTypeI18n` — таксономия ADR-041 + i18n-ключ в metadata;
 *  - `handleLlmFailure` пишет assistant-сообщение об ошибке **только** когда
 *    повтора не будет (`!canRetry || attempt === undefined || attempt > MAX`),
 *    иначе на каждый ретрай в истории появлялся бы дубль (ADR-070 §2.6 Bug 1);
 *  - `last_error` пишется в user-сообщение по `metadata.stream_id`;
 *  - ошибки персистентности не выносят ход.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { DebugCollector } from '../../debug.js';
import { ContextLengthExceededError } from '../../providers/exceptions.js';
import { LLM_MAX_ATTEMPTS } from '../llm-error.js';
import { t as sm } from '../system-messages.js';
import { formatLlmError, errorTypeI18n, handleLlmFailure, type LlmFailureContext } from './errors.js';
import type { SaveAssistantMessageFn } from './persistence.js';

const USAGE: TokenUsage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

describe('formatLlmError / errorTypeI18n (ADR-041)', () => {
  it('abort/timeout → router.timeout, network → router.network_error, прочее — исходный текст', () => {
    for (const raw of ['AbortError: operation was aborted', 'request timed out', 'TIMEOUT']) {
      expect(formatLlmError(new Error(raw))).toEqual({
        text: sm('router.timeout'),
        i18n: { key: 'router.timeout' },
      });
    }
    for (const raw of ['fetch failed', 'network error', 'connect ECONNREFUSED', 'getaddrinfo ENOTFOUND', 'EAI_AGAIN']) {
      expect(formatLlmError(new Error(raw))).toEqual({
        text: sm('router.network_error'),
        i18n: { key: 'router.network_error' },
      });
    }
    expect(formatLlmError(new Error('401 Unauthorized'))).toEqual({ text: '401 Unauthorized' });
    expect(formatLlmError('строка-ошибка')).toEqual({ text: 'строка-ошибка' });
  });

  it('errorTypeI18n: ключ только для известных типов', () => {
    expect(errorTypeI18n('timeout')).toEqual({ key: 'router.timeout' });
    expect(errorTypeI18n('network_error')).toEqual({ key: 'router.network_error' });
    expect(errorTypeI18n('rate_limit')).toEqual({ key: 'router.rate_limit_exceeded' });
    expect(errorTypeI18n('context_length')).toEqual({ key: 'router.context_length_exceeded' });
    expect(errorTypeI18n('no_user_query')).toEqual({ key: 'router.no_user_query' });
    expect(errorTypeI18n('provider_not_found')).toEqual({ key: 'router.provider_not_found' });
    expect(errorTypeI18n('unknown')).toBeUndefined();
    expect(errorTypeI18n('auth_error')).toBeUndefined();
  });
});

describe('handleLlmFailure', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let saveAssistantMessage: ReturnType<typeof vi.fn>;
  let debugCollector: DebugCollector;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-errors-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    saveAssistantMessage = vi.fn(async () => 'error-message');
    debugCollector = new DebugCollector(false);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function deps() {
    return {
      sessionManager,
      saveAssistantMessage: saveAssistantMessage as unknown as SaveAssistantMessageFn,
    };
  }

  function context(overrides: Partial<LlmFailureContext> = {}): LlmFailureContext {
    return { debugCollector, durationMs: 123, ...overrides };
  }

  async function sessionWithUserMessage(streamId: string): Promise<string> {
    const session = await sessionManager.createSession({ title: 'E' });
    const userMessage: Message = {
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
      author: 'user',
      metadata: { stream_id: streamId },
    };
    await sessionManager.addMessage(session.id, userMessage);
    return session.id;
  }

  it('recoverable + не последняя попытка: сообщение об ошибке НЕ сохраняется', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('fetch failed'), 1, context(), deps(),
    );

    expect(result).toEqual({
      error: sm('router.network_error'),
      errorType: 'network_error',
      canRetry: true,
    });
    expect(saveAssistantMessage).not.toHaveBeenCalled();
    expect((await sessionManager.getSession(sessionId))!.messages).toHaveLength(1);
  });

  it('попытки исчерпаны (attempt > LLM_MAX_ATTEMPTS): сообщение сохраняется как терминальное', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('fetch failed'), LLM_MAX_ATTEMPTS + 1,
      context({ model: 'm', providerName: 'p', agentRole: 'developer', promptChars: 40, content: 'частично' }),
      deps(),
    );

    expect(result.canRetry).toBe(true);
    expect(saveAssistantMessage).toHaveBeenCalledTimes(1);
    const call = saveAssistantMessage.mock.calls[0]!;
    expect(call[0]).toBe(sessionId);
    expect(call[1]).toBe(sm('router.network_error'));
    expect(call[2]).toBe('stream1');
    expect(call[3]).toBe('developer');
    // best-effort оценка usage: promptChars/4 и content.length/4
    expect(call[4]).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(call[5]).toBe('m');
    expect(call[9]).toBe('p');
    expect(call[17]).toMatchObject({
      duration_ms: 123,
      status: 'error',
      i18n: { key: 'router.network_error' },
      usage_estimated: true,
    });
  });

  it('attempt === undefined (прямой вызов без QueueProcessor) — тоже терминальный путь', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    await handleLlmFailure(sessionId, 'stream1', new Error('fetch failed'), undefined, context(), deps());

    expect(saveAssistantMessage).toHaveBeenCalledTimes(1);
  });

  it('невосполнимая ошибка (401) терминальна даже на первой попытке', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, context(), deps(),
    );

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    expect(saveAssistantMessage).toHaveBeenCalledTimes(1);
  });

  it('ContextLengthExceededError определяется по классу (русский текст не классифицируется)', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new ContextLengthExceededError(), 1, context(), deps(),
    );

    expect(result).toMatchObject({ errorType: 'context_length', canRetry: false });
    const metadataExtra = saveAssistantMessage.mock.calls[0]![17];
    expect(metadataExtra).toMatchObject({ i18n: { key: 'router.context_length_exceeded' } });
  });

  it('ctx.errorType приоритетнее классификации по тексту', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('Provider my-provider not found or not configured'), 1,
      context({ errorType: 'provider_not_found' }),
      deps(),
    );

    expect(result).toMatchObject({ errorType: 'provider_not_found', canRetry: false });
    expect(saveAssistantMessage.mock.calls[0]![17]).toMatchObject({
      i18n: { key: 'router.provider_not_found' },
    });
  });

  it('last_error пишется в user-сообщение по stream_id, чужие сообщения не трогаются', async () => {
    const sessionId = await sessionWithUserMessage('stream1');
    // user-сообщение другого стрима
    await sessionManager.addMessage(sessionId, {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('другой ход')],
      content: 'другой ход',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { stream_id: 'other-stream', last_error: 'старое' },
    });

    await handleLlmFailure(sessionId, 'stream1', new Error('fetch failed'), 1, context(), deps());

    const messages = (await sessionManager.getSession(sessionId))!.messages;
    expect(messages[0]!.metadata!.last_error).toBe(sm('router.network_error'));
    expect(messages[1]!.metadata!.last_error).toBe('старое');
  });

  it('нет user-сообщения со stream_id — без ошибок и без записи', async () => {
    const session = await sessionManager.createSession({ title: 'Empty' });

    await expect(
      handleLlmFailure(session.id, 'nope', new Error('fetch failed'), 1, context(), deps()),
    ).resolves.toMatchObject({ errorType: 'network_error' });
    expect((await sessionManager.getSession(session.id))!.messages).toHaveLength(0);
  });

  it('ошибка сохранения assistant-сообщения не выносит обработку', async () => {
    const sessionId = await sessionWithUserMessage('stream1');
    saveAssistantMessage.mockRejectedValueOnce(new Error('storage down'));

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, context({ usage: USAGE }), deps(),
    );

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    // last_error всё равно записан
    expect((await sessionManager.getSession(sessionId))!.messages[0]!.metadata!.last_error).toBe('401 Unauthorized');
  });

  it('без ctx терминальный путь ничего не сохраняет, но возвращает исход ошибки', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(sessionId, 'stream1', new Error('401 Unauthorized'), 1, undefined, deps());

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    expect(saveAssistantMessage).not.toHaveBeenCalled();
  });

  it('фактический usage из ctx не помечается как оценённый', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1,
      context({ usage: USAGE, promptChars: 4_000, content: 'частичный ответ' }),
      deps(),
    );

    const call = saveAssistantMessage.mock.calls[0]!;
    expect(call[4]).toEqual(USAGE);
    expect(call[17]).not.toHaveProperty('usage_estimated');
  });
});
