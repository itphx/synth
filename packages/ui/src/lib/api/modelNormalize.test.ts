import { describe, it, expect } from 'vitest'
import { normalizeModelInfo } from './modelNormalize'

describe('normalizeModelInfo', () => {
  it('маппит camelCase-поля из API GET /models в snake_case-поля ModelInfo', () => {
    const raw = {
      id: 'p1/m1',
      name: 'm1',
      provider: 'p1',
      enabled: true,
      isDefault: false,
      contextWindow: 262144,
      contextSource: 'api',
      maxOutputTokens: 8192,
      inputPrice: 1.5,
      outputPrice: 0.75,
      cacheReadPrice: 0.1,
      cacheWritePrice: 0.2,
    }
    const out = normalizeModelInfo(raw)
    expect(out.context_window).toBe(262144)
    expect(out.context_source).toBe('api')
    expect(out.max_tokens).toBe(8192)
    expect(out.input_price).toBe(1.5)
    expect(out.output_price).toBe(0.75)
    expect(out.cache_read_price).toBe(0.1)
    expect(out.cache_write_price).toBe(0.2)
    expect(out.contextWindow).toBeUndefined()
    expect(out.inputPrice).toBeUndefined()
  })

  it('идемпотентен: уже snake_case и обычные поля не трогает', () => {
    const raw = { id: 'x', name: 'n', context_window: 100, context_source: 'manual', input_price: 2 }
    const out = normalizeModelInfo(raw)
    expect(out.context_window).toBe(100)
    expect(out.context_source).toBe('manual')
    expect(out.input_price).toBe(2)
    expect(out.id).toBe('x')
  })

  it('не падает на отсутствующих полях и undefined-значениях', () => {
    const out = normalizeModelInfo({ id: 'x', contextWindow: undefined })
    expect(out.id).toBe('x')
    expect(out.context_window).toBeUndefined()
  })
})
