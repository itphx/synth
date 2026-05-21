import { create } from 'zustand'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

interface AgentsStore {
  agents: AgentInfo[]
  activeAgentId: string | null
  loading: boolean
  loadAgents: (sessionId?: string) => Promise<void>
  setActiveAgentId: (id: string | null) => void
}

export const useAgentsStore = create<AgentsStore>((set) => ({
  agents: [],
  activeAgentId: null,
  loading: false,

  loadAgents: async (sessionId?: string) => {
    set({ loading: true })
    try {
      const { agents, default_agent } = await synthApi.getAgents(sessionId)
      set({ agents, loading: false, activeAgentId: default_agent })
    } catch {
      set({ loading: false })
    }
  },

  setActiveAgentId: (id) => set({ activeAgentId: id }),
}))