import { create } from 'zustand'
import type { McpNetworkPolicy, McpRegistryEntry, ToolsDisabledConfig } from '@itphx/synth-shared'
import {
  synthApi,
  type McpRegistryAddInput,
  type McpRegistryUpdateInput,
  type McpServerToolsSettings,
} from '../lib/api/synthApi'

interface McpStore {
  /** AD-071 §2.5: единый реестр MCP-серверов (instance + пользовательские). */
  registry: McpRegistryEntry[] | null
  loading: boolean
  error: string | null

  // Настройки доступности инструментов по режимам (W4c)
  toolSettings: Record<string, McpServerToolsSettings> | null
  toolSettingsLoading: boolean
  toolSettingsError: string | null

  // AD-071 §2.3.1: политика сетевого доступа пользовательских HTTP MCP
  networkPolicy: McpNetworkPolicy | null
  networkPolicyLoading: boolean
  networkPolicyError: string | null

  // AD-071 §2.6: instance-wide жёсткое отключение инструментов администратором
  toolsDisabled: ToolsDisabledConfig | null
  toolsDisabledLoading: boolean
  toolsDisabledError: string | null

  fetchRegistry: () => Promise<void>
  addRegistryEntry: (input: McpRegistryAddInput) => Promise<McpRegistryEntry>
  updateRegistryEntry: (id: string, patch: McpRegistryUpdateInput) => Promise<McpRegistryEntry>
  deleteRegistryEntry: (id: string) => Promise<void>

  fetchToolSettings: () => Promise<void>
  updateToolAvailability: (name: string, toolName: string | 'default', mode: 'plan' | 'act', value: boolean) => void
  saveToolSettings: () => Promise<void>
  probeServer: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description: string }>; error?: string }>

  fetchNetworkPolicy: () => Promise<void>
  saveNetworkPolicy: (policy: McpNetworkPolicy) => Promise<void>

  fetchToolsDisabled: () => Promise<void>
  saveToolsDisabled: (config: ToolsDisabledConfig) => Promise<void>
}

const DEFAULT_AVAILABILITY = { plan: false, act: true }

export const useMcpStore = create<McpStore>((set, get) => ({
  registry: null,
  loading: false,
  error: null,

  toolSettings: null,
  toolSettingsLoading: false,
  toolSettingsError: null,

  networkPolicy: null,
  networkPolicyLoading: false,
  networkPolicyError: null,

  toolsDisabled: null,
  toolsDisabledLoading: false,
  toolsDisabledError: null,

  fetchRegistry: async () => {
    set({ loading: true, error: null })
    try {
      const { entries } = await synthApi.getMcpRegistry()
      set({ registry: entries, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка загрузки реестра MCP', loading: false })
    }
  },

  addRegistryEntry: async (input) => {
    set({ loading: true, error: null })
    try {
      const entry = await synthApi.addMcpRegistryEntry(input)
      const current = get().registry || []
      set({ registry: [...current, entry].sort((a, b) => a.name.localeCompare(b.name)), loading: false })
      return entry
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка добавления сервера', loading: false })
      throw err
    }
  },

  updateRegistryEntry: async (id, patch) => {
    set({ loading: true, error: null })
    try {
      const entry = await synthApi.updateMcpRegistryEntry(id, patch)
      const current = get().registry || []
      set({
        registry: current
          .map((e) => (e.id === id ? entry : e))
          .sort((a, b) => a.name.localeCompare(b.name)),
        loading: false,
      })
      return entry
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка обновления сервера', loading: false })
      throw err
    }
  },

  deleteRegistryEntry: async (id) => {
    set({ loading: true, error: null })
    try {
      await synthApi.deleteMcpRegistryEntry(id)
      set({ registry: (get().registry || []).filter((e) => e.id !== id), loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Ошибка удаления сервера', loading: false })
      throw err
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

  fetchNetworkPolicy: async () => {
    set({ networkPolicyLoading: true, networkPolicyError: null })
    try {
      const policy = await synthApi.getMcpNetworkPolicy()
      set({ networkPolicy: policy, networkPolicyLoading: false })
    } catch (err) {
      set({
        networkPolicyError: err instanceof Error ? err.message : 'Ошибка загрузки сетевой политики',
        networkPolicyLoading: false,
      })
    }
  },

  saveNetworkPolicy: async (policy) => {
    set({ networkPolicyLoading: true, networkPolicyError: null })
    try {
      const saved = await synthApi.saveMcpNetworkPolicy(policy)
      set({ networkPolicy: saved, networkPolicyLoading: false })
    } catch (err) {
      set({
        networkPolicyError: err instanceof Error ? err.message : 'Ошибка сохранения сетевой политики',
        networkPolicyLoading: false,
      })
      throw err
    }
  },

  fetchToolsDisabled: async () => {
    set({ toolsDisabledLoading: true, toolsDisabledError: null })
    try {
      const config = await synthApi.getToolsDisabled()
      set({ toolsDisabled: config, toolsDisabledLoading: false })
    } catch (err) {
      set({
        toolsDisabledError: err instanceof Error ? err.message : 'Ошибка загрузки отключённых инструментов',
        toolsDisabledLoading: false,
      })
    }
  },

  saveToolsDisabled: async (config) => {
    set({ toolsDisabledLoading: true, toolsDisabledError: null })
    try {
      const saved = await synthApi.saveToolsDisabled(config)
      set({ toolsDisabled: saved, toolsDisabledLoading: false })
    } catch (err) {
      set({
        toolsDisabledError: err instanceof Error ? err.message : 'Ошибка сохранения отключённых инструментов',
        toolsDisabledLoading: false,
      })
      throw err
    }
  },
}))
