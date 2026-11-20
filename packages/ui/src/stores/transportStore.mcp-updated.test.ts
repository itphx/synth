import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `mcp.updated` (реестр MCP-серверов инстанса изменился).
 *
 * Баг: «панель MCP показывает старый состав серверов, пока не перезагрузишь
 * страницу». Событие публикуется в **инстансный** канал шины (у реестра нет
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid` —
 * иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его до стора.
 */
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
})
