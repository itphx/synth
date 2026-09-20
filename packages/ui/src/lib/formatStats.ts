/** Компактное форматирование статистики (AD-070 §2.6). */

/**
 * AD-071 §2.6: дефолтный chars-per-token. Дублирует shared-константу
 * `DEFAULT_CHARS_PER_TOKEN` намеренно: value-импорт из корня
 * `@itphx/synth-shared` тянет `./config` (node:fs) и ломает браузер.
 */
export const DEFAULT_CHARS_PER_TOKEN = 4

function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, '')
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

/** 999 → `999`, 1200 → `1.2k`, 33300 → `33.3k`, 1700000 → `1.7M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `${sign}${trimTrailingZero((abs / 1_000).toFixed(1))}k`
  return String(n)
}

/** 0 → `~$0`, 0.03 → `~$0.03`, 0.1 → `~$0.10`, 0.000123 → `~$0.000123`, 1.234 → `~$1.23`. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '~$0'
  if (usd >= 1) return `~$${usd.toFixed(2)}`
  if (usd >= 0.01) {
    // 2–4 знака: минимум 2, хвостовые нули сверх двух отбрасываем.
    const fixed = usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    const decimals = fixed.includes('.') ? fixed.split('.')[1]!.length : 0
    return `~$${decimals < 2 ? usd.toFixed(2) : fixed}`
  }
  // < 0.01: до 6 значимых цифр.
  const plain = trimTrailingZero(expandExponential(usd.toPrecision(6)).replace(/0+$/, '').replace(/\.$/, ''))
  return `~$${plain}`
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
