import { describe, it, expect } from 'vitest'
import { formatCost, formatCostMap, formatDuration, formatTokens, formatTps } from './formatStats'
import { cacheHitPct, cacheHitRate, tokensPerSecond } from './formatStats'
import { formatMoney } from './currency'

describe('formatTokens', () => {
  it('0 и значения < 1000 — как есть', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1)).toBe('1')
    expect(formatTokens(999)).toBe('999')
  })

  it('тысячи — k с одним знаком без .0', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(33300)).toBe('33.3k')
    expect(formatTokens(999_000)).toBe('999k')
  })

  it('миллионы — M с одним знаком без .0', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_700_000)).toBe('1.7M')
    expect(formatTokens(12_345_678)).toBe('12.3M')
  })

  it('отрицательные и нечисла', () => {
    expect(formatTokens(-1500)).toBe('-1.5k')
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(Infinity)).toBe('0')
  })
})

describe('formatCost', () => {
  it('0 и отрицательные → ~ 0 $', () => {
    expect(formatCost(0)).toBe('~ 0 $')
    expect(formatCost(-1)).toBe('~ 0 $')
    expect(formatCost(NaN)).toBe('~ 0 $')
  })

  it('>= 1 → 2 знака', () => {
    expect(formatCost(1)).toBe('~ 1.00 $')
    expect(formatCost(1.234)).toBe('~ 1.23 $')
    expect(formatCost(12.5)).toBe('~ 12.50 $')
  })

  it('>= 0.01 → 2–4 знака', () => {
    expect(formatCost(0.03)).toBe('~ 0.03 $')
    expect(formatCost(0.1)).toBe('~ 0.10 $')
    expect(formatCost(0.0312)).toBe('~ 0.0312 $')
    expect(formatCost(0.9999)).toBe('~ 0.9999 $')
  })

  it('< 0.01 → до 6 значимых', () => {
    expect(formatCost(0.000123)).toBe('~ 0.000123 $')
    expect(formatCost(0.0000012)).toBe('~ 0.0000012 $')
    expect(formatCost(0.009)).toBe('~ 0.009 $')
  })

  it('валюта задаёт символ', () => {
    expect(formatCost(0.0627, 'RUB')).toBe('~ 0.0627 ₽')
    expect(formatCost(0.0343, 'USD')).toBe('~ 0.0343 $')
    expect(formatCost(0.03, 'RUB')).toBe('~ 0.03 ₽')
    expect(formatCost(1.5, 'RUB')).toBe('~ 1.50 ₽')
    expect(formatCost(1.5, 'CNY')).toBe('~ 1.50 ¥')
    expect(formatCost(0, 'RUB')).toBe('~ 0 ₽')
    expect(formatCost(0.03, 'USD')).toBe('~ 0.03 $')
    // Разряды не добавляются — компактный вид сохраняется.
    expect(formatCost(1234.5, 'RUB')).toBe('~ 1234.50 ₽')
  })

  it('неизвестный код валюты показывается как есть, не маскируется под $', () => {
    expect(formatCost(0.03, 'EUR')).toBe('~ 0.03 EUR')
    expect(formatCost(1.5, 'GBP')).toBe('~ 1.50 GBP')
  })

  it('отсутствующая/пустая валюта → USD', () => {
    expect(formatCost(0.03, undefined)).toBe('~ 0.03 $')
    expect(formatCost(0.03, null)).toBe('~ 0.03 $')
    expect(formatCost(0.03, '')).toBe('~ 0.03 $')
  })
})

describe('formatMoney', () => {
  it('локализованный Intl для известной валюты', () => {
    expect(formatMoney(1234.5, 'USD', { locale: 'en' })).toBe('$1,234.50')
    expect(formatMoney(1234.5, 'RUB', { locale: 'ru' })).toMatch(/1\s?234,50\s?₽/)
  })

  it('неизвестная валюта — код после числа, не $', () => {
    expect(formatMoney(0.03, 'EUR')).toBe('0.03 EUR')
    expect(formatMoney(12, null)).toBe('12.00 USD')
  })

  it('compact-режим использует компактный формат', () => {
    expect(formatMoney(0.03, 'USD', { compact: true })).toBe('~ 0.03 $')
    expect(formatMoney(0.03, 'EUR', { compact: true })).toBe('~ 0.03 EUR')
  })
})

