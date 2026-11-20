import { create } from 'zustand'
import type {
  McpNetworkPolicy,
  McpRegistryEntry,
  McpUpdatedEventData,
  ToolsDisabledConfig,
} from '@itphx/synth-shared'
import {
  synthApi,
  type McpRegistryAddInput,
  type McpRegistryUpdateInput,
  type McpServerToolsSettings,
} from '../lib/api/synthApi'
import { i18nText } from '@/lib/i18n/text'

interface McpStore {
  /** ADR-071 §2.5: единый реестр MCP-серверов (instance + пользовательские). */
  registry: McpRegistryEntry[] | null
  loading: boolean
  error: string | null

  // Настройки доступности инструментов по режимам (W4c)
  toolSettings: Record<string, McpServerToolsSettings> | null
  toolSettingsLoading: boolean
  toolSettingsError: string | null

  // ADR-071 §2.3.1: политика сетевого доступа пользовательских HTTP MCP
  networkPolicy: McpNetworkPolicy | null
  /** Серверный дефолт сетевой политики (для `isDefault`/Reset в UI). */
  networkPolicyDefaults: McpNetworkPolicy | null
  networkPolicyLoading: boolean
  networkPolicyError: string | null

  // ADR-071 §2.6: instance-wide жёсткое отключение инструментов администратором
  toolsDisabled: ToolsDisabledConfig | null
  /** Серверный дефолт tools.disabled (для `isDefault`/Reset в UI). */
  toolsDisabledDefaults: ToolsDisabledConfig | null
  toolsDisabledLoading: boolean
  toolsDisabledError: string | null

  /**
   * Счётчик изменений реестра MCP (событие шины `mcp.updated`).
   *
   * Растёт на каждое серверное событие; по нему перечитывают своё состояние
   * панели с собственными данными (`McpSettings` → доступность инструментов,
   * `CredentialsSettings` → список внешних доступов). Сам реестр перечитывает
   * `applyEvent`.
   */
  revision: number
  /**
   * Счётчики изменений MCP **по проектам** (`mcp.updated` со `scope: 'project'`).
   *
   * Ключ — `projectId`. Панель проекта подписывается точечно: событие чужого
   * проекта её не перечитывает.
   */
  projectRevisions: Record<string, number>
  /** Счётчики изменений MCP **по сессиям** (`mcp.updated` со `scope: 'session'`). */
  sessionRevisions: Record<string, number>

  fetchRegistry: () => Promise<void>
  /**
   * Реестр MCP изменился на сервере (сервер добавлен/обновлён/удалён/
   * включён-выключен либо изменён MCP-скоуп проекта/сессии): поднять
   * `revision` и scoped-счётчики, перечитать реестр.
   */
  applyEvent: (info?: McpEventScope) => void
  addRegistryEntry: (input: McpRegistryAddInput) => Promise<McpRegistryEntry>
  updateRegistryEntry: (id: string, patch: McpRegistryUpdateInput) => Promise<McpRegistryEntry>
  deleteRegistryEntry: (id: string) => Promise<void>

  fetchToolSettings: () => Promise<void>
  updateToolAvailability: (name: string, toolName: string | 'default', mode: 'plan' | 'act', value: boolean) => void
  /** Локальная установка настроек (без запроса) — для reset/черновика. */
  setToolSettingsLocal: (servers: Record<string, McpServerToolsSettings>) => void
  saveToolSettings: () => Promise<void>
  probeServer: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description: string }>; error?: string }>

  fetchNetworkPolicy: () => Promise<void>
  /** Локальная установка сетевой политики (без запроса) — для reset/черновика. */
  setNetworkPolicyLocal: (policy: McpNetworkPolicy) => void
  saveNetworkPolicy: (policy: McpNetworkPolicy) => Promise<void>

  fetchToolsDisabled: () => Promise<void>
  saveToolsDisabled: (config: ToolsDisabledConfig) => Promise<void>
}

const DEFAULT_AVAILABILITY = { plan: false, act: true }

/**
 * Область события шины `mcp.updated` — то, что нужно стору, чтобы разложить
 * изменение по адресатам: имя сервера и вид мутации стору не нужны (событие —
 * сигнал «перечитай»; конфиг сервера в payload не кладётся — там секреты).
 */
/**
 * Область события `mcp.updated`, которую получает стор.
 *
 * Все поля опциональны: `transportStore` передаёт payload целиком
 * (`{action, name?, scope?, projectId?, sessionId?}`), а компоненты/тесты могут
 * дать только область. Обязательным остаётся сам сигнал — вызов `applyEvent()`.
 */
export type McpEventScope = Partial<McpUpdatedEventData>

