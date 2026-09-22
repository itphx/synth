import { CURRENCIES, type Currency } from '@itphx/synth-shared'

export type { Currency }

/** Валюта по умолчанию, если ни модель, ни провайдер не задали свою. */
export const DEFAULT_CURRENCY: Currency = 'USD'

/** Список поддерживаемых валют (общий с backend/core контракт). */
export const CURRENCY_OPTIONS: readonly Currency[] = CURRENCIES

/** Символы валют для компактного отображения. */
export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  RUB: '₽',
  USD: '$',
  CNY: '¥',
}

/** Нормализует произвольную строку к Currency; неизвестное — undefined. */
export function normalizeCurrency(currency?: string | null): Currency | undefined {
  return typeof currency === 'string' && (CURRENCIES as readonly string[]).includes(currency)
    ? (currency as Currency)
    : undefined
}

/** Символ валюты; отсутствует/неизвестна → '$' (USD). */
export function currencySymbol(currency?: string | null): string {
  return CURRENCY_SYMBOLS[normalizeCurrency(currency) ?? DEFAULT_CURRENCY]
}

/**
 * Форматирует цену в валюте с учётом локали. Fallback — компактный символ,
 * если Intl не знает валюту/локаль.
 */
export function formatMoney(value: number, currency?: string | null, locale?: string): string {
  const code = normalizeCurrency(currency) ?? DEFAULT_CURRENCY
  try {
    return new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 4,
    }).format(value)
  } catch {
    return `${currencySymbol(code)}${value.toFixed(2)}`
  }
}
