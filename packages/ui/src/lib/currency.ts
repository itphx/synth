import { CURRENCIES, type Currency } from '@itphx/synth-shared/types'

export type { Currency }

/** Валюта по умолчанию, если ни модель, ни провайдер не задали свою. */
const DEFAULT_CURRENCY: Currency = 'USD'

/** Список поддерживаемых валют (общий с backend/core контракт). */
export const CURRENCY_OPTIONS: readonly Currency[] = CURRENCIES

/** Символы валют для компактного отображения. */
const CURRENCY_SYMBOLS: Record<Currency, string> = {
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

/**
 * Код/символ валюты для отображения. Известная валюта → символ (`₽`/`$`/`¥`),
 * неизвестный непустой код → сам код (не маскируем под `$`), пусто → `$` (USD).
 */
export function currencySymbol(currency?: string | null): string {
  const known = normalizeCurrency(currency)
  if (known) return CURRENCY_SYMBOLS[known]
  const raw = typeof currency === 'string' ? currency.trim() : ''
  return raw.length > 0 ? raw : CURRENCY_SYMBOLS[DEFAULT_CURRENCY]
}

/** Ключ группировки стоимости: известная валюта → код, неизвестный непустой → код, иначе USD. */
export function costCurrencyKey(currency?: string | null): string {
  const known = normalizeCurrency(currency)
  if (known) return known
  const raw = typeof currency === 'string' ? currency.trim() : ''
  return raw.length > 0 ? raw : DEFAULT_CURRENCY
}

/** Разворачивает экспоненциальную запись числа в обычную десятичную. */
function expandExponential(s: string): string {
  if (!/e/i.test(s)) return s
  const [mantissa, expStr] = s.split(/e/i)
  const exp = Number(expStr)
  const negative = mantissa!.startsWith('-')
  const [intPart, fracPart = ''] = mantissa!.replace('-', '').split('.')
  const digits = intPart! + fracPart
  const pointPos = intPart!.length + exp
  const sign = negative ? '-' : ''
  if (pointPos <= 0) return `${sign}0.${'0'.repeat(-pointPos)}${digits}`
  if (pointPos >= digits.length) return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
}

function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, '')
}

/**
 * Компактная статистическая запись: `~` + число + символ валюты (символ после
 * числа). Примеры: 0 → `~ 0 $`, 0.03 → `~ 0.03 $`, 1.234 → `~ 1.23 $`.
 */
function formatCompactMoney(value: number, currency?: string | null): string {
  const symbol = currencySymbol(currency)
  if (!Number.isFinite(value) || value <= 0) return `~ 0 ${symbol}`
  if (value >= 1) return `~ ${value.toFixed(2)} ${symbol}`
  if (value >= 0.01) {
    // 2–4 знака: минимум 2, хвостовые нули сверх двух отбрасываем.
    const fixed = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    const decimals = fixed.includes('.') ? fixed.split('.')[1]!.length : 0
    return `~ ${decimals < 2 ? value.toFixed(2) : fixed} ${symbol}`
  }
  // < 0.01: до 6 значимых цифр.
  const plain = trimTrailingZero(expandExponential(value.toPrecision(6)).replace(/0+$/, '').replace(/\.$/, ''))
  return `~ ${plain} ${symbol}`
}

export interface FormatMoneyOptions {
  /** Локаль для `Intl` (формы). По умолчанию `en`. */
  locale?: string
  /** Компактный статистический режим: `~` перед числом, символ после. */
  compact?: boolean
}

/**
 * Единая точка форматирования денег (AD-070 §2.6).
 *
 * - `compact: true` — компактная запись для статистики (`~ 0.03 $`);
 * - обычный режим — локализованный `Intl.NumberFormat` для форм.
 *
 * Неизвестный код валюты не маскируется под `$`: показывается сам код
 * (например, `0.03 EUR`). Известные валюты — символ/локальный формат.
 */
export function formatMoney(
  value: number,
  currency?: string | null,
  options?: FormatMoneyOptions,
): string {
  if (options?.compact) return formatCompactMoney(value, currency)

  const known = normalizeCurrency(currency)
  if (known) {
    try {
      return new Intl.NumberFormat(options?.locale || 'en', {
        style: 'currency',
        currency: known,
        maximumFractionDigits: 4,
      }).format(value)
    } catch {
      // Intl не знает валюту/локаль — падаем на компактную запись с кодом.
    }
  }
  const code = costCurrencyKey(currency)
  return `${value.toFixed(2)} ${code}`
}

/** C2b: приоритет валют в мультивалютной сумме: USD, RUB, CNY, затем прочие по алфавиту. */
const CURRENCY_ORDER: Record<string, number> = { USD: 0, RUB: 1, CNY: 2 }

/**
 * C2b: мультивалютная сумма. `{ USD: 0.03, RUB: 2.1 }` → `~ 0.03 $ · ~ 2.10 ₽`.
 * Нулевые/нечисловые значения отбрасываются; порядок валют стабильный
 * (USD, RUB, CNY, далее по алфавиту). Если положительных значений нет —
 * fallback на `fallbackUsd` как USD (старые данные без `cost_by_currency`),
 * иначе пустая строка.
 */
export function formatCostMap(
  map?: Record<string, number> | null,
  fallbackUsd?: number,
): string {
  const entries = map
    ? Object.entries(map).filter(([, value]) => Number.isFinite(value) && value > 0)
    : []
  if (entries.length > 0) {
    entries.sort(([a], [b]) => {
      const rankA = CURRENCY_ORDER[a] ?? Number.MAX_SAFE_INTEGER
      const rankB = CURRENCY_ORDER[b] ?? Number.MAX_SAFE_INTEGER
      return rankA !== rankB ? rankA - rankB : a.localeCompare(b)
    })
    return entries.map(([currency, value]) => formatCompactMoney(value, currency)).join(' · ')
  }
  if (fallbackUsd !== undefined) return formatCompactMoney(fallbackUsd)
  return ''
}