export const useMcpStore = create<McpStore>((set, get) => ({
  registry: null,
  loading: false,
  error: null,

  toolSettings: null,
  toolSettingsLoading: false,
  toolSettingsError: null,

  networkPolicy: null,
  networkPolicyDefaults: null,
  networkPolicyLoading: false,
  networkPolicyError: null,

  toolsDisabled: null,
  toolsDisabledDefaults: null,
  toolsDisabledLoading: false,
  toolsDisabledError: null,

  revision: 0,
  projectRevisions: {},
  sessionRevisions: {},

  fetchRegistry: async () => {
    set({ loading: true, error: null })
    try {
      const { entries } = await synthApi.getMcpRegistry()
      set({ registry: entries, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18nText('mcp.error.loadRegistry'), loading: false })
    }
  },

  applyEvent: (info) => {
    const projectId = info?.projectId
    const sessionId = info?.sessionId
    // Счётчики поднимаются всегда (общий `revision`), scoped — только когда в
    // событии есть соответствующий id: панель чужого проекта/сессии не должна
    // перечитываться (её селектор не меняется).
    set((s) => ({
      revision: s.revision + 1,
      projectRevisions: projectId
        ? { ...s.projectRevisions, [projectId]: (s.projectRevisions[projectId] ?? 0) + 1 }
        : s.projectRevisions,
      sessionRevisions: sessionId
        ? { ...s.sessionRevisions, [sessionId]: (s.sessionRevisions[sessionId] ?? 0) + 1 }
        : s.sessionRevisions,
    }))
    // В событии нет тяжёлых данных (в конфиге MCP бывают секреты) — сигнал
    // означает «перечитай реестр». Отдельного «выбранного/редактируемого»
    // элемента у стора нет: `editing`/`deleteTarget` живут в
    // `useMcpRegistryEditor` и это черновик формы — его не сбрасываем
    // (задача: формы/черновики не трогать). Исчезнувший из реестра сервер
    // пропадает из списка сам — панель перерисовывается по новому составу.
    void get().fetchRegistry()
  },

  addRegistryEntry: async (input) => {
    set({ loading: true, error: null })
    try {
      const entry = await synthApi.addMcpRegistryEntry(input)
      const current = get().registry || []
      set({ registry: [...current, entry].sort((a, b) => a.name.localeCompare(b.name)), loading: false })
      return entry
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18nText('mcp.error.addServer'), loading: false })
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
      set({ error: err instanceof Error ? err.message : i18nText('mcp.error.updateServer'), loading: false })
      throw err
    }
  },

  deleteRegistryEntry: async (id) => {
    set({ loading: true, error: null })
    try {
      await synthApi.deleteMcpRegistryEntry(id)
      set({ registry: (get().registry || []).filter((e) => e.id !== id), loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18nText('mcp.error.deleteServer'), loading: false })
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
        toolSettingsError: err instanceof Error ? err.message : i18nText('mcp.error.loadToolSettings'),
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

  setToolSettingsLocal: (servers) => {
    set({ toolSettings: servers })
  },

  saveToolSettings: async () => {
    set({ toolSettingsLoading: true, toolSettingsError: null })
    try {
      const servers = get().toolSettings || {}
      const payload = await synthApi.saveMcpToolSettings(servers)
      set({ toolSettings: payload.servers, toolSettingsLoading: false })
    } catch (err) {
      set({
        toolSettingsError: err instanceof Error ? err.message : i18nText('mcp.error.saveToolSettings'),
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
      return { success: false, error: err instanceof Error ? err.message : i18nText('mcp.error.probe') }
    }
  },

  fetchNetworkPolicy: async () => {
    set({ networkPolicyLoading: true, networkPolicyError: null })
    try {
      const { policy, defaults } = await synthApi.getMcpNetworkPolicyInfo()
      set({ networkPolicy: policy, networkPolicyDefaults: defaults, networkPolicyLoading: false })
    } catch (err) {
      set({
        networkPolicyError: err instanceof Error ? err.message : i18nText('mcp.error.loadNetworkPolicy'),
        networkPolicyLoading: false,
      })
    }
  },

  setNetworkPolicyLocal: (policy) => {
    set({ networkPolicy: policy })
  },

  saveNetworkPolicy: async (policy) => {
    set({ networkPolicyLoading: true, networkPolicyError: null })
    try {
      const saved = await synthApi.saveMcpNetworkPolicy(policy)
      set({ networkPolicy: saved, networkPolicyLoading: false })
    } catch (err) {
      set({
        networkPolicyError: err instanceof Error ? err.message : i18nText('mcp.error.saveNetworkPolicy'),
        networkPolicyLoading: false,
      })
      throw err
    }
  },

  fetchToolsDisabled: async () => {
    set({ toolsDisabledLoading: true, toolsDisabledError: null })
    try {
      const { config, defaults } = await synthApi.getToolsDisabledInfo()
      set({ toolsDisabled: config, toolsDisabledDefaults: defaults, toolsDisabledLoading: false })
    } catch (err) {
      set({
        toolsDisabledError: err instanceof Error ? err.message : i18nText('mcp.error.loadToolsDisabled'),
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
        toolsDisabledError: err instanceof Error ? err.message : i18nText('mcp.error.saveToolsDisabled'),
        toolsDisabledLoading: false,
      })
      throw err
    }
  },
}))

/**
 * Revision изменений MCP **конкретного проекта** (`0` — событий не было).
 *
 * Селектор для `useMcpStore(...)`: панель проекта подписывается точечно и не
 * перечитывается на события чужих проектов.
 */
export function mcpRevisionForProject(
  store: Pick<McpStore, 'projectRevisions'>,
  projectId: string | null | undefined,
): number {
  if (!projectId) return 0
  return store.projectRevisions[projectId] ?? 0
}

/** Revision изменений MCP **конкретной сессии** (`0` — событий не было). */
export function mcpRevisionForSession(
  store: Pick<McpStore, 'sessionRevisions'>,
  sessionId: string | null | undefined,
): number {
  if (!sessionId) return 0
  return store.sessionRevisions[sessionId] ?? 0
}

/** Хук-обёртка над `mcpRevisionForProject` (подписка точечная). */
export function useMcpRevisionForProject(projectId: string | null | undefined): number {
  return useMcpStore((s) => mcpRevisionForProject(s, projectId))
}

/** Хук-обёртка над `mcpRevisionForSession` (подписка точечная). */
export function useMcpRevisionForSession(sessionId: string | null | undefined): number {
  return useMcpStore((s) => mcpRevisionForSession(s, sessionId))
}
