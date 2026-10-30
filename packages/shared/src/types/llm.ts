/**
 * ADR-036/ADR-072: дефолт rate limit LLM Gateway. Единый источник для Zod-схемы
 * конфига и runtime-дефолтов (settings-роуты, fallback'и backend/core).
 */
export const DEFAULT_LLM_GATEWAY_RATE_LIMIT = {
  userPerMinute: 60,
  providerPerMinute: 120,
} as const;

// --- LLM ---
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LLMChunk {
  content: string;
  isFinal: boolean;
  usage?: TokenUsage;
  toolCalls?: Record<string, unknown>[];
  reasoning?: string;
  /**
   * Anthropic-протокол: подпись thinking-блока (`signature`). Без возврата этой
   * подписи в историю Anthropic отвергает следующий запрос tool-loop
   * («Expected `thinking`…»). Пустая строка — валидная подпись (RouterAI/qwen
   * отдают `"signature": ""`). Аддитивное поле: остальные провайдеры его не
   * заполняют.
   */
  reasoningSignature?: string;
  /**
   * Anthropic-протокол: opaque-данные блоков `redacted_thinking` (verbatim
   * `data`) — реплеятся в историю без изменений.
   */
  reasoningRedacted?: string[];
  model?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  toolCalls?: Record<string, unknown>[];
  reasoning?: string;
  /** Anthropic: подпись thinking-блока (см. `LLMChunk.reasoningSignature`). */
  reasoningSignature?: string;
  /** Anthropic: opaque-данные `redacted_thinking` (см. `LLMChunk.reasoningRedacted`). */
  reasoningRedacted?: string[];
  debugInfo?: Record<string, unknown>;
}
