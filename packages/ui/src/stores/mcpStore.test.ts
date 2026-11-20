import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMcpStore } from './mcpStore'
import { synthApi } from '@/lib/api/synthApi'
import type { McpRegistryEntry } from '@itphx/synth-shared'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getMcpRegistry: vi.fn(),
  },
}))

function makeEntry(name: string): McpRegistryEntry {
  return {
    schemaVersion: 1,
    id: `mcp_${name}`,
    name,
    config: { type: 'http', url: 'https://93.184.216.34/mcp' },
    origin: 'instance',
    author: null,
    trust: 'builtin',
    enabled: true,
    enabledByDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as McpRegistryEntry
}

beforeEach(() => {
  vi.clearAllMocks()
  useMcpStore.setState({
    registry: null,
    loading: false,
    error: null,
    revision: 0,
    toolSettings: null,
    toolSettingsLoading: false,
    toolSettingsError: null,
    networkPolicy: null,
    networkPolicyDefaults: null,
    networkPolicyLoading: false,
    networkPolicyError: null,
    toolsDisabled: null,
    toolsDisabledDefaults: null,
    toolsDisabledLoading: false,
    toolsDisabledError: null,
  })
})

/**
 * Событие шины `mcp.updated` в сторе.
 *
 * Баг: «панель MCP показывает старый состав серверов, пока не перезагрузишь
 * страницу» — правка реестра тулом из чата или из другой вкладки не доходила
 * до стора.
 */
describe('mcpStore.applyEvent (событие шины `mcp.updated`)', () => {
  it('поднимает revision и перечитывает реестр', async () => {
    vi.mocked(synthApi.getMcpRegistry).mockResolvedValue({ entries: [makeEntry('srv'), makeEntry('srv2')] })

    useMcpStore.getState().applyEvent()

    expect(useMcpStore.getState().revision).toBe(1)
    await vi.waitFor(() => {
      expect(useMcpStore.getState().registry?.map((entry) => entry.name)).toEqual(['srv', 'srv2'])
    })
    expect(synthApi.getMcpRegistry).toHaveBeenCalledTimes(1)
  })

  it('каждое событие увеличивает revision (панели реагируют на любое изменение)', () => {
    vi.mocked(synthApi.getMcpRegistry).mockResolvedValue({ entries: [] })

    useMcpStore.getState().applyEvent()
    useMcpStore.getState().applyEvent()

    expect(useMcpStore.getState().revision).toBe(2)
  })

  it('удалённый на сервере сервер исчезает из реестра (состояние не «висит»)', async () => {
    useMcpStore.setState({ registry: [makeEntry('srv'), makeEntry('srv2')] })
    // Пока панель была открыта, сервер удалили в другой вкладке.
    vi.mocked(synthApi.getMcpRegistry).mockResolvedValue({ entries: [makeEntry('srv')] })

    useMcpStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useMcpStore.getState().registry?.map((entry) => entry.name)).toEqual(['srv'])
    })
    expect(useMcpStore.getState().revision).toBe(1)
  })

  it('ошибка перечитывания не сбрасывает revision и заполняет error', async () => {
    useMcpStore.setState({ registry: [makeEntry('srv')] })
    vi.mocked(synthApi.getMcpRegistry).mockRejectedValue(new Error('network'))

    useMcpStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useMcpStore.getState().loading).toBe(false)
    })
    expect(useMcpStore.getState().revision).toBe(1)
    expect(useMcpStore.getState().error).toBe('network')
  })
})
