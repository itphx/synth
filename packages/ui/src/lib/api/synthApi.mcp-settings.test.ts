import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домены `mcp` и `settings` (`lib/api/mcp.ts`, `lib/api/settings.ts`, ADR-071).
 * Ценно — разворачивание и переименование полей ответа: сервер отдаёт
 * `mcpPolicy`/`toolsPolicy`/`toolsDisabled`, клиент выставляет нейтральное
 * `policy`/`config`. Ошибка здесь — «залипшие» настройки в UI.
 *
 * Методы `reset*` уже покрыты `synthApi.settings-reset.test.ts` — здесь не дублируются.
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

describe('mcpApi — скоуп сессии и реестр', () => {
  it('getSessionMcpEffective / updateSessionMcp: GET и PUT /sessions/:id/mcp', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ servers: [] }))
    await synthApi.getSessionMcpEffective('s1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/sessions/s1/mcp', expect.objectContaining({}))

    const body = { name: 'srv', enabled: false }
    await synthApi.updateSessionMcp('s1', body)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/s1/mcp',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(body) }),
    )
  })

  it('реестр: GET /mcp/registry, PUT/DELETE с кодированием id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [] }))
    await synthApi.getMcpRegistry()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/mcp/registry', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ id: 'e1' }))
    await synthApi.updateMcpRegistryEntry('e/1', { enabled: true })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/mcp/registry/e%2F1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true }) }),
    )

    await synthApi.deleteMcpRegistryEntry('e1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/mcp/registry/e1',
      expect.objectContaining({ method: 'DELETE' }),
    )

    await expect(synthApi.addMcpRegistryEntry({ name: 'x', config: {} } as never)).resolves.toBeDefined()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/mcp/registry',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'x', config: {} }) }),
    )
  })

  it('probeMcpServer: POST /mcp/probe {name}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'x', tools: [] }))
    await synthApi.probeMcpServer('x')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/mcp/probe',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'x' }) }),
    )
  })

  it('getMcpToolSettings / saveMcpToolSettings: GET и PUT /settings/mcp', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ servers: {} }))
    await synthApi.getMcpToolSettings()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/settings/mcp', expect.objectContaining({}))

    const servers = { srv: { default: { plan: true, act: true }, tools: {} } }
    await synthApi.saveMcpToolSettings(servers)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/settings/mcp',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ servers }) }),
    )
  })

  it('getMcpNetworkPolicyInfo: GET /settings/mcp-network-policy → {policy,isOverridden,defaults}', async () => {
    const policy = { mode: 'deny', list: ['10.0.0.0/8'] }
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 'x', policy, isOverridden: true, defaults: policy }),
    )

    const result = await synthApi.getMcpNetworkPolicyInfo()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/mcp-network-policy', expect.objectContaining({}))
    expect(result).toEqual({ policy, isOverridden: true, defaults: policy })
  })

  it('saveMcpNetworkPolicy: PUT {policy} и разворачивание r.policy', async () => {
    const policy = { mode: 'allow', list: [] }
    fetchMock.mockResolvedValue(jsonResponse({ policy }))

    await expect(synthApi.saveMcpNetworkPolicy(policy as never)).resolves.toEqual(policy)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/mcp-network-policy',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ policy }) }),
    )
  })

  it('getMcpPolicyInfo: переименовывает mcpPolicy → policy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mcpPolicy: 'auto', isOverridden: false, defaults: 'consistency' }))

    const result = await synthApi.getMcpPolicyInfo()

    expect(result).toEqual({ policy: 'auto', isOverridden: false, defaults: 'consistency' })
    expect('mcpPolicy' in result).toBe(false)
  })

  it('saveMcpPolicy: PUT {mcpPolicy} и разворачивание r.mcpPolicy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mcpPolicy: 'available' }))

    await expect(synthApi.saveMcpPolicy('available' as never)).resolves.toBe('available')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/mcp-policy',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ mcpPolicy: 'available' }) }),
    )
  })
})

describe('settingsApi — политика и отключение инструментов', () => {
  it('getToolsPolicyInfo: переименовывает toolsPolicy → policy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ toolsPolicy: 'auto', isOverridden: true, defaults: 'consistency' }))

    const result = await synthApi.getToolsPolicyInfo()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/settings/tools-policy', expect.objectContaining({}))
    expect(result).toEqual({ policy: 'auto', isOverridden: true, defaults: 'consistency' })
  })

  it('saveToolsPolicy: PUT {toolsPolicy} и разворачивание r.toolsPolicy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ toolsPolicy: 'available' }))

    await expect(synthApi.saveToolsPolicy('available' as never)).resolves.toBe('available')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/tools-policy',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ toolsPolicy: 'available' }) }),
    )
  })

  it('getToolsDisabledInfo: переименовывает toolsDisabled → config', async () => {
    const config = { capabilities: ['user'], tools: ['web_search'] }
    fetchMock.mockResolvedValue(
      jsonResponse({ toolsDisabled: config, isOverridden: false, defaults: { capabilities: [], tools: [] } }),
    )

    const result = await synthApi.getToolsDisabledInfo()

    expect(result.config).toEqual(config)
    expect('toolsDisabled' in result).toBe(false)
  })

  it('saveToolsDisabled: PUT /settings/tools-disabled оборачивает в { toolsDisabled } и разворачивает', async () => {
    const config = { capabilities: [], tools: ['x'] }
    fetchMock.mockResolvedValue(jsonResponse({ toolsDisabled: config }))

    await expect(synthApi.saveToolsDisabled(config as never)).resolves.toEqual(config)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/tools-disabled',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ toolsDisabled: config }) }),
    )
  })
})
