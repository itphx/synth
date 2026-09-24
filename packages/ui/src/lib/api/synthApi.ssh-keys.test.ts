import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

describe('synthApi — SSH-ключи (AD-076)', () => {
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listSshKeys: GET /ssh-keys и /ssh-keys?agentId', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))
    await synthApi.listSshKeys()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/ssh-keys', expect.objectContaining({}))

    await synthApi.listSshKeys('a b')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/ssh-keys?agentId=a%20b', expect.objectContaining({}))
  })

  it('createSshKey: POST /ssh-keys с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'k1' }, 201))
    await synthApi.createSshKey({ name: 'deploy', privateKey: 'KEY', agentIds: ['a1'] })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/ssh-keys',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'deploy', privateKey: 'KEY', agentIds: ['a1'] }),
      }),
    )
  })

  it('updateSshKey: PATCH /ssh-keys/:id без privateKey', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'k1' }))
    await synthApi.updateSshKey('k1', { name: 'renamed' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/ssh-keys/k1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'renamed' }) }),
    )
  })

  it('deleteSshKey: DELETE /ssh-keys/:id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await expect(synthApi.deleteSshKey('k1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/ssh-keys/k1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('nested: list/create/unlink под /agents/:id/ssh-keys', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))
    await synthApi.listAgentSshKeys('agent 1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/agents/agent%201/ssh-keys', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ id: 'k1' }, 201))
    await synthApi.createAgentSshKey('a1', { name: 'n', privateKey: 'K' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/agents/a1/ssh-keys',
      expect.objectContaining({ method: 'POST' }),
    )

    fetchMock.mockResolvedValue(jsonResponse({ id: 'k1', agentIds: [] }))
    await synthApi.unlinkAgentSshKey('a1', 'k1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/agents/a1/ssh-keys/k1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
