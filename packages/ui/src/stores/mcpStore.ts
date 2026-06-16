import { create } from 'zustand'
import { synthApi, type McpServerConfig, type McpServerEntry } from '../lib/api/synthApi'

interface McpStore {
  servers: Record<string, McpServerEntry> | null
  loading: boolean
  error: string | null

  fetchServers: () => Promise<void>
  addServer: (name: string, config: McpServerConfig) => Promise<void>
  updateServer: (name: string, config: McpServerConfig) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  testServer: (name: string, config?: McpServerConfig) => Promise<{ success: boolean; toolCount?: number; error?: string }>
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: null,
  loading: false,
  error: null,

  fetchServers: async () => {
    set({ loading: true, error: null })
    try {
      const servers = await synthApi.getMcpServers()
      set({ servers, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка загрузки серверов', loading: false })
    }
  },

  addServer: async (name, config) => {
    set({ loading: true, error: null })
    try {
      const entry = await synthApi.addMcpServer(name, config)
      const current = get().servers || {}
      set({ servers: { ...current, [name]: entry }, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка добавления сервера', loading: false })
      throw err
    }
  },

  updateServer: async (name, config) => {
    set({ loading: true, error: null })
    try {
      const entry = await synthApi.updateMcpServer(name, config)
      const current = get().servers || {}
      set({ servers: { ...current, [name]: entry }, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка обновления сервера', loading: false })
      throw err
    }
  },

  deleteServer: async (name) => {
    set({ loading: true, error: null })
    try {
      await synthApi.deleteMcpServer(name)
      const current = get().servers || {}
      const newServers = { ...current }
      delete newServers[name]
      set({ servers: newServers, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка удаления сервера', loading: false })
      throw err
    }
  },

  testServer: async (name, config?) => {
    try {
      return await synthApi.testMcpServer(name, config)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Ошибка тестирования' }
    }
  },
}))
