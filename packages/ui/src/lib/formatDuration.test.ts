import { describe, it, expect } from 'vitest'
import { formatRemaining } from './formatDuration'

describe('formatRemaining', () => {
  it('минуты и секунды — двузначные', () => {
    expect(formatRemaining(0)).toBe('00:00')
    expect(formatRemaining(1_000)).toBe('00:01')
    expect(formatRemaining(59_000)).toBe('00:59')
    expect(formatRemaining(60_000)).toBe('01:00')
    expect(formatRemaining(90_000)).toBe('01:30')
    expect(formatRemaining(599_000)).toBe('09:59')
  })

  it('при часе и больше — «ч:мм:сс»', () => {
    expect(formatRemaining(3_600_000)).toBe('1:00:00')
    expect(formatRemaining(3_661_000)).toBe('1:01:01')
    expect(formatRemaining(7_322_000)).toBe('2:02:02')
  })

  it('истёкший остаток не уходит в минус', () => {
    expect(formatRemaining(-5_000)).toBe('00:00')
    expect(formatRemaining(-1)).toBe('00:00')
  })

  it('нечисловое значение (битый срок) — как истёкший отсчёт', () => {
    expect(formatRemaining(Number.NaN)).toBe('00:00')
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe('00:00')
  })

  it('дробная часть секунды отбрасывается вниз', () => {
    expect(formatRemaining(1_999)).toBe('00:01')
    expect(formatRemaining(89_999)).toBe('01:29')
  })
})
