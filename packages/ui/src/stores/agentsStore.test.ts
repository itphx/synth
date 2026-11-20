import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentsStore } from './agentsStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getAgents: vi.fn(),
  },
}))

function makeAgent(id: string, display_name: string): AgentInfo {
  return {
    id,
    display_name,
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

const AGENTS: AgentInfo[] = [
  makeAgent('developer', 'Разработчик'),
  makeAgent('alistent', 'Алистент'),
]

beforeEach(() => {
  vi.clearAllMocks()
  useAgentsStore.setState({ agents: [], activeAgentId: null, defaultAgentId: null, loading: false, revision: 0 })
})

describe('agentsStore.loadAgents', () => {
  it('первый вызов выставляет активным default_agent', async () => {
    vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })

    await useAgentsStore.getState().loadAgents('s1')

    const state = useAgentsStore.getState()
    expect(state.agents).toEqual(AGENTS)
    expect(state.defaultAgentId).toBe('developer')
    expect(state.activeAgentId).toBe('developer')
    expect(state.loading).toBe(false)
  })

  it('повторный вызов не затирает уже выбранного агента', async () => {
    // Выбор, сделанный пользователем в текущей сессии, должен пережить
    // повторную загрузку списка (перемонтирование ChatInput после первого сообщения).
    useAgentsStore.setState({ activeAgentId: 'alistent' })
    vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })

    await useAgentsStore.getState().loadAgents('s1')

    const state = useAgentsStore.getState()
    expect(state.activeAgentId).toBe('alistent')
    expect(state.defaultAgentId).toBe('developer')
  })

  it('при ошибке загрузки не трогает уже выбранного агента', async () => {
    useAgentsStore.setState({ activeAgentId: 'alistent' })
    vi.mocked(synthApi.getAgents).mockRejectedValue(new Error('network'))

    await useAgentsStore.getState().loadAgents('s1')

    const state = useAgentsStore.getState()
    expect(state.activeAgentId).toBe('alistent')
    expect(state.loading).toBe(false)
  })
})

describe('agentsStore.applyEvent (событие шины `agents.updated`)', () => {
  it('поднимает revision и перечитывает состав', async () => {
    vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })

    useAgentsStore.getState().applyEvent()

    expect(useAgentsStore.getState().revision).toBe(1)
    await vi.waitFor(() => {
      expect(useAgentsStore.getState().agents).toEqual(AGENTS)
    })
    expect(synthApi.getAgents).toHaveBeenCalledTimes(1)
  })

  it('каждый вызов увеличивает revision (панель реагирует на любое событие)', () => {
    vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })

    useAgentsStore.getState().applyEvent()
    useAgentsStore.getState().applyEvent()

    expect(useAgentsStore.getState().revision).toBe(2)
  })

  it('исчезнувший активный агент (удалён/выключен) откатывается на default_agent', async () => {
    // Пользователь выбрал агента, которого после события в реестре больше нет.
    useAgentsStore.setState({ activeAgentId: 'alistent', defaultAgentId: 'developer' })
    vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [AGENTS[0]!], default_agent: 'developer' })

    useAgentsStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useAgentsStore.getState().activeAgentId).toBe('developer')
    })
    expect(useAgentsStore.getState().agents.map((a) => a.id)).toEqual(['developer'])
  })

  it('живой активный агент сохраняется — выбор не сбрасывается', async () => {
    useAgentsStore.setState({ activeAgentId: 'alistent', defaultAgentId: 'developer' })
    vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })

    useAgentsStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useAgentsStore.getState().agents).toEqual(AGENTS)
    })
    expect(useAgentsStore.getState().activeAgentId).toBe('alistent')
  })

  it('ошибка перечитывания не сбрасывает выбор', async () => {
    useAgentsStore.setState({ activeAgentId: 'alistent', defaultAgentId: 'developer' })
    vi.mocked(synthApi.getAgents).mockRejectedValue(new Error('network'))

    useAgentsStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useAgentsStore.getState().loading).toBe(false)
    })
    expect(useAgentsStore.getState().activeAgentId).toBe('alistent')
    expect(useAgentsStore.getState().revision).toBe(1)
  })
})
