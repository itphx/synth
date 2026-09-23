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
    subagent_prompt: null,
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
  useAgentsStore.setState({ agents: [], activeAgentId: null, defaultAgentId: null, loading: false })
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
