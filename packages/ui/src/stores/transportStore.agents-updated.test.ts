import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `agents.updated` (реестр агентов инстанса изменился).
 *
 * Баг: «список агентов в UI не обновляется после создания/обновления агента,
 * пока не перезагрузишь страницу». Событие публикуется в **инстансный** канал
 * шины (у агента нет сессии), поэтому диспетчер обязан обработать его раньше
 * проверки `sid` — иначе `sessionId` события (`'instance'`/пусто/чужой)
 * отбрасывал бы его до стора.
 */
const apiMocks = vi.hoisted(() => ({
  getAgents: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getAgents: apiMocks.getAgents,
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
import { useAgentsStore } from './agentsStore'
import type { WSEvent } from '@/lib/api/transport'
import type { AgentInfo } from '@/lib/api/synthApi'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

function makeAgent(id: string): AgentInfo {
  return {
    id,
    display_name: id,
    capabilities: [],
    enabled: true,
    icon: null,
    color: null,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: null,
    max_steps: null,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: true,
    is_overridden: false,
  }
}

describe('transportStore dispatcher: agents.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getAgents.mockResolvedValue({
      agents: [makeAgent('assistant'), makeAgent('fixer')],
      default_agent: 'assistant',
    })
    useAgentsStore.setState({
      agents: [makeAgent('assistant')],
      activeAgentId: 'assistant',
      defaultAgentId: 'assistant',
      loading: false,
      revision: 0,
    })
  })

  it('без sessionId: поднимает revision и перечитывает состав', async () => {
    const loadSpy = vi.spyOn(useAgentsStore.getState(), 'loadAgents')

    dispatch(makeEvent('agents.updated', { id: 'fixer', action: 'save' }))

    expect(useAgentsStore.getState().revision).toBe(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(useAgentsStore.getState().agents.map((a) => a.id)).toEqual(['assistant', 'fixer'])
    })
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('agents.updated', { id: 'fixer', action: 'save' }, 'instance'))

    expect(useAgentsStore.getState().revision).toBe(1)
    expect(apiMocks.getAgents).toHaveBeenCalled()
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('agents.updated', { id: 'fixer', action: 'delete' }, 'some-other-session'))

    expect(useAgentsStore.getState().revision).toBe(1)
    expect(apiMocks.getAgents).toHaveBeenCalled()
  })

  it('каждое событие увеличивает revision (панель перечитывает список на любое изменение)', () => {
    dispatch(makeEvent('agents.updated', { action: 'save' }, 'instance'))
    dispatch(makeEvent('agents.updated', { action: 'enable' }, 'instance'))

    expect(useAgentsStore.getState().revision).toBe(2)
  })
})
