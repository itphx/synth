import { create } from 'zustand'
import { synthApi, type McpServerConfig, type McpServerEntry, type McpServerToolsSettings } from '../lib/api/synthApi'

interface McpStore {
  servers: Record<string, McpServerEntry> | null
  loading: boolean
  error: string | null

  // Настройки доступности инструментов по режимам (W4c)
  toolSettings: Record<string, McpServerToolsSettings> | null
  toolSettingsLoading: boolean
  toolSettingsError: string | null

  fetchServers: () => Promise<void>
  addServer: (name: string, config: McpServerConfig) => Promise<void>
  updateServer: (name: string, config: McpServerConfig) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  testServer: (name: string, config?: McpServerConfig) => Promise<{ success: boolean; toolCount?: number; error?: string }>

  fetchToolSettings: () => Promise<void>
  updateToolAvailability: (name: string, toolName: string | 'default', mode: 'plan' | 'act', value: boolean) => void
  saveToolSettings: () => Promise<void>
  probeServer: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description: string }>; error?: string }>
}

const DEFAULT_AVAILABILITY = { plan: false, act: true }

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: null,
  loading: false,
  error: null,

  toolSettings: null,
  toolSettingsLoading: false,
  toolSettingsError: null,

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

  fetchToolSettings: async () => {
    set({ toolSettingsLoading: true, toolSettingsError: null })
    try {
      const payload = await synthApi.getMcpToolSettings()
      set({ toolSettings: payload.servers, toolSettingsLoading: false })
    } catch (err) {
      set({
        toolSettingsError: err instanceof Error ? err.message : 'Ошибка загрузки настроек MCP',
        toolSettingsLoading: false,
      })
    }
  },

  updateToolAvailability: (name, toolName, mode, value) => {
    const current = get().toolSettings || {}
    const entry = current[name] ?? { default: { ...DEFAULT_AVAILABILITY }, tools: {} }
    if (toolName === 'default') {
      set({ toolSettings: { ...current, [name]: { ...entry, default: { ...entry.default, [mode]: value } } } })
      return
    }
    const tool = entry.tools[toolName] ?? { ...entry.default }
    set({
      toolSettings: {
        ...current,
        [name]: { ...entry, tools: { ...entry.tools, [toolName]: { ...tool, [mode]: value } } },
      },
    })
  },

  saveToolSettings: async () => {
    set({ toolSettingsLoading: true, toolSettingsError: null })
    try {
      const servers = get().toolSettings || {}
      const payload = await synthApi.saveMcpToolSettings(servers)
      set({ toolSettings: payload.servers, toolSettingsLoading: false })
    } catch (err) {
      set({
        toolSettingsError: err instanceof Error ? err.message : 'Ошибка сохранения настроек MCP',
        toolSettingsLoading: false,
      })
      throw err
    }
  },

  probeServer: async (name) => {
    try {
      const result = await synthApi.probeMcpServer(name)
      return { success: true, tools: result.tools }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Ошибка проверки подключения' }
    }
  },
}))
