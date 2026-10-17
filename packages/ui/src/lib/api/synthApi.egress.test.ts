import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `egress` (`lib/api/egress.ts`): runtime-политика `tools`/`webhooks`,
 * offline-проверка URL и журналы безопасности. Ценно — пути/методы/query и
 * разворачивание полей ответа (`policy`), иначе UI «залипает» на старом значении.
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

const POLICY = { mode: 'deny', list: ['10.0.0.0/8'], exceptions: ['*.example.com'] }

describe('egressApi — политика', () => {
  it('getEgressPolicy: GET /settings/egress/:scope → {policy,isOverridden,defaults}', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ policy: POLICY, isOverridden: true, defaults: { ...POLICY, exceptions: [] } }),
    )

    const result = await synthApi.getEgressPolicy('tools')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/egress/tools',
      expect.objectContaining({}),
    )
    expect(result.policy).toEqual(POLICY)
    expect(result.isOverridden).toBe(true)
    expect(result.defaults.exceptions).toEqual([])
  })

  it('saveEgressPolicy: PUT {policy} и разворачивание r.policy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ policy: POLICY }))

    await expect(synthApi.saveEgressPolicy('tools', POLICY as never)).resolves.toEqual(POLICY)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/egress/tools',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ policy: POLICY }) }),
    )
  })

  it('saveEgressPolicy(webhooks) сохраняет mode=off', async () => {
    const off = { mode: 'off', list: [], exceptions: [] }
    fetchMock.mockResolvedValue(jsonResponse({ policy: off }))

    await expect(synthApi.saveEgressPolicy('webhooks', off as never)).resolves.toEqual(off)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/egress/webhooks',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ policy: off }) }),
    )
  })
})

describe('egressApi — проверка URL', () => {
  it('checkEgress: POST /settings/egress/check {scope,url}', async () => {
    const body = {
      allowed: false,
      reason: 'private address',
      matchedRule: '10.0.0.0/8',
      addresses: ['10.1.2.3'],
      policy: POLICY,
    }
    fetchMock.mockResolvedValue(jsonResponse(body))

    const result = await synthApi.checkEgress('tools', 'http://internal/hook')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/egress/check',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ scope: 'tools', url: 'http://internal/hook' }),
      }),
    )
    expect(result).toEqual(body)
  })

  it('checkEgress(mcp): передаёт scope=mcp', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true, policy: POLICY }))

    await synthApi.checkEgress('mcp', 'https://example.com/mcp')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/egress/check',
      expect.objectContaining({
        body: JSON.stringify({ scope: 'mcp', url: 'https://example.com/mcp' }),
      }),
    )
  })
})

describe('egressApi — журналы', () => {
  it('getSecurityAudit: GET /audit/security с limit и scope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], count: 0 }))

    await synthApi.getSecurityAudit(50, 'tools')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/audit/security?limit=50&scope=tools',
      expect.objectContaining({}),
    )
  })

  it('getSecurityAudit без параметров не добавляет query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], count: 0 }))

    await synthApi.getSecurityAudit()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/audit/security', expect.objectContaining({}))
  })

  it('getEgressLog: GET /audit/egress с limit/scope/status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], count: 0 }))

    await synthApi.getEgressLog(100, 'webhooks', 'blocked')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/audit/egress?limit=100&scope=webhooks&status=blocked',
      expect.objectContaining({}),
    )
  })
})
