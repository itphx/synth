import type { AttachmentModality } from '../model-metadata.js';

// --- Currency ---
/** Валюта цен моделей. Отсутствует у модели → валюта провайдера → USD. */
export const CURRENCIES = ['RUB', 'USD', 'CNY'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Проверка, что значение — допустимая валюта (RUB/USD/CNY). */
export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** Ленивый разбор валюты: неизвестное значение → undefined. */
export function parseCurrency(value: unknown): Currency | undefined {
  return isCurrency(value) ? value : undefined;
}

/** Результат строгого разбора поля `currency` из тела запроса. */
export type CurrencyInputResult =
  | { ok: true; currency: Currency | undefined }
  | { ok: false };

/**
 * Строгий разбор поля `currency`:
 * - `undefined` — поле не передано (сохранить existing);
 * - `null`/`''` — явно очистить (undefined);
 * - валидная валюта — принять;
 * - иная непустая строка — ошибка (`ok: false`), чтобы не терять значение молча.
 */
export function parseCurrencyInput(raw: unknown, existing?: Currency): CurrencyInputResult {
  if (raw === null || raw === '') return { ok: true, currency: undefined };
  if (raw === undefined) return { ok: true, currency: existing };
  return isCurrency(raw) ? { ok: true, currency: raw } : { ok: false };
}

/** Присутствуют ли в теле запроса ценовые поля (snake_case или camelCase). */
export function hasPriceInput(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return 'input_price' in b || 'inputPrice' in b
    || 'output_price' in b || 'outputPrice' in b
    || 'cache_read_price' in b || 'cacheReadPrice' in b
    || 'cache_write_price' in b || 'cacheWritePrice' in b;
}

// --- Совместимость провайдеров/моделей (слой как в opencode) ---

/**
 * Поле лимита вывода в теле запроса OpenAI-совместимого протокола.
 *
 * Наш дефолт — `max_tokens` (намеренное отличие от opencode, где дефолт
 * `max_completion_tokens`): локальные и кастомные OpenAI-совместимые серверы
 * часто не знают `max_completion_tokens`, и молчаливая смена дефолта ломала бы
 * их. `max_completion_tokens` отправляется только при **явном** значении.
 */
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

/**
 * Формат inline-маркеров prompt-cache в теле OpenAI-совместимого запроса
 * (`cache_control: { type: 'ephemeral' }` на частях контента и на
 * tool-дефинишнах) — аналог `cacheFormat` в opencode
 * (`packages/ai/src/cache-policy.ts`).
 *
 *  - `anthropic` — полный AUTO-набор: последний tool-дефинишн, system-блок и
 *    граница последнего сообщения (`tail: 1`);
 *  - `alibaba` — QWEN-набор: system-блок и граница последнего сообщения,
 *    **без** маркера на tools (Qwen кеширует tools вместе с system-промптом и
 *    игнорирует маркеры на дефинишнах).
 *
 * Не задан — inline-маркеры не ставятся, работает прежний механизм:
 * implicit prefix caching через `prompt_cache_key`.
 */
export type CacheFormat = 'anthropic' | 'alibaba';

/** Канонические значения `cacheFormat` (для валидации входных данных API). */
export const CACHE_FORMATS = ['anthropic', 'alibaba'] as const;

/** Проверка, что значение — допустимый формат inline-маркеров кэша. */
export function isCacheFormat(value: unknown): value is CacheFormat {
  return typeof value === 'string' && (CACHE_FORMATS as readonly string[]).includes(value);
}

/**
 * Явные особенности протокола провайдера/модели (аналог `Compatibility` в
 * opencode, `packages/schema/src/model-compatibility.ts`).
 *
 * Один и тот же контракт объявлен на двух уровнях: `ProviderConfig.compatibility`
 * (дефолты для всех моделей провайдера) и `ModelConfig.compatibility`
 * (перекрывает провайдерские поля точечно).
 */
export interface ModelCompatibility {
  /**
   * Имя поля reasoning в assistant-сообщениях openai-chat.
   * По умолчанию `'reasoning_content'` (DeepSeek); OpenRouter/RouterAI — `'reasoning'`.
   */
  reasoningField?: string;
  /**
   * Требовать поле reasoning у **каждого** assistant-сообщения, даже пустым
   * (thinking-режим DeepSeek: `reasoning_content` обязателен в истории).
   */
  requireReasoning?: boolean;
  /** Поле лимита вывода: `max_tokens` (дефолт) | `max_completion_tokens` (только явно). */
  maxTokensField?: MaxTokensField;
  /** Провайдеру нужен assistant-турн после tool-результатов (Mistral-семейство). */
  requireAssistantAfterTool?: boolean;
  /**
   * Отправлять `stream_options: {include_usage: true}` в стриме
   * (OpenAI-совместимые). Дефолт `true` — как в opencode.
   */
  streamUsage?: boolean;
  /**
   * Провайдер понимает `tool_choice`. Дефолт `true`; для нативного Ollama
   * `/api/chat` — `false` (эвристика по `type: 'ollama'`).
   */
  supportsToolChoice?: boolean;
  /**
   * Формат inline-маркеров prompt-cache (`cache_control`). Не задан — маркеры
   * не ставятся, кэш работает через implicit prefix caching
   * (`prompt_cache_key`). Задан — маркеры ставятся, а `prompt_cache_key` **не
   * отправляется**: это разные механизмы, и провайдер, ориентированный на
   * inline-маркеры, полагается только на них (как в opencode).
   *
   * Бюджет — не больше 4 breakpoint'ов на запрос (как `BREAKPOINT_CAP`).
   */
  cacheFormat?: CacheFormat;
  /**
   * Требовать `finish_reason` в стриме OpenAI-совместимого протокола.
   * Дефолт **`true`** (как в opencode, `packages/ai/src/protocols/openai-chat.ts`):
   * провайдер, закрывший стрим без `finish_reason`, — недописанный ответ
   * (incomplete-stream). `false` — прежнее толерантное поведение (стрим
   * считается завершённым).
   */
  requireFinishReason?: boolean;
}

/**
 * Дефолты провайдера, наследуемые моделями. Набор полей совпадает с
 * `ModelCompatibility`; отдельный алиас оставлен, чтобы смысл был явным.
 */
export type ProviderCompatibility = ModelCompatibility;

/**
 * Полностью разрешённая совместимость: каждое поле заполнено — явное значение
 * модели → явное значение провайдера → эвристика (или встроенный дефолт).
 */
export interface ResolvedModelCompatibility {
  reasoningField: string;
  requireReasoning: boolean;
  maxTokensField: MaxTokensField;
  requireAssistantAfterTool: boolean;
  streamUsage: boolean;
  supportsToolChoice: boolean;
  requireFinishReason: boolean;
  /**
   * Формат inline-маркеров кэша; `undefined` — маркеры не ставятся (в отличие
   * от прочих полей, «не задано» здесь — осмысленное состояние, а не дефолт).
   */
  cacheFormat?: CacheFormat;
}

/** Контекст, по которому считаются эвристики совместимости. */
export interface CompatibilityContext {
  /** Тип провайдера (`openai`/`ollama`/`deepseek`/…). */
  providerType?: string;
  /** Имя провайдера как в конфиге. */
  providerName?: string;
  /** Базовый URL (для эвристик вида `deepseek.com`). */
  baseUrl?: string;
  /** Идентификатор модели. */
  modelId?: string;
}

/** Эвристические значения совместимости (применяются только без явных). */
export type CompatibilityHeuristics = Partial<ResolvedModelCompatibility>;

/** Ключи контракта — для валидации входных данных API. */
export const MODEL_COMPATIBILITY_KEYS = [
  'reasoningField',
  'requireReasoning',
  'maxTokensField',
  'requireAssistantAfterTool',
  'streamUsage',
  'supportsToolChoice',
  'cacheFormat',
  'requireFinishReason',
] as const;

/**
 * Эвристики совместимости — те же, что в opencode
 * (`packages/ai/src/protocols/openai-chat.ts`):
 *
 *  - `requireReasoning`: тип/имя провайдера `deepseek`, URL ~ `deepseek.com`,
 *    модель ~ `deepseek`;
 *  - `requireAssistantAfterTool`: Mistral-семейство (`mistral`, `devstral`,
 *    `codestral`, `pixtral`, `mixtral`);
 *  - `supportsToolChoice`: `false` для нативного Ollama (`type: 'ollama'`).
 *
 * `maxTokensField` намеренно **не** эвристируется: наш дефолт — `max_tokens`,
 * `max_completion_tokens` только при явном значении (локальные серверы).
 */
export function detectCompatibilityHeuristics(
  context: CompatibilityContext,
): CompatibilityHeuristics {
  const type = (context.providerType ?? '').toLowerCase();
  const name = (context.providerName ?? '').toLowerCase();
  const url = (context.baseUrl ?? '').toLowerCase();
  const model = (context.modelId ?? '').toLowerCase();

  const requireReasoning = type === 'deepseek'
    || name === 'deepseek'
    || url.includes('deepseek.com')
    || model.includes('deepseek');

  const mistral = ['mistral', 'devstral', 'codestral', 'pixtral', 'mixtral']
    .some((family) => model.includes(family));

  return {
    requireReasoning,
    requireAssistantAfterTool: mistral,
    supportsToolChoice: type !== 'ollama',
  };
}

/**
 * Наложение слоёв совместимости: `undefined`-поля не перетирают значение.
 * Поздние слои приоритетнее (провайдер → shorthand → модель).
 */
export function mergeModelCompatibility(
  ...layers: Array<ModelCompatibility | undefined>
): ModelCompatibility {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as ModelCompatibility;
}

/**
 * Разрешение итоговой совместимости.
 *
 * Порядок: **явное значение модели → явное значение провайдера → эвристика →
 * встроенный дефолт**. `reasoningField`, заданный явно на любом уровне, сам по
 * себе означает `requireReasoning: true` (как в opencode) — если
 * `requireReasoning` не переопределён явно (в т.ч. `false`).
 */
export function resolveModelCompatibility(
  providerCompat?: ModelCompatibility,
  modelCompat?: ModelCompatibility,
  heuristics: CompatibilityHeuristics = {},
): ResolvedModelCompatibility {
  const explicitReasoningField = modelCompat?.reasoningField ?? providerCompat?.reasoningField;
  const explicitRequireReasoning = modelCompat?.requireReasoning ?? providerCompat?.requireReasoning;
  const requireReasoning = explicitRequireReasoning
    ?? (explicitReasoningField !== undefined ? true : (heuristics.requireReasoning ?? false));

  return {
    reasoningField: explicitReasoningField ?? heuristics.reasoningField ?? 'reasoning_content',
    requireReasoning,
    maxTokensField: modelCompat?.maxTokensField
      ?? providerCompat?.maxTokensField
      ?? heuristics.maxTokensField
      ?? 'max_tokens',
    requireAssistantAfterTool: modelCompat?.requireAssistantAfterTool
      ?? providerCompat?.requireAssistantAfterTool
      ?? heuristics.requireAssistantAfterTool
      ?? false,
    streamUsage: modelCompat?.streamUsage
      ?? providerCompat?.streamUsage
      ?? heuristics.streamUsage
      ?? true,
    supportsToolChoice: modelCompat?.supportsToolChoice
      ?? providerCompat?.supportsToolChoice
      ?? heuristics.supportsToolChoice
      ?? true,
    // Дефолт — `true` (как в opencode): стрим без `finish_reason` считается
    // недописанным. Явный `false` возвращает толерантное поведение.
    requireFinishReason: modelCompat?.requireFinishReason
      ?? providerCompat?.requireFinishReason
      ?? heuristics.requireFinishReason
      ?? true,
    // Inline-маркеры кэша — только явным значением: эвристики по типу
    // провайдера не ставятся, иначе менялось бы поведение существующих записей.
    cacheFormat: modelCompat?.cacheFormat ?? providerCompat?.cacheFormat ?? heuristics.cacheFormat,
  };
}

/** Результат строгого разбора поля `compatibility` из тела запроса. */
export type CompatibilityInputResult =
  | { ok: true; value: ModelCompatibility | undefined }
  | { ok: false; reason: string };

/**
 * Строгий разбор `compatibility` из тела API. Семантика — **замена**:
 * - `undefined` — поле не передано (сохранить existing);
 * - `null` — явно сбросить;
 * - объект — **заменить** значение целиком (UI присылает полный объект из
 *   черновика, поэтому отсутствующее в объекте поле означает «авто», а не
 *   «оставить как было»); пустой объект равнозначен сбросу;
 * - неизвестные поля и значения неверного типа — ошибка (не терять опечатки
 *   молча); иное — ошибка.
 */
export function parseModelCompatibilityInput(
  raw: unknown,
  existing?: ModelCompatibility,
): CompatibilityInputResult {
  if (raw === undefined) return { ok: true, value: existing };
  if (raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'compatibility должен быть объектом или null' };
  }

  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(MODEL_COMPATIBILITY_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: `compatibility: неизвестное поле «${key}»` };
    }
  }

  // Присланный объект — полное новое значение: прежние поля не наследуются.
  const replaced: ModelCompatibility = {};

  if ('reasoningField' in input) {
    const value = input.reasoningField;
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, reason: 'compatibility.reasoningField должен быть непустой строкой' };
    }
    replaced.reasoningField = value.trim();
  }
  if ('maxTokensField' in input) {
    const value = input.maxTokensField;
    if (value !== 'max_tokens' && value !== 'max_completion_tokens') {
      return { ok: false, reason: 'compatibility.maxTokensField должен быть max_tokens или max_completion_tokens' };
    }
    replaced.maxTokensField = value;
  }
  if ('cacheFormat' in input) {
    const value = input.cacheFormat;
    if (!isCacheFormat(value)) {
      return { ok: false, reason: 'compatibility.cacheFormat должен быть anthropic или alibaba' };
    }
    replaced.cacheFormat = value;
  }
  for (const key of [
    'requireReasoning',
    'requireAssistantAfterTool',
    'streamUsage',
    'supportsToolChoice',
    'requireFinishReason',
  ] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'boolean') {
      return { ok: false, reason: `compatibility.${key} должен быть boolean` };
    }
    replaced[key] = value;
  }

  return { ok: true, value: Object.keys(replaced).length > 0 ? replaced : undefined };
}