describe('cacheHitRate / cacheHitPct / tokensPerSecond', () => {
  it('cacheHitRate: read / input, 0 при input = 0', () => {
    expect(cacheHitRate(93, 100)).toBeCloseTo(0.93)
    expect(cacheHitRate(0, 100)).toBe(0)
    expect(cacheHitRate(5, 0)).toBe(0)
    expect(cacheHitRate(undefined, undefined)).toBe(0)
  })

  it('cacheHitPct: округлённый процент', () => {
    expect(cacheHitPct(93, 100)).toBe(93)
    expect(cacheHitPct(2, 3)).toBe(67)
    expect(cacheHitPct(1, 0)).toBe(0)
  })

  it('tokensPerSecond: output / (ms / 1000)', () => {
    expect(tokensPerSecond(100, 1000)).toBe(100)
    expect(tokensPerSecond(50, 2000)).toBe(25)
    expect(tokensPerSecond(100, 0)).toBeUndefined()
    expect(tokensPerSecond(undefined, 1000)).toBeUndefined()
    expect(tokensPerSecond(100, undefined)).toBeUndefined()
  })
})

describe('formatCostMap', () => {
  it('несколько валют — раздельно, порядок USD → RUB → CNY', () => {
    expect(formatCostMap({ RUB: 2.1, USD: 0.03 })).toBe('~ 0.03 $ · ~ 2.10 ₽')
    expect(formatCostMap({ CNY: 1.5, USD: 0.03, RUB: 2.1 })).toBe('~ 0.03 $ · ~ 2.10 ₽ · ~ 1.50 ¥')
  })

  it('неизвестные валюты — после известных по алфавиту, показываются кодом', () => {
    // CHF < EUR по алфавиту; оба неизвестны → код как есть.
    expect(formatCostMap({ EUR: 1, CHF: 2 })).toBe('~ 2.00 CHF · ~ 1.00 EUR')
  })

  it('смешанные известные и неизвестные валюты', () => {
    expect(formatCostMap({ EUR: 1, USD: 0.03 })).toBe('~ 0.03 $ · ~ 1.00 EUR')
  })

  it('нулевые и нечисловые значения отбрасываются', () => {
    expect(formatCostMap({ USD: 0, RUB: 2 })).toBe('~ 2.00 ₽')
    expect(formatCostMap({ USD: Number.NaN, RUB: 2 })).toBe('~ 2.00 ₽')
  })

  it('нет карты/пустая карта → fallback как USD (старые данные)', () => {
    expect(formatCostMap(undefined, 0.03)).toBe('~ 0.03 $')
    expect(formatCostMap(null, 0.03)).toBe('~ 0.03 $')
    expect(formatCostMap({}, 0.03)).toBe('~ 0.03 $')
    expect(formatCostMap({ USD: 0 }, 0.5)).toBe('~ 0.50 $')
  })

  it('пусто без fallback → пустая строка', () => {
    expect(formatCostMap()).toBe('')
    expect(formatCostMap({})).toBe('')
  })
})

describe('formatDuration', () => {
  it('0 и миллисекунды', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(-5)).toBe('0ms')
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('секунды', () => {
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(59_000)).toBe('59s')
  })

  it('минуты и секунды', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(694_000)).toBe('11m 34s')
  })

  it('часы', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })
})

describe('formatTps', () => {
  it('один знак без .0', () => {
    expect(formatTps(12.34)).toBe('12.3 tok/s')
    expect(formatTps(12)).toBe('12 tok/s')
    expect(formatTps(0.04)).toBe('0 tok/s')
  })

  it('0 и нечисла', () => {
    expect(formatTps(0)).toBe('0 tok/s')
    expect(formatTps(NaN)).toBe('0 tok/s')
  })
})
