import { describe, it, expect } from 'vitest';
import {
  classifyLlmError,
  classifyLlmErrorFor,
  isLlmErrorRecoverable,
  LLM_MAX_ATTEMPTS,
  LLM_RETRY_DELAYS_MS,
} from './llm-error.js';
import { ContextLengthExceededError, RemoteAuthExpiredError } from '../providers/exceptions.js';
import { RemoteError } from '../remote/types.js';
import { t as sm } from './system-messages.js';

describe('classifyLlmError — единая таксономия типов', () => {
  it('классифицирует recoverable-ошибки', () => {
    expect(classifyLlmError('rate limit exceeded')).toBe('rate_limit');
    expect(classifyLlmError('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyLlmError('timeout')).toBe('timeout');
    expect(classifyLlmError('fetch failed: ECONNREFUSED')).toBe('network_error');
    expect(classifyLlmError('502 Bad Gateway')).toBe('server_error');
    expect(classifyLlmError('503 Service Unavailable')).toBe('server_error');
  });

  it('классифицирует unrecoverable-ошибки', () => {
    expect(classifyLlmError('401 Unauthorized')).toBe('auth_error');
    expect(classifyLlmError('model not found')).toBe('model_not_found');
    expect(classifyLlmError('context length exceeded')).toBe('context_length');
    expect(classifyLlmError('неизвестное')).toBe('unknown');
  });

  it('распознаёт потерю исходного запроса в tool-цепочке (no_user_query)', () => {
    expect(
      classifyLlmError('Bad request: {"detail":"no user query found in messages"}'),
    ).toBe('no_user_query');
    expect(
      classifyLlmError('Ollama bad request: {"detail":"no user query found in messages"}'),
    ).toBe('no_user_query');
    // регистронезависимо
    expect(classifyLlmError('NO USER QUERY FOUND IN MESSAGES')).toBe('no_user_query');
  });

  it('400 с телом «Internal Server Error» — серверный сбой (server_error)', () => {
    // Шлюз (LiteLLM-совместимый) отдаёт 400 с «Internal Server Error» — падение
    // апстрима, а не некорректный запрос. Реальный текст из прод-инстанса:
    expect(
      classifyLlmError(
        'Bad request: {"detail":"Internal Server Error (request_id: 52993302-6b57-4e69-983e-244315f0ca3d)"}',
      ),
    ).toBe('server_error');
    expect(classifyLlmError('Internal Server Error')).toBe('server_error');
  });

  it('«Internal Server Error» не перебивает более специфичные типы', () => {
    expect(
      classifyLlmError('Bad request: {"detail":"Internal Server Error (request_id: x)"} 401'),
    ).toBe('auth_error');
    expect(
      classifyLlmError('context length exceeded (Internal Server Error)'),
    ).toBe('context_length');
  });
});

describe('isLlmErrorRecoverable — серверный сбой в 400-обёртке', () => {
  const gateway400 =
    'Bad request: {"detail":"Internal Server Error (request_id: 52993302-6b57-4e69-983e-244315f0ca3d)"}';

  it('восстановим: провайдер-слой добавляет «Bad request: » ЛЮБОМУ 400', () => {
    const type = classifyLlmError(gateway400);
    expect(type).toBe('server_error');
    expect(isLlmErrorRecoverable(new Error(gateway400), gateway400, type)).toBe(true);
  });

  it('восстановим и без переданного errorType (по телу)', () => {
    expect(isLlmErrorRecoverable(new Error(gateway400), gateway400)).toBe(true);
  });

  it('настоящий клиентский 400 остаётся невосстановимым', () => {
    const bad = 'Bad request: {"detail":"invalid schema for tool call"}';
    const type = classifyLlmError(bad);
    expect(type).toBe('unknown');
    expect(isLlmErrorRecoverable(new Error(bad), bad, type)).toBe(false);
  });

  it('no_user_query (потеря user-реплики) остаётся невосстановимым', () => {
    const bad = 'Bad request: {"detail":"no user query found in messages"}';
    const type = classifyLlmError(bad);
    expect(type).toBe('no_user_query');
    expect(isLlmErrorRecoverable(new Error(bad), bad, type)).toBe(false);
  });

  it('auth_error остаётся невосстановимым даже при упоминании internal server error', () => {
    const bad = 'Bad request: {"detail":"Internal Server Error"} 401 Unauthorized';
    const type = classifyLlmError(bad);
    expect(type).toBe('auth_error');
    expect(isLlmErrorRecoverable(new Error(bad), bad, type)).toBe(false);
  });
});

describe('router.remote_auth_expired — истёкшая сессия гибрида', () => {
  const msg = sm('router.remote_auth_expired');

  it('по тексту — legacy auth_error (старые/текстовые пути)', () => {
    expect(classifyLlmError(msg)).toBe('auth_error');
  });

  it('невосстановимая (без 3 бесполезных ретраев)', () => {
    expect(isLlmErrorRecoverable(new Error(msg), msg)).toBe(false);
    expect(isLlmErrorRecoverable(new Error(msg), msg, 'auth_error')).toBe(false);
    expect(isLlmErrorRecoverable(new Error(msg), msg, 'remote_auth_expired')).toBe(false);
    expect(isLlmErrorRecoverable(new RemoteAuthExpiredError())).toBe(false);
  });
});

describe('classifyLlmErrorFor — типизированные remote-ошибки гибрида', () => {
  it('RemoteError(OFFLINE) → network_error (recoverable)', () => {
    const err = new RemoteError('Сервер авторизации недоступен: fetch failed', 'OFFLINE');
    expect(classifyLlmErrorFor(err)).toBe('network_error');
    expect(isLlmErrorRecoverable(err)).toBe(true);
  });

  it('RemoteError(AUTH/UNAUTHORIZED) → remote_auth_expired (терминально)', () => {
    expect(classifyLlmErrorFor(new RemoteError('Не удалось обновить токен', 'AUTH'))).toBe('remote_auth_expired');
    expect(classifyLlmErrorFor(new RemoteError('401', 'UNAUTHORIZED'))).toBe('remote_auth_expired');
    expect(isLlmErrorRecoverable(new RemoteError('x', 'AUTH'))).toBe(false);
    expect(isLlmErrorRecoverable(new RemoteError('x', 'UNAUTHORIZED'))).toBe(false);
  });

  it('RemoteAuthExpiredError → remote_auth_expired (даже если текст локализован)', () => {
    expect(classifyLlmErrorFor(new RemoteAuthExpiredError())).toBe('remote_auth_expired');
  });

  it('русский текст ошибки гибрида: classify + errorType → без ретраев', () => {
    // Русская формулировка не содержит английских auth-паттернов — именно
    // `errorType` из `classifyLlmErrorFor` делает ошибку невосстановимой.
    const expired = new RemoteAuthExpiredError('Сессия на сервере истекла — войдите в гибрид заново');
    const expiredType = classifyLlmErrorFor(expired);
    expect(expiredType).toBe('remote_auth_expired');
    expect(isLlmErrorRecoverable(expired, expired.message, expiredType)).toBe(false);

    const auth = new RemoteError('Не удалось обновить токен: refresh token недействителен', 'AUTH');
    const authType = classifyLlmErrorFor(auth);
    expect(authType).toBe('remote_auth_expired');
    expect(isLlmErrorRecoverable(auth, auth.message, authType)).toBe(false);
  });

  it('прочие ошибки — по тексту через classifyLlmError', () => {
    expect(classifyLlmErrorFor(new Error('429 Too Many Requests'))).toBe('rate_limit');
    expect(classifyLlmErrorFor('fetch failed: ECONNREFUSED')).toBe('network_error');
  });
});

describe('isLlmErrorRecoverable — объединённый набор паттернов', () => {
  // Представительные строки из бывшего списка llm-error.ts (auth/model/key).
  it.each([
    'model not found',
    'model_not_found',
    'model does not exist',
    'invalid model selected',
    'unknown model',
    'invalid api key',
    'incorrect api key',
    'HTTP 401',
    'authentication required',
    'unauthorized',
  ])('паттерн llm-error.ts: %s → unrecoverable (false)', (msg) => {
    expect(isLlmErrorRecoverable(new Error(msg))).toBe(false);
  });

  // Представительные строки из бывшего списка queue/processor.ts._isRecoverable
  // (валидация/десериализация/type).
  it.each([
    'missing field: name',
    'failed to deserialize',
    'invalid type: expected string',
    'unknown field',
    'bad request',
    'validation error',
    'err_invalid_arg_type',
    'cannot read properties of undefined',
    'x is not a function',
    'y is not defined',
  ])('паттерн processor.ts: %s → unrecoverable (false)', (msg) => {
    expect(isLlmErrorRecoverable(undefined, msg)).toBe(false);
  });

  // Потеря исходного запроса в tool-цепочке не ретраится ни по тексту, ни по типу.
  it.each([
    'Bad request: {"detail":"no user query found in messages"}',
    'Ollama bad request: {"detail":"no user query found in messages"}',
  ])('no_user_query по тексту: %s → unrecoverable (false)', (msg) => {
    expect(isLlmErrorRecoverable(new Error(msg), msg, 'no_user_query')).toBe(false);
  });

  // ADR-117: стрим без `finish_reason` — incomplete-stream, повтор не помогает.
  it.each([
    'Провайдер закрыл стрим без finish_reason (model=gpt-4o)',
    'OpenAI Chat stream ended without finish_reason',
  ])('отсутствие finish_reason: %s → unrecoverable (false)', (msg) => {
    expect(isLlmErrorRecoverable(new Error(msg), msg)).toBe(false);
  });

  // Recoverable-строки должны остаться восполняемыми.
  it.each([
    'fetch failed: ECONNREFUSED',
    '503 Service Unavailable',
    'rate limit exceeded',
    'AbortError: This operation was aborted',
    'request timed out',
    'connection reset',
    'неизвестная ошибка',
  ])('recoverable-строка: %s → true', (msg) => {
    expect(isLlmErrorRecoverable(new Error(msg), msg)).toBe(true);
  });

  it('использует error.message при отсутствии errMsg', () => {
    expect(isLlmErrorRecoverable(new Error('invalid api key'))).toBe(false);
    expect(isLlmErrorRecoverable(new Error('fetch failed'))).toBe(true);
  });

  it('использует String(error) для не-Error значений', () => {
    expect(isLlmErrorRecoverable('401 Unauthorized')).toBe(false);
    expect(isLlmErrorRecoverable('timeout')).toBe(true);
  });
});

describe('isLlmErrorRecoverable — приоритет errorType', () => {
  // errorType из UNRECOVERABLE_TYPES -> false, даже если текст их не содержит.
  it.each(['context_length', 'auth_error', 'remote_auth_expired', 'model_not_found', 'provider_not_found', 'validation', 'no_user_query'])(
    'errorType=%s → false даже без совпадения по тексту',
    (type) => {
      expect(isLlmErrorRecoverable(new Error('argle bargle'), 'argle bargle', type)).toBe(false);
    },
  );

  // recoverable-типы в errorType → true (текст не содержит паттернов).
  it.each(['timeout', 'network_error', 'rate_limit', 'server_error', 'unknown'])(
    'errorType=%s → true',
    (type) => {
      expect(isLlmErrorRecoverable(new Error('argle bargle'), 'argle bargle', type)).toBe(true);
    },
  );

  it('errorType=context_length побеждает даже при recoverable-тексте', () => {
    expect(isLlmErrorRecoverable(new Error('fetch failed'), 'fetch failed', 'context_length')).toBe(false);
  });
});

describe('isLlmErrorRecoverable — ContextLengthExceededError', () => {
  it('возвращает false по классу ошибки (не по тексту)', () => {
    // Текст «too long» НЕ входит в UNRECOVERABLE_PATTERNS — решает именно класс.
    expect(isLlmErrorRecoverable(new ContextLengthExceededError('too long'))).toBe(false);
    expect(isLlmErrorRecoverable(new ContextLengthExceededError('Контекстное окно превышено'))).toBe(false);
  });
});

describe('isLlmErrorRecoverable — ошибка шаблона сжатия', () => {
  // Компактизация: модель вернула ответ не по шаблону. Повтор того же вызова
  // не помогает — ошибка терминальная (`validation` в UNRECOVERABLE_TYPES),
  // иначе QueueProcessor ретраит служебное сообщение суммаризации, пока
  // очередь не встанет.
  const msg = 'Compression response does not match the required template';

  it('errorType=validation → невосстановимая (canRetry=false)', () => {
    expect(isLlmErrorRecoverable(new Error(msg), msg, 'validation')).toBe(false);
  });

  it('без errorType текст не распознаётся как паттерн (нужен явный тип)', () => {
    // Фиксирует зависимость от errorType: классификатор по тексту молчит.
    expect(isLlmErrorRecoverable(new Error(msg), msg)).toBe(true);
  });
});

describe('Политика ретрая — единые константы', () => {
  it('LLM_MAX_ATTEMPTS = 3', () => {
    expect(LLM_MAX_ATTEMPTS).toBe(3);
  });

  it('LLM_RETRY_DELAYS_MS = [5000, 15000, 30000]', () => {
    expect(LLM_RETRY_DELAYS_MS).toEqual([5000, 15000, 30000]);
  });
});
