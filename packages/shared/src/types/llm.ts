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
  model?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  toolCalls?: Record<string, unknown>[];
  reasoning?: string;
  debugInfo?: Record<string, unknown>;
}
