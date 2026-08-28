import { t as sm } from '../engine/system-messages.js';

export class ProviderError extends Error {
  provider?: string;

  constructor(message: string, provider?: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
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
