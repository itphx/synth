import { create } from 'zustand'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

interface AgentsStore {
  agents: AgentInfo[]
  activeAgentId: string | null
  defaultAgentId: string | null
  loading: boolean
  loadAgents: (sessionId?: string) => Promise<void>
  setActiveAgentId: (id: string | null) => void
}

export const useAgentsStore = create<AgentsStore>((set) => ({
  agents: [],
  activeAgentId: null,
  defaultAgentId: null,
  loading: false,

  loadAgents: async (sessionId?: string) => {
    set({ loading: true })
    try {
      const { agents, default_agent } = await synthApi.getAgents(sessionId)
      // Не затираем уже выбранного агента: при перезагрузке списка (в т.ч. при
      // перемонтировании ChatInput) сохраняем выбор; ChatTab выставляет агента
      // из session.settings.agentRole при переключении сессии.
      set((s) => ({ agents, loading: false, defaultAgentId: default_agent, activeAgentId: s.activeAgentId ?? default_agent }))
    } catch {
      set({ loading: false })
    }
  },

  setActiveAgentId: (id) => set({ activeAgentId: id }),
}))