import type { ReasoningLevel } from './session.js';
import type { Currency } from './provider.js';

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
  /**
   * ADR-102/ADR-118 (паритет с opencode `Usage.cost`): стоимость вызова,
   * если провайдер вернул её сам. Приоритетнее каталожной цены модели.
   * `amount` в `currency`; `0` — достоверная нулевая стоимость.
   */
  cost?: {
    amount: number;
    currency: Currency;
  };
}

/**
 * Нормализованная причина завершения ответа модели (единый словарь для всех
 * протоколов).
 *
 * Зачем: провайдеры сообщают причину по-разному (`stop_reason` у Anthropic,
 * `finish_reason` у OpenAI-совместимых, `done_reason` у Ollama), а потребителю
 * (оркестратору) нужно отличать «модель ничего не сказала» от «ответ срезан
 * лимитом вывода»: при `max_tokens` пустой `content` — это не пустой ответ, а
 * исчерпанный бюджет (например, adaptive thinking съел весь `max_tokens`).
 *
 *  - `end_turn` — естественное завершение;
 *  - `tool_use` — модель просит вызвать инструмент;
 *  - `max_tokens` — ответ срезан лимитом вывода (в т.ч. весь ушёл в reasoning);
 *  - `stop_sequence` — сработала стоп-последовательность;
 *  - `length` — то же, что `max_tokens` (сырое значение Ollama/части API);
 *  - `content_filter` — завершение фильтром провайдера;
 *  - `error` — завершение по ошибке провайдера;
 *  - `unknown` — причина есть, но не распознана.
 */
export const LLM_FINISH_REASONS = [
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'length',
  'content_filter',
  'error',
  'unknown',
] as const;

export type LlmFinishReason = (typeof LLM_FINISH_REASONS)[number];

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
  /**
   * Причина завершения ответа (нормализованный словарь `LlmFinishReason`).
   * Аддитивное поле: заполняется адаптерами протоколов (Anthropic —
   * `stop_reason`, OpenAI — `finish_reason`, Ollama — `done_reason`), иначе
   * `undefined`. Значимо в финальном чанке (`isFinal: true`).
   */
  finishReason?: LlmFinishReason;
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
  /** Причина завершения ответа (см. `LLMChunk.finishReason`). */
  finishReason?: LlmFinishReason;
  debugInfo?: Record<string, unknown>;
}
