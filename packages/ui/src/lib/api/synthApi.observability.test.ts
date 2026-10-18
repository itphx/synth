import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `observability` (`lib/api/observability.ts`, ADR-094): runtime-настройка
 * экспорта `/metrics`, снимок состояния и write-only токен. Ценно — пути/методы
 * и то, что токен уходит только телом (никогда не появляется в URL).
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

const INFO = {
  metrics: { enabled: false },
  defaults: { enabled: false },
  isOverridden: false,
  source: 'default' as const,
  running: false,
  restartRequired: false,
  token: { configured: false, source: 'none' as const },
  endpoints: { metrics: '/metrics' as const, ready: '/ready' as const },
}

const STATUS = {
  enabled: false,
  running: false,
  source: 'default' as const,
  restartRequired: false,
  ready: true,
  storage: 'ok' as const,
  storageBackend: 'file' as const,
  version: '1.2.3',
  uptimeSec: 3600,
  exposition: { series: 12, bytes: 2048, droppedSeries: 0 },
  token: { configured: false, source: 'none' as const },
  endpoints: { metrics: '/metrics' as const, ready: '/ready' as const },
}

describe('observabilityApi — настройки метрик (ADR-094)', () => {
  it('get: GET /settings/metrics', async () => {
    fetchMock.mockResolvedValue(jsonResponse(INFO))

    await expect(synthApi.get()).resolves.toEqual(INFO)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/metrics',
      expect.objectContaining({}),
    )
  })

  it('setEnabled: PUT {metrics:{enabled}}', async () => {
    const body = { ...INFO, metrics: { enabled: true }, isOverridden: true, source: 'runtime' }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(synthApi.setEnabled(true)).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/metrics',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ metrics: { enabled: true } }),
      }),
    )
  })

  it('reset: DELETE /settings/metrics', async () => {
    fetchMock.mockResolvedValue(jsonResponse(INFO))

    await expect(synthApi.reset()).resolves.toEqual(INFO)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/metrics',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('status: GET /settings/metrics/status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATUS))

    await expect(synthApi.status()).resolves.toEqual(STATUS)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/metrics/status',
      expect.objectContaining({}),
    )
  })

  it('setToken: PUT {token}, значение только в теле (не в URL)', async () => {
    const body = { token: { configured: true, source: 'file' as const } }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(synthApi.setToken('s3cr3t-token')).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/metrics/token',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ token: 's3cr3t-token' }),
      }),
    )
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('s3cr3t-token')
  })

  it('deleteToken: DELETE /settings/metrics/token', async () => {
    const body = { token: { configured: false, source: 'none' as const } }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(synthApi.deleteToken()).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/metrics/token',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('409 при токене из env: ошибка несёт status для UI', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: 'token is configured via SYNTH_METRICS_TOKEN' }, 409),
    )

    await expect(synthApi.setToken('x')).rejects.toMatchObject({
      status: 409,
      message: 'token is configured via SYNTH_METRICS_TOKEN',
    })
  })
})
