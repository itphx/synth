import { describe, it, expect } from 'vitest'
import { userColor } from './utils'

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

describe('userColor', () => {
  it('детерминирован: одно имя → одно значение', () => {
    expect(userColor('alice')).toBe(userColor('alice'))
    expect(userColor('Борис')).toBe(userColor('Борис'))
    expect(userColor('')).toBe(userColor(''))
  })

  it('возвращает только цвета палитры --chart-1..5', () => {
    const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'Борис', 'user@example.com', '']
    for (const name of names) {
      expect(PALETTE).toContain(userColor(name))
    }
  })

  it('разные имена могут давать разные цвета', () => {
    // alice: 510 % 5 = 0 → chart-1; bob: 307 % 5 = 2 → chart-3
    expect(userColor('alice')).toBe('var(--chart-1)')
    expect(userColor('bob')).toBe('var(--chart-3)')
    expect(userColor('alice')).not.toBe(userColor('bob'))
  })

  it('пустое имя → первый цвет палитры (сумма 0)', () => {
    expect(userColor('')).toBe('var(--chart-1)')
  })
})
