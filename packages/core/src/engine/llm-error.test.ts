import { describe, it, expect } from 'vitest';
import { classifyLlmError, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS } from './llm-error.js';
import { ContextLengthExceededError } from '../providers/exceptions.js';

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
  it.each(['context_length', 'auth_error', 'model_not_found', 'provider_not_found', 'validation'])(
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

describe('Политика ретрая — единые константы', () => {
  it('LLM_MAX_ATTEMPTS = 3', () => {
    expect(LLM_MAX_ATTEMPTS).toBe(3);
  });

  it('LLM_RETRY_DELAYS_MS = [5000, 15000, 30000]', () => {
    expect(LLM_RETRY_DELAYS_MS).toEqual([5000, 15000, 30000]);
  });
});
