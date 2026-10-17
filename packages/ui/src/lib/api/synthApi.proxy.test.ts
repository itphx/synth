import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `proxy` (`lib/api/proxy.ts`, ADR-099 D1): read-only статус egress-прокси
 * и проверка коннекта к нему. Ценно — пути/методы и то, что проверка не шлёт
 * цель/секреты (пустое тело).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const STATUS = {
  enabled: true,
  source: 'env' as const,
  url: 'http://proxy.local:3128',
  noProxy: ['localhost', '.corp.local'],
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
}

describe('proxyApi — egress-прокси (ADR-099 D1)', () => {
  it('getProxyStatus: GET /settings/proxy возвращает статус', async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATUS))

    await expect(synthApi.getProxyStatus()).resolves.toEqual(STATUS)

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/proxy', expect.objectContaining({}))
  })

  it('checkProxy: POST /settings/proxy/check с пустым телом (без цели)', async () => {
    const result = { reachable: true, latencyMs: 12, authChallenge: 'Basic' as const }
    fetchMock.mockResolvedValue(jsonResponse(result))

    await expect(synthApi.checkProxy()).resolves.toEqual(result)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy/check',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    )
  })
})