// --- Provider ---
export interface ProviderConfig {
  name: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  timeout?: number;
  enabled?: boolean;
  icon?: string;
  /** Валюта по умолчанию для моделей провайдера. Отсутствует → USD. */
  currency?: Currency;
  /**
   * Размер контекстного окна провайдера (`num_ctx` Ollama). Опционально;
   * приоритетнее `ModelConfig.contextWindow`. Применяется только нативным
   * путём Ollama (`/api/chat`).
   */
  numCtx?: number;
  /**
   * Особенности протокола провайдера (дефолты для всех его моделей):
   * поле reasoning, лимит вывода, `stream_options`, поддержка `tool_choice`.
   * Модель перекрывает поля точечно (`ModelConfig.compatibility`).
   */
  compatibility?: ModelCompatibility;
}

export type ContextSource = 'api' | 'reference' | 'manual' | 'unknown';

/**
 * Источник цен модели: `api` — получены синхронизацией с провайдером,
 * `manual` — заданы пользователем вручную, `unknown` — не определены.
 */
export type PriceSource = 'api' | 'manual' | 'unknown';

export type ContextCategory = 'user' | 'role' | 'system';

export interface ContextFileInfo {
  filename: string;
  isSystem: boolean;
  isOverridden: boolean;
  category: ContextCategory;
  size: number;
  modifiedAt?: number;
  enabled?: boolean;
}

