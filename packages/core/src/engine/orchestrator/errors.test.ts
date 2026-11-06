/**
 * ADR-095 (шаг 6a): собственные тесты обработки ошибок LLM-стрима.
 *
 * Контракты:
 *  - `formatLlmError`/`errorTypeI18n` — таксономия ADR-041 (i18n-ключ больше не
 *    пишется в metadata: сообщения нет);
 *  - `handleLlmFailure` **не создаёт assistant-сообщение** об ошибке (решение
 *    владельца 2026-11-06): в истории/ленте после reload ничего не остаётся;
 *  - расход неудавшегося вызова учитывается как aux `llm-error` **только**
 *    когда повтора не будет (`!canRetry || attempt === undefined || attempt > MAX`),
 *    иначе на каждый ретрай счётчики получали бы дубль (ADR-102);
 *  - `last_error` пишется в user-сообщение по `metadata.stream_id`;
 *  - ошибки учёта/персистентности не выносят ход.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, TokenUsage } from '@itphx/synth-shared';
import type { AuxUsageRecorder } from '../usage-accounting.js';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import {
  ContextLengthExceededError,
  ProviderError,
  RemoteAuthExpiredError,
} from '../../providers/exceptions.js';
import { LLM_MAX_ATTEMPTS } from '../llm-error.js';
import { RemoteError } from '../../remote/types.js';
import { t as sm } from '../system-messages.js';
import { formatLlmError, errorTypeI18n, handleLlmFailure, type LlmFailureContext } from './errors.js';

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

  it('RemoteAuthExpiredError → ключ router.remote_auth_expired; прочие auth-ошибки — без i18n', () => {
    expect(formatLlmError(new RemoteAuthExpiredError('p'))).toEqual({
      text: sm('router.remote_auth_expired'),
      i18n: { key: 'router.remote_auth_expired' },
    });
    // Истёкший API-ключ провайдера (не гибрид) не должен выдавать «сессия истекла».
    expect(formatLlmError(new ProviderError('invalid api key'))).toEqual({
      text: 'invalid api key',
    });
  });

  it('гибрид: RemoteError(OFFLINE) → router.network_error (не русский текст авторизации)', () => {
    expect(formatLlmError(new RemoteError('Сервер авторизации недоступен: fetch failed', 'OFFLINE'))).toEqual({
      text: sm('router.network_error'),
      i18n: { key: 'router.network_error' },
    });
  });

  it('errorTypeI18n: ключ только для известных типов', () => {
    expect(errorTypeI18n('timeout')).toEqual({ key: 'router.timeout' });
    expect(errorTypeI18n('network_error')).toEqual({ key: 'router.network_error' });
    expect(errorTypeI18n('rate_limit')).toEqual({ key: 'router.rate_limit_exceeded' });
    expect(errorTypeI18n('context_length')).toEqual({ key: 'router.context_length_exceeded' });
    expect(errorTypeI18n('no_user_query')).toEqual({ key: 'router.no_user_query' });
    expect(errorTypeI18n('provider_not_found')).toEqual({ key: 'router.provider_not_found' });
    expect(errorTypeI18n('remote_auth_expired')).toEqual({ key: 'router.remote_auth_expired' });
    expect(errorTypeI18n('unknown')).toBeUndefined();
    expect(errorTypeI18n('auth_error')).toBeUndefined();
  });
});

describe('handleLlmFailure', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let recordUsage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-errors-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    recordUsage = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function deps() {
    return {
      sessionManager,
      recordUsage: recordUsage as unknown as AuxUsageRecorder,
    };
  }

  function context(overrides: Partial<LlmFailureContext> = {}): LlmFailureContext {
    return { durationMs: 123, ...overrides };
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

  it('recoverable + не последняя попытка: расход не пишется, сообщения нет', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('fetch failed'), 1, context(), deps(),
    );

    expect(result).toEqual({
      error: sm('router.network_error'),
      errorType: 'network_error',
      canRetry: true,
    });
    expect(recordUsage).not.toHaveBeenCalled();
    expect((await sessionManager.getSession(sessionId))!.messages).toHaveLength(1);
  });

  it('попытки исчерпаны (attempt > LLM_MAX_ATTEMPTS): расход — aux llm-error, сообщения нет', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('fetch failed'), LLM_MAX_ATTEMPTS + 1,
      context({ model: 'm', providerName: 'p', agentRole: 'fixer', promptChars: 40, content: 'частично' }),
      deps(),
    );

    expect(result.canRetry).toBe(true);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    const input = recordUsage.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      sessionId,
      model: 'm',
      provider: 'p',
      agent: 'fixer',
      durationMs: 123,
      source: 'llm-error',
    });
    // best-effort оценка usage: promptChars/4 и content.length/4
    expect(input.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    // сообщения об ошибке нет — только user-реплика
    expect((await sessionManager.getSession(sessionId))!.messages).toHaveLength(1);
  });

  it('attempt === undefined (прямой вызов без QueueProcessor) — терминальный путь', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    await handleLlmFailure(sessionId, 'stream1', new Error('fetch failed'), undefined, context(), deps());

    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('невосполнимая ошибка (401) терминальна даже на первой попытке', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, context(), deps(),
    );

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('usage = turnUsage (предыдущие шаги) + оценка текущего вызова', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1,
      context({
        usage: USAGE,
        turnUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }),
      deps(),
    );

    const input = recordUsage.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.usage).toEqual({ inputTokens: 6, outputTokens: 7, totalTokens: 13 });
  });

  it('гибрид: RemoteError(OFFLINE) → network_error, recoverable; расхода нет', async () => {
    const sessionId = await sessionWithUserMessage('stream1');
    const err = new RemoteError('Сервер авторизации недоступен: fetch failed', 'OFFLINE');

    const result = await handleLlmFailure(sessionId, 'stream1', err, 1, context(), deps());

    expect(result).toEqual({
      error: sm('router.network_error'),
      errorType: 'network_error',
      canRetry: true,
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('гибрид: RemoteError(AUTH) → remote_auth_expired, терминально (просьба войти заново)', async () => {
    const sessionId = await sessionWithUserMessage('stream1');
    const err = new RemoteError('Не удалось обновить токен: refresh token недействителен или истёк', 'AUTH');

    const result = await handleLlmFailure(sessionId, 'stream1', err, 1, context(), deps());

    expect(result).toMatchObject({ errorType: 'remote_auth_expired', canRetry: false });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ source: 'llm-error' });
  });

  it('ContextLengthExceededError определяется по классу (русский текст не классифицируется)', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new ContextLengthExceededError(), 1, context(), deps(),
    );

    expect(result).toMatchObject({ errorType: 'context_length', canRetry: false });
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('ctx.errorType приоритетнее классификации по тексту', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('Provider my-provider not found or not configured'), 1,
      context({ errorType: 'provider_not_found' }),
      deps(),
    );

    expect(result).toMatchObject({ errorType: 'provider_not_found', canRetry: false });
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

  it('ошибка учёта расхода не выносит обработку', async () => {
    const sessionId = await sessionWithUserMessage('stream1');
    recordUsage.mockRejectedValueOnce(new Error('analytics down'));

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, context({ usage: USAGE }), deps(),
    );

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    // last_error всё равно записан
    expect((await sessionManager.getSession(sessionId))!.messages[0]!.metadata!.last_error).toBe('401 Unauthorized');
  });

  it('без ctx расхода нет, но исход ошибки возвращается', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(sessionId, 'stream1', new Error('401 Unauthorized'), 1, undefined, deps());

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('без recordUsage (необязательный dep) терминальный путь не падает', async () => {
    const sessionId = await sessionWithUserMessage('stream1');

    const result = await handleLlmFailure(
      sessionId, 'stream1', new Error('401 Unauthorized'), 1, context(),
      { sessionManager },
    );

    expect(result).toMatchObject({ errorType: 'auth_error', canRetry: false });
    expect((await sessionManager.getSession(sessionId))!.messages).toHaveLength(1);
  });
});
