/**
 * PROP-102: период отчёта аналитики. Единица роллапа — **сутки UTC**, поэтому
 * границы считаются по UTC-дате (`YYYY-MM-DD`), а не по часовому поясу браузера:
 * `toISOString()` даёт UTC независимо от TZ.
 */

/** Пресеты периода в UI (PROP-102 §5). */
export const ANALYTICS_PRESETS = ['7d', '30d', '90d', 'custom'] as const
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number]

export interface AnalyticsPeriod {
  /** Начало включительно (`YYYY-MM-DD`, UTC). */
  from: string
  /** Конец включительно (`YYYY-MM-DD`, UTC). */
  to: string
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Сутки UTC даты `YYYY-MM-DD`. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

/** Реальная дата UTC в формате `YYYY-MM-DD`. */
export function isValidUtcDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false
  const parsed = new Date(`${day}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === day
}

/** Сдвиг даты `YYYY-MM-DD` на `delta` суток (UTC). */
export function shiftUtcDay(day: string, delta: number): string {
  const parsed = new Date(`${day}T00:00:00.000Z`)
  return utcDay(new Date(parsed.getTime() + delta * MS_PER_DAY))
}

/** Длина пресета в сутках (включительно); `custom` — не фиксирована. */
export function presetDays(preset: Exclude<AnalyticsPreset, 'custom'>): number {
  switch (preset) {
    case '7d':
      return 7
    case '30d':
      return 30
    case '90d':
      return 90
  }
}

/**
 * Разрешить период: `to` по умолчанию — сегодня (UTC), `from` — `to` минус
 * `days - 1`. Для `custom` невалидные/перевёрнутые границы нормализуются
 * (UI не должен отправлять заведомо 400-запрос).
 */
export function resolveAnalyticsPeriod(
  preset: AnalyticsPreset,
  customFrom: string,
  customTo: string,
  now: Date = new Date(),
): AnalyticsPeriod {
  const today = utcDay(now)
  if (preset !== 'custom') {
    return { from: shiftUtcDay(today, -(presetDays(preset) - 1)), to: today }
  }
  const to = isValidUtcDay(customTo) ? customTo : today
  const from = isValidUtcDay(customFrom) ? customFrom : to
  return from > to ? { from: to, to } : { from, to }
}

/** Даты по умолчанию для полей `custom` (последние 30 суток UTC). */
export function defaultCustomPeriod(now: Date = new Date()): AnalyticsPeriod {
  const to = utcDay(now)
  return { from: shiftUtcDay(to, -29), to }
}
