import { t as sm } from '../engine/system-messages.js';

export class ProviderError extends Error {
  provider?: string;

  constructor(message: string, provider?: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
  }
}

/**
 * Нет токена для удалённого (гибридного) LLM-провайдера — чаще всего истекла
 * серверная сессия. Отдельный класс, чтобы i18n-ключ
 * `router.remote_auth_expired` применялся **только** к этой ситуации, а не к
 * любой auth-ошибке провайдера (ADR-041).
 */
export class RemoteAuthExpiredError extends ProviderError {
  constructor(message = sm('router.remote_auth_expired'), provider?: string) {
    super(message, provider);
    this.name = 'RemoteAuthExpiredError';
  }
}

export class ContextLengthExceededError extends Error {
  debugResponse?: Record<string, unknown>;

  constructor(message = sm('router.context_length_exceeded'), debugResponse?: Record<string, unknown>) {
    super(message);
    this.name = 'ContextLengthExceededError';
    this.debugResponse = debugResponse;
  }
}

export class RateLimitError extends Error {
  retryAfter?: number;

  constructor(message = sm('router.rate_limit_exceeded'), retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}
