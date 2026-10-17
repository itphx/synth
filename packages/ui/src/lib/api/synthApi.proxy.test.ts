import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `proxy` (`lib/api/proxy.ts`, ADR-099): статус saved/running, runtime-
 * override (PUT/DELETE), write-only пароль и проверка соединения. Ценно —
 * пути/методы, разворачивание `{password}` и то, что UI не шлёт лишнего.
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
  source: 'config' as const,
  url: 'http://proxy.local:3128',
  noProxy: ['localhost'],
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
}

const INFO = {
  ...STATUS,
  saved: STATUS,
  running: { ...STATUS, enabled: false, source: 'none' as const },
  isOverridden: false,
  defaults: STATUS,
  password: { source: 'none' as const, set: false, removable: false },
}

describe('proxyApi — настройки egress-прокси (ADR-099)', () => {
  it('getProxy: GET /settings/proxy', async () => {
    fetchMock.mockResolvedValue(jsonResponse(INFO))

    await expect(synthApi.getProxy()).resolves.toEqual(INFO)

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/proxy', expect.objectContaining({}))
  })

  it('saveProxy: PUT {proxy} без пароля', async () => {
    const input = {
      enabled: true,
      url: 'http://proxy.local:3128',
      noProxy: ['localhost'],
      fromEnv: false,
      fallbackDirect: true,
      connectTimeoutMs: 5000,
      auth: { type: 'basic' as const, username: 'svc' },
    }
    const response = { saved: STATUS, running: STATUS, restartRequired: true }
    fetchMock.mockResolvedValue(jsonResponse(response))

    await expect(synthApi.saveProxy(input)).resolves.toEqual(response)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ proxy: input }) }),
    )
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('password')
  })

  it('resetProxy: DELETE /settings/proxy', async () => {
    const response = {
      status: 'restored',
      saved: STATUS,
      defaults: STATUS,
      running: STATUS,
      restartRequired: false,
    }
    fetchMock.mockResolvedValue(jsonResponse(response))

    await expect(synthApi.resetProxy()).resolves.toEqual(response)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('setProxyPassword: PUT {password} и разворачивание r.password', async () => {
    const status = { source: 'file' as const, set: true, removable: true }
    fetchMock.mockResolvedValue(jsonResponse({ password: status }))

    await expect(synthApi.setProxyPassword('s3cret')).resolves.toEqual(status)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy/password',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ password: 's3cret' }) }),
    )
  })

  it('clearProxyPassword: DELETE /settings/proxy/password', async () => {
    const status = { source: 'none' as const, set: false, removable: false }
    fetchMock.mockResolvedValue(jsonResponse({ password: status }))

    await expect(synthApi.clearProxyPassword()).resolves.toEqual(status)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy/password',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('checkProxy без url проверяет saved (пустое тело)', async () => {
    const result = {
      reachable: true,
      latencyMs: 12,
      authChallenge: 'Basic' as const,
      usingSaved: true,
    }
    fetchMock.mockResolvedValue(jsonResponse(result))

    await expect(synthApi.checkProxy()).resolves.toEqual(result)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy/check',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    )
  })

  it('checkProxy(url) проверяет явный URL (usingSaved=false)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ reachable: false, error: 'ECONNREFUSED', usingSaved: false }),
    )

    await synthApi.checkProxy('  http://other:3128  ')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/proxy/check',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'http://other:3128' }),
      }),
    )
  })

  it('409 (пароль из env) пробрасывается со status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'CONFLICT', message: 'SYNTH_PROXY_PASSWORD задан' } }, 409),
    )

    await expect(synthApi.setProxyPassword('x')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
  })
})
