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

  constructor(message = 'Контекстное окно превышено', debugResponse?: Record<string, unknown>) {
    super(message);
    this.name = 'ContextLengthExceededError';
    this.debugResponse = debugResponse;
  }
}

export class RateLimitError extends Error {
  retryAfter?: number;

  constructor(message = 'Превышен лимит запросов', retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}
