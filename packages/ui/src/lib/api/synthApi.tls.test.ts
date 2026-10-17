import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `tls` (`lib/api/tls.ts`, ADR-099): статус CA/клиента/маппингов,
 * несекретные настройки, write-only материалы и проверка без записи.
 * Ценно — пути/методы/кодирование id и то, что PEM уходит только телом.
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
  ca: { source: 'runtime' as const, count: 1, subjects: ['CN=Corp CA'] },
  rejectUnauthorized: true,
  mappings: [],
  params: {},
}
const MUTATION = { status: STATUS, restartRequired: true }

describe('tlsApi — настройки TLS/CA (ADR-099)', () => {
  it('getTls: GET /settings/tls', async () => {
    const body = {
      status: STATUS,
      ...STATUS,
      saved: { bootstrap: true, profileIds: [] },
      running: { applied: true, profileIds: [] },
      defaults: STATUS,
      restartRequired: false,
    }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(synthApi.getTls()).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/tls', expect.objectContaining({}))
  })

  it('updateTls: PUT {tls} (несекретные поля)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(MUTATION))

    await expect(synthApi.updateTls({ rejectUnauthorized: false })).resolves.toEqual(MUTATION)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/tls',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ tls: { rejectUnauthorized: false } }),
      }),
    )
  })

  it('uploadCa / removeCa: PUT с PEM и DELETE', async () => {
    fetchMock.mockResolvedValue(jsonResponse(MUTATION))

    await synthApi.uploadCa('CA-PEM')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/ca',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ pem: 'CA-PEM' }) }),
    )

    await synthApi.removeCa()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/ca',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('setDefaultClient / removeDefaultClient', async () => {
    fetchMock.mockResolvedValue(jsonResponse(MUTATION))

    await synthApi.setDefaultClient('CERT', 'KEY')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/client',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ certPem: 'CERT', keyPem: 'KEY' }),
      }),
    )

    await synthApi.removeDefaultClient()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/client',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('маппинги: POST /mappings, PUT/DELETE с кодированием id', async () => {
    const mapping = { id: 'm 1', hosts: ['*.corp'], source: 'runtime', readOnly: false }
    fetchMock.mockResolvedValue(jsonResponse({ ...MUTATION, mapping }))

    const input = { hosts: ['*.corp'], label: 'corp', certPem: 'CERT', keyPem: 'KEY' }
    await synthApi.createTlsMapping(input)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/mappings',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    )

    await synthApi.updateTlsMapping('m 1', { label: null })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/mappings/m%201',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ label: null }) }),
    )

    await synthApi.deleteTlsMapping('m 1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/tls/mappings/m%201',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('validateTls: POST /validate {caPem,certPem,keyPem,hosts}', async () => {
    const result = { ok: true, caCount: 1, keyMatches: true, hostPatternsValid: true, errors: [] }
    fetchMock.mockResolvedValue(jsonResponse(result))

    const input = { caPem: 'CA', certPem: 'CERT', keyPem: 'KEY', hosts: ['*'] }
    await expect(synthApi.validateTls(input)).resolves.toEqual(result)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/tls/validate',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    )
  })

  it('409 (env/config) пробрасывается со status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'CONFLICT', message: 'read-only' } }, 409),
    )

    await expect(synthApi.uploadCa('CA')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
  })
})
