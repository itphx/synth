import { create } from 'zustand'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

interface AgentsStore {
  agents: AgentInfo[]
  activeAgentId: string | null
  defaultAgentId: string | null
  loading: boolean
  /**
   * Счётчик изменений реестра агентов (событие шины `agents.updated`).
   *
   * Растёт на каждое серверное событие — по нему перечитывают состав те
   * компоненты, у которых своего списка нет (`AgentsPanel` → `GET /agents/all`).
   * Сам стор тоже перечитывает `GET /agents` (селекты агента в чате/настройках).
   */
  revision: number
  loadAgents: (sessionId?: string) => Promise<void>
  setActiveAgentId: (id: string | null) => void
  /**
   * Реестр агентов изменился на сервере (агент создан/обновлён/удалён/
   * включён-выключен): поднять `revision` и перечитать состав.
   */
  applyEvent: () => void
}

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  agents: [],
  activeAgentId: null,
  defaultAgentId: null,
  loading: false,
  revision: 0,

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

  applyEvent: () => {
    set((s) => ({ revision: s.revision + 1 }))
    void get()
      .loadAgents()
      .then(() => {
        // Выбранный агент мог исчезнуть из нового списка (удалён/выключен):
        // оставлять его активным нельзя — селект показывал бы несуществующую
        // роль. Откат — на дефолтного агента. Пустой список (ошибка загрузки
        // или реестр без агентов) выбор не трогает.
        const s = get()
        if (s.agents.length === 0) return
        if (s.activeAgentId && s.agents.every((a) => a.id !== s.activeAgentId)) {
          set({ activeAgentId: s.defaultAgentId })
        }
      })
  },
}))
