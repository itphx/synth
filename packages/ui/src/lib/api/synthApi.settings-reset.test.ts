import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

/** Проверяет URL + метод DELETE у последнего вызова fetch. */
function expectDelete(url: string): void {
  expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'DELETE' }))
}

let fetchMock: ReturnType<typeof vi.fn>

describe('synthApi.reset* — сброс runtime-настроек (AD-072 Ф2)', () => {
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resetWorkspaceSetting: DELETE /settings/workspace, возвращает workspace', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', workspace: '/default/ws', isOverridden: false, defaults: '/default/ws',
    }))
    const result = await synthApi.resetWorkspaceSetting()
    expectDelete('/api/v2/settings/workspace')
    expect(result).toEqual({ workspace: '/default/ws' })
  })

  it('resetMcpSettings: DELETE /settings/mcp, возвращает пустой servers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', servers: {}, isOverridden: false, defaults: {},
    }))
    const result = await synthApi.resetMcpSettings()
    expectDelete('/api/v2/settings/mcp')
    expect(result.servers).toEqual({})
  })

  it('resetLlmGatewaySettings: DELETE /settings/llm-gateway, возвращает llmGateway', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored',
      llmGateway: { enabled: false, inputMode: 'obfuscate', logPayloads: false, rateLimit: { userPerMinute: 60, providerPerMinute: 120 } },
      isOverridden: false,
      defaults: { enabled: false, inputMode: 'obfuscate', logPayloads: false, rateLimit: { userPerMinute: 60, providerPerMinute: 120 } },
    }))
    const result = await synthApi.resetLlmGatewaySettings()
    expectDelete('/api/v2/settings/llm-gateway')
    expect(result.enabled).toBe(false)
    expect(result.rateLimit).toEqual({ userPerMinute: 60, providerPerMinute: 120 })
  })

  it('resetSecuritySettings: DELETE /settings/security, возвращает security', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored',
      security: { protectedPaths: { enabled: true }, askTimeoutMs: 30000 },
      isOverridden: false,
      defaults: { protectedPaths: { enabled: true }, askTimeoutMs: 30000 },
    }))
    const result = await synthApi.resetSecuritySettings()
    expectDelete('/api/v2/settings/security')
    expect(result).toEqual({ protectedPaths: { enabled: true }, askTimeoutMs: 30000 })
  })

  it('resetToolsPolicy: DELETE /settings/tools-policy, возвращает toolsPolicy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', toolsPolicy: 'auto', isOverridden: false, defaults: 'auto',
    }))
    const result = await synthApi.resetToolsPolicy()
    expectDelete('/api/v2/settings/tools-policy')
    expect(result).toBe('auto')
  })

  it('resetMcpPolicy: DELETE /settings/mcp-policy, возвращает mcpPolicy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', mcpPolicy: 'consistency', isOverridden: false, defaults: 'consistency',
    }))
    const result = await synthApi.resetMcpPolicy()
    expectDelete('/api/v2/settings/mcp-policy')
    expect(result).toBe('consistency')
  })

  it('resetMcpNetworkPolicy: DELETE /settings/mcp-network-policy, возвращает policy', async () => {
    const policy = { mode: 'deny', list: ['10.0.0.0/8'] }
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', policy, isOverridden: false, defaults: policy,
    }))
    const result = await synthApi.resetMcpNetworkPolicy()
    expectDelete('/api/v2/settings/mcp-network-policy')
    expect(result).toEqual(policy)
  })

  it('resetToolsDisabled: DELETE /settings/tools-disabled, возвращает toolsDisabled', async () => {
    const config = { capabilities: [], tools: [] }
    fetchMock.mockResolvedValue(jsonResponse({
      status: 'restored', toolsDisabled: config, isOverridden: false, defaults: config,
    }))
    const result = await synthApi.resetToolsDisabled()
    expectDelete('/api/v2/settings/tools-disabled')
    expect(result).toEqual(config)
  })
})
