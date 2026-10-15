import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домены `security` (`lib/api/security.ts`, ADR-036) и `decision`
 * (`lib/api/decision.ts`, ADR-084). Ценно — маппинг snake_case↔camelCase в ответах
 * Gateway/Protected-paths и точные пути/тела PUT/DELETE.
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

describe('securityApi — LLM Gateway (ADR-036)', () => {
  it('getLlmGatewaySettingsInfo: GET /settings/llm-gateway, llmGateway → settings', async () => {
    const llmGateway = { enabled: true, inputMode: 'obfuscate', rateLimit: { userPerMinute: 60, providerPerMinute: 120 } }
    fetchMock.mockResolvedValue(jsonResponse({ llmGateway, isOverridden: false, defaults: llmGateway }))

    const result = await synthApi.getLlmGatewaySettingsInfo()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/llm-gateway', expect.objectContaining({}))
    expect(result.settings).toEqual(llmGateway)
    expect('llmGateway' in result).toBe(false)
  })

  it('saveLlmGatewaySettings: PUT {llmGateway} и разворачивание r.llmGateway', async () => {
    const config = { enabled: false, inputMode: 'block', rateLimit: { userPerMinute: 1, providerPerMinute: 2 } }
    fetchMock.mockResolvedValue(jsonResponse({ llmGateway: config }))

    await expect(synthApi.saveLlmGatewaySettings(config as never)).resolves.toEqual(config)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/llm-gateway',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ llmGateway: config }) }),
    )
  })

  it('getGatewayPatterns: snake_case → camelCase (is_overridden, default_patterns)', async () => {
    const patterns = [{ type: 'api_key', regex: 'sk-[a-z]+' }]
    fetchMock.mockResolvedValue(
      jsonResponse({ patterns, is_overridden: true, default_patterns: [] }),
    )

    const result = await synthApi.getGatewayPatterns()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/gateway/patterns', expect.objectContaining({}))
    expect(result).toEqual({ patterns, isOverridden: true, defaultPatterns: [] })
  })

  it('saveGatewayPatterns: PUT {patterns}, ответ snake→camel + saved', async () => {
    const patterns = [{ type: 'token', regex: 't' }]
    fetchMock.mockResolvedValue(jsonResponse({ patterns, is_overridden: false, saved: true }))

    const result = await synthApi.saveGatewayPatterns(patterns)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/gateway/patterns',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ patterns }) }),
    )
    expect(result).toEqual({ patterns, isOverridden: false, saved: true })
  })

  it('resetGatewayPatterns: DELETE /gateway/patterns', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'restored' }))
    await synthApi.resetGatewayPatterns()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/gateway/patterns',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('securityApi — безопасность и защищённые пути', () => {
  it('getSecuritySettings / saveSecuritySettings: разворачивают r.security', async () => {
    const security = { protectedPaths: { enabled: true }, askTimeoutMs: 30000 }
    fetchMock.mockResolvedValue(jsonResponse({ security }))

    await expect(synthApi.getSecuritySettings()).resolves.toEqual(security)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/security', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ security }))
    await expect(synthApi.saveSecuritySettings(security as never)).resolves.toEqual(security)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/security',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ security }) }),
    )
  })

  it('getProtectedPaths: snake_case is_overridden → isOverridden, поле base', async () => {
    const policy = { deniedPaths: [], deniedPrefixes: ['/etc'], approvalPaths: [], deniedCommandPrefixes: [] }
    fetchMock.mockResolvedValue(jsonResponse({ policy, base: policy, is_overridden: true }))

    const result = await synthApi.getProtectedPaths()

    expect(result).toEqual({ policy, base: policy, isOverridden: true })
  })

  it('saveProtectedPaths: PUT {policy} и разворачивание r.policy', async () => {
    const policy = { deniedPaths: ['/x'], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] }
    fetchMock.mockResolvedValue(jsonResponse({ policy }))

    await expect(synthApi.saveProtectedPaths(policy)).resolves.toEqual(policy)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/protected-paths',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ policy }) }),
    )
  })

  it('resetProtectedPaths: DELETE /settings/protected-paths', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'restored' }))
    await synthApi.resetProtectedPaths()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/protected-paths',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('getSessionSecrets: GET /sessions/:id/secrets с кодированием id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: 'a b', secrets: {} }))
    await synthApi.getSessionSecrets('a b')
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/sessions/a%20b/secrets', expect.objectContaining({}))
  })

  it('auditRevealed: POST /audit/revealed с телом {sessionId, placeholder}', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)

    await synthApi.auditRevealed('s1', '{{secret}}')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/audit/revealed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionId: 's1', placeholder: '{{secret}}' }),
      }),
    )
  })
})

describe('decisionApi — decision-слой (ADR-084)', () => {
  it('getDecisionSettings / updateDecisionSettings: GET и PUT {decision}', async () => {
    const decision = { enabled: true, provider: 'decision', model: 'clef-flash' }
    fetchMock.mockResolvedValue(jsonResponse({ decision, defaults: decision, isOverridden: false }))
    await expect(synthApi.getDecisionSettings()).resolves.toEqual({ decision, defaults: decision, isOverridden: false })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/decision', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ decision }))
    await synthApi.updateDecisionSettings(decision as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/decision',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ decision }) }),
    )
  })

  it('resetDecisionSettings: DELETE /settings/decision', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ decision: {}, defaults: {}, isOverridden: false }))
    await synthApi.resetDecisionSettings()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/decision',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('getDecisionMetrics / resetDecisionMetrics: GET и DELETE /settings/decision/metrics', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ metrics: { calls: 1 }, ts: '2026-01-01T00:00:00Z' }))
    await expect(synthApi.getDecisionMetrics()).resolves.toEqual({
      metrics: { calls: 1 },
      ts: '2026-01-01T00:00:00Z',
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/decision/metrics', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ metrics: { calls: 0 } }))
    await synthApi.resetDecisionMetrics()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/decision/metrics',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
