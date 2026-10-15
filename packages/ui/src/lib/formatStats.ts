/** Компактное форматирование статистики (ADR-070 §2.6). */

import { DEFAULT_CHARS_PER_TOKEN } from '@itphx/synth-shared/types'
import { formatMoney } from './currency'

// ADR-071 §2.6: дефолтный chars-per-token — из общего контракта shared.
export { DEFAULT_CHARS_PER_TOKEN }
// C2b: мультивалютная сумма — единая реализация в `lib/currency`.
export { formatCostMap } from './currency'

function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, '')
}

/** 999 → `999`, 1200 → `1.2k`, 33300 → `33.3k`, 1700000 → `1.7M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `${sign}${trimTrailingZero((abs / 1_000).toFixed(1))}k`
  return String(n)
}

/**
 * 0 → `~ 0 $`, 0.03 → `~ 0.03 $`, 0.1 → `~ 0.10 $`, 0.000123 → `~ 0.000123 $`, 1.234 → `~ 1.23 $`.
 * Единая реализация — `formatMoney(..., { compact: true })` (`lib/currency`).
 * Неизвестный код валюты показывается как есть (`~ 0.03 EUR`), не маскируется под `$`.
 */
export function formatCost(usd: number, currency?: string | null): string {
  return formatMoney(usd, currency, { compact: true })
}

/** ADR-070 §2.3: cache hit rate = cacheRead / input (0 при input = 0). */
export function cacheHitRate(cacheRead: number | undefined, inputTokens: number | undefined): number {
  const input = inputTokens || 0
  if (input <= 0) return 0
  return (cacheRead || 0) / input
}

/** То же, что `cacheHitRate`, но округлённый процент (0..100+). */
export function cacheHitPct(cacheRead: number | undefined, inputTokens: number | undefined): number {
  return Math.round(cacheHitRate(cacheRead, inputTokens) * 100)
}

/** output_tokens / (duration_ms / 1000); undefined при отсутствии длительности. */
export function tokensPerSecond(
  outputTokens: number | undefined,
  durationMs: number | undefined,
): number | undefined {
  if (durationMs === undefined || durationMs <= 0 || typeof outputTokens !== 'number') return undefined
  return outputTokens / (durationMs / 1000)
}

/** 450 → `450ms`, 12000 → `12s`, 65000 → `1m 5s`, 694000 → `11m 34s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

/** 12.34 → `12.3 tok/s`, 12 → `12 tok/s`, 0 → `0 tok/s`. */
export function formatTps(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 tok/s'
  return `${n.toFixed(1).replace(/\.0$/, '')} tok/s`
}
