import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

describe('synthApi — агент по умолчанию (админка «Агенты»)', () => {
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getDefaultAgentInfo: GET /settings/default-agent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant',
    }))
    const result = await synthApi.getDefaultAgentInfo()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/default-agent',
      expect.objectContaining({}),
    )
    expect(result).toEqual({ defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant' })
  })

  it('setDefaultAgent: PUT /settings/default-agent с телом { defaultAgent }', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ defaultAgent: 'developer' }))
    const result = await synthApi.setDefaultAgent('developer')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/default-agent',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ defaultAgent: 'developer' }) }),
    )
    expect(result).toEqual({ defaultAgent: 'developer' })
  })

  it('resetDefaultAgent: DELETE /settings/default-agent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant',
    }))
    const result = await synthApi.resetDefaultAgent()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/default-agent',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(result.status).toBe('restored')
    expect(result.defaultAgent).toBe('assistant')
  })
})
