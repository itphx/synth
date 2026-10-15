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
}
