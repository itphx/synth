import { describe, it, expect } from 'vitest'
import { readMessageSubagents } from './subagentStats'

describe('readMessageSubagents (C2a: валюта стоимости)', () => {
  it('читает cost_currency из metadata.subagents', () => {
    const stats = readMessageSubagents({
      subagents: {
        sessions: 2,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: 42,
        cost_currency: 'RUB',
      },
    })

    expect(stats).toBeDefined()
    expect(stats!.cost_usd).toBe(42)
    expect(stats!.costCurrency).toBe('RUB')
  })

  it('fallback: единственная валюта в cost_by_currency', () => {
    const stats = readMessageSubagents({
      subagents: {
        sessions: 1,
        cost_usd: 0.001,
        cost_by_currency: { USD: 0.001 },
      },
    })

    expect(stats!.costCurrency).toBe('USD')
  })

  it('мультивалютная разбивка без cost_currency — валюта не задаётся', () => {
    const stats = readMessageSubagents({
      subagents: {
        sessions: 2,
        cost_usd: 0.05,
        cost_by_currency: { USD: 0.001, RUB: 0.049 },
      },
    })

    expect(stats).toBeDefined()
    expect(stats!.costCurrency).toBeUndefined()
  })

  it('C2b: cost_by_currency пробрасывается (только положительные значения)', () => {
    const stats = readMessageSubagents({
      subagents: {
        sessions: 2,
        cost_usd: 0.05,
        cost_by_currency: { USD: 0.001, RUB: 0.049, CNY: 0 },
      },
    })

    expect(stats).toBeDefined()
    expect(stats!.cost_by_currency).toEqual({ USD: 0.001, RUB: 0.049 })
  })

  it('C2b: нет/пустой cost_by_currency → поля нет', () => {
    const noMap = readMessageSubagents({ subagents: { sessions: 1, cost_usd: 0.001 } })
    expect(noMap!.cost_by_currency).toBeUndefined()
    const emptyMap = readMessageSubagents({
      subagents: { sessions: 1, cost_usd: 0.001, cost_by_currency: {} },
    })
    expect(emptyMap!.cost_by_currency).toBeUndefined()
  })

  it('нет сабагентов → undefined', () => {
    expect(readMessageSubagents(null)).toBeUndefined()
    expect(readMessageSubagents({})).toBeUndefined()
    expect(readMessageSubagents({ subagents: { sessions: 0 } })).toBeUndefined()
  })
})
