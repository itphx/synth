import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `mcp.updated` (реестр MCP-серверов инстанса изменился).
 *
 * Баг: «панель MCP показывает старый состав серверов, пока не перезагрузишь
 * страницу». Событие публикуется в **инстансный** канал шины (у реестра нет
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid` —
 * иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его до стора.
 *
 * Второй кейс — `action: 'policy'`: политика MCP (`settings/tools-policy`,
 * `mcp-policy`, `mcp-network-policy`, `tools-disabled`) меняет не состав
 * реестра, а **эффективные** значения, поэтому дополнительно поднимается
 * `toolsDisabledTick` (`useUIStore`) — по нему `ToolsDisabledSettings` и
 * `StatsTab` перечитывают настройки без перезагрузки страницы. На мутации
 * состава (`add`/`remove`/`update`) тик подниматься не должен: это лишний
 * запрос к настройкам.
 */
// persist (zustand) захватывает localStorage при импорте `useUIStore`
// (`toolsDisabledTick` живёт в нём), а Node/vitest без `--localstorage-file` его
// не даёт — ставим заглушку до импорта стора.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const apiMocks = vi.hoisted(() => ({
  getMcpRegistry: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getMcpRegistry: apiMocks.getMcpRegistry,
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useMcpStore } from './mcpStore'
import { useUIStore } from './useUIStore'
import type { WSEvent } from '@/lib/api/transport'
import type { McpRegistryEntry } from '@itphx/synth-shared'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

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

describe('transportStore dispatcher: mcp.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getMcpRegistry.mockResolvedValue({ entries: [makeEntry('srv'), makeEntry('srv2')] })
    // Runtime-счётчик `toolsDisabledTick` не персистится — сбрасываем руками.
    useUIStore.setState({ toolsDisabledTick: 0 })
    useMcpStore.setState({
      registry: [makeEntry('srv')],
      loading: false,
      error: null,
      revision: 0,
    })
  })

  it('без sessionId: поднимает revision и перечитывает реестр', async () => {
    dispatch(makeEvent('mcp.updated', { action: 'add', name: 'srv2' }))

    expect(useMcpStore.getState().revision).toBe(1)
    await vi.waitFor(() => {
      expect(useMcpStore.getState().registry?.map((entry) => entry.name)).toEqual(['srv', 'srv2'])
    })
    expect(apiMocks.getMcpRegistry).toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('mcp.updated', { action: 'add', name: 'srv2' }, 'instance'))

    expect(useMcpStore.getState().revision).toBe(1)
    expect(apiMocks.getMcpRegistry).toHaveBeenCalled()
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('mcp.updated', { action: 'remove', name: 'srv2' }, 'some-other-session'))

    expect(useMcpStore.getState().revision).toBe(1)
    expect(apiMocks.getMcpRegistry).toHaveBeenCalled()
  })

  it('событие уровневой операции (`scope: session/project`) тоже доходит', () => {
    dispatch(makeEvent('mcp.updated', { action: 'update', scope: 'session', sessionId: 's1' }, 's1'))
    dispatch(makeEvent('mcp.updated', { action: 'update', scope: 'project', projectId: 'p1' }, 's1'))

    expect(useMcpStore.getState().revision).toBe(2)
  })

  it('`action: "policy"` поднимает toolsDisabledTick (эффективные настройки перечитываются)', () => {
    dispatch(makeEvent('mcp.updated', { action: 'policy' }, 'instance'))

    expect(useUIStore.getState().toolsDisabledTick).toBe(1)
    // Состав реестра от политики не меняется, но сигнал перечитывания общий.
    expect(useMcpStore.getState().revision).toBe(1)
  })

  it('`action: "policy"`: каждое событие — новый тик (селекторы настроек не «залипают»)', () => {
    dispatch(makeEvent('mcp.updated', { action: 'policy' }, 'instance'))
    dispatch(makeEvent('mcp.updated', { action: 'policy' }, 'instance'))

    expect(useUIStore.getState().toolsDisabledTick).toBe(2)
  })

  it('мутация состава (`action: "add"`) НЕ поднимает toolsDisabledTick', () => {
    dispatch(makeEvent('mcp.updated', { action: 'add', name: 'srv2' }, 'instance'))

    // Лишнего запроса к настройкам политики быть не должно: состав реестра
    // меняется, а `tools.disabled`/политика — нет.
    expect(useUIStore.getState().toolsDisabledTick).toBe(0)
    expect(useMcpStore.getState().revision).toBe(1)
  })

  it('`action: "remove"` и `action: "update"` тоже не трогают toolsDisabledTick', () => {
    dispatch(makeEvent('mcp.updated', { action: 'remove', name: 'srv2' }, 'instance'))
    dispatch(makeEvent('mcp.updated', { action: 'update', name: 'srv2' }, 'instance'))

    expect(useUIStore.getState().toolsDisabledTick).toBe(0)
    expect(useMcpStore.getState().revision).toBe(2)
  })
})
