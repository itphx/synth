import type { ReasoningLevel } from './session.js';

/**
 * ADR-036/ADR-072: дефолт rate limit LLM Gateway. Единый источник для Zod-схемы
 * конфига и runtime-дефолтов (settings-роуты, fallback'и backend/core).
 */
export const DEFAULT_LLM_GATEWAY_RATE_LIMIT = {
  userPerMinute: 60,
  providerPerMinute: 120,
} as const;

// --- LLM ---

/**
 * ADR-117: тир усилия модели (effort) — масштаб opencode
 * (`packages/ai/src/schema/options.ts`). Anthropic 5.x принимает его в
 * `output_config.effort`; передаётся из `ChatOptions.effort` (явно) либо
 * выводится из `reasoningLevel` (`effortForReasoningLevel`).
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Проверка, что значение — допустимый тир effort. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Маппинг `reasoningLevel` → `effort`.
 *
 * Только прямые соответствия `low|medium|high`; `default`/`none` — `undefined`
 * (параметр не отправляется), потому что «выключить размышления» через
 * effort-тир не выразить: у effort-моделей это другой режим, и выдумывать
 * значение нельзя. `xhigh`/`max` существуют только как явный `ChatOptions.effort`.
 */
export function effortForReasoningLevel(level?: ReasoningLevel): EffortLevel | undefined {
  if (level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return 'high';
  return undefined;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * Anthropic-протокол: один блок размышлений ответа. `signature` — подпись
 * thinking-блока, `redactedData` — opaque-данные `redacted_thinking`
 * (блок без видимого текста). Порядок элементов — порядок блоков в ответе.
 */
export interface LLMReasoningBlock {
  text: string;
  signature?: string;
  redactedData?: string;
}

export interface LLMChunk {
  content: string;
  isFinal: boolean;
  usage?: TokenUsage;
  toolCalls?: Record<string, unknown>[];
  reasoning?: string;
  /**
   * Anthropic: все блоки размышлений ответа (по блокам, с подписями).
   * `reasoning` — накопленный текст для UI/учёта токенов; подпись валидна
   * только для своего блока, поэтому при нескольких блоках реплей идёт отсюда.
   */
  reasoningBlocks?: LLMReasoningBlock[];
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
  /** Anthropic: блоки размышлений ответа (см. `LLMChunk.reasoningBlocks`). */
  reasoningBlocks?: LLMReasoningBlock[];
  /** Anthropic: подпись thinking-блока (см. `LLMChunk.reasoningSignature`). */
  reasoningSignature?: string;
  /** Anthropic: opaque-данные `redacted_thinking` (см. `LLMChunk.reasoningRedacted`). */
  reasoningRedacted?: string[];
  debugInfo?: Record<string, unknown>;
}