export interface ContextFileContent {
  filename: string;
  content: string;
  isSystem: boolean;
  isOverridden: boolean;
  category: ContextCategory;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  description?: string;
  enabled: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  contextSource?: ContextSource;
  maxOutputTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  /** Откуда взяты цены: `api` — синхронизация, `manual` — ручной ввод. */
  priceSource?: PriceSource;
  /** Валюта цен модели; отсутствует → валюта провайдера → USD. */
  currency?: Currency;
  /**
   * ADR-115: модальности входа модели (какие вложения она принимает).
   *
   * Источник истины — каталог провайдера (`architecture.input_modalities` при
   * синхронизации моделей, `POST /api/v2/models/fetch`) либо ручной override
   * (`POST /api/v2/models`). Не задано — модальности неизвестны: вложения
   * **не фильтруются** (ошибку непринятого типа вернёт провайдер);
   * захардкоженного справочника модальностей нет (решение 2026-10-27).
   */
  modalities?: AttachmentModality[];
  /**
   * Особенности протокола модели (перекрывает `ProviderConfig.compatibility`
   * по каждому полю). Например, для одной модели провайдера нужен
   * `max_completion_tokens`, для остальных — дефолт.
   */
  compatibility?: ModelCompatibility;
  /**
   * Shorthand для `compatibility.requireReasoning` (thinking-модели DeepSeek):
   * провайдер требует `reasoning_content` у assistant-сообщений;
   * `undefined` — автоопределение по провайдеру/имени модели, `false` —
   * принудительно выключить. Нормализация:
   * `compatibility.requireReasoning ?? requiresReasoning`.
   */
  requiresReasoning?: boolean;
}
