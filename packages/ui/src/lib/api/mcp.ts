// mcp: домен API v2 (ADR-095) — объект `mcpApi` и его DTO.

import type {
  McpNetworkPolicy,
  McpRegistryEntry,
  McpServerConfig,
  McpServerEffective,
} from '@itphx/synth-shared'
import type { ToolsPolicy } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

/** ADR-071 §2.4/§2.6: ответ GET /sessions/:id/mcp — эффективный MCP-скоуп сессии. */
export interface SessionMcpEffectiveResponse {
  servers: McpServerEffective[]
  enabled: string[]
  disabled: string[]
  mcpServers: string[]
  mcpDisabledServers: string[]
}

export interface McpProbedTool {
  name: string
  description: string
}

export interface McpModeAvailability {
  plan: boolean
  act: boolean
}

export interface McpServerToolsSettings {
  default: McpModeAvailability
  tools: Record<string, McpModeAvailability>
}

export interface McpSettingsPayload {
  servers: Record<string, McpServerToolsSettings>
}

/** ADR-071 §2.5: тело добавления записи реестра MCP. */
export interface McpRegistryAddInput {
  name: string
  config: McpServerConfig
  /** Системный мастер-флаг (hard-gate): `false` — сервер недоступен нигде. */
  enabled?: boolean
  enabledByDefault?: boolean
  origin?: 'instance' | 'user'
}

/** ADR-071 §2.5: тело обновления записи реестра MCP. */
export interface McpRegistryUpdateInput {
  name?: string
  config?: McpServerConfig
  /** Системный мастер-флаг (hard-gate). */
  enabled?: boolean
  enabledByDefault?: boolean
}

export const mcpApi = {
  /** ADR-071 §2.4/§2.6: эффективный MCP-скоуп сессии (включая отключённые с причиной). */
  async getSessionMcpEffective(sessionId: string): Promise<SessionMcpEffectiveResponse> {
    return fetchJSON<SessionMcpEffectiveResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/mcp`)
  },

  /**
   * ADR-071 §2.4: переключение MCP-сервера в сессии. Точечный toggle `{ name, enabled }`
   * (в т.ч. opt-out системного) либо полная замена `{ mcpServers, mcpDisabledServers }`.
   */
  async updateSessionMcp(
    sessionId: string,
    body: { name?: string; enabled?: boolean; mcpServers?: string[]; mcpDisabledServers?: string[] },
  ): Promise<SessionMcpEffectiveResponse> {
    return fetchJSON<SessionMcpEffectiveResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/mcp`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  // --- MCP: доступность инструментов по режимам (W4c) ---
  async getMcpToolSettings(): Promise<McpSettingsPayload> {
    return fetchJSON(`${BASE_URL}/settings/mcp`)
  },

  async saveMcpToolSettings(servers: Record<string, McpServerToolsSettings>): Promise<McpSettingsPayload> {
    return fetchJSON(`${BASE_URL}/settings/mcp`, {
      method: 'PUT',
      body: JSON.stringify({ servers }),
    })
  },

  /** DELETE /settings/mcp — сброс runtime-настроек доступности MCP к дефолту (пусто). */
  async resetMcpSettings(): Promise<McpSettingsPayload> {
    return fetchJSON<McpSettingsPayload>(`${BASE_URL}/settings/mcp`, {
      method: 'DELETE',
    }).then((r) => ({ servers: r.servers }))
  },

  async probeMcpServer(name: string): Promise<{ name: string; tools: McpProbedTool[] }> {
    return fetchJSON(`${BASE_URL}/mcp/probe`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  // --- MCP: единый реестр (ADR-071 §2.5) ---
  async getMcpRegistry(): Promise<{ entries: McpRegistryEntry[] }> {
    return fetchJSON(`${BASE_URL}/mcp/registry`)
  },

  async addMcpRegistryEntry(input: McpRegistryAddInput): Promise<McpRegistryEntry> {
    return fetchJSON(`${BASE_URL}/mcp/registry`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async updateMcpRegistryEntry(id: string, patch: McpRegistryUpdateInput): Promise<McpRegistryEntry> {
    return fetchJSON(`${BASE_URL}/mcp/registry/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  async deleteMcpRegistryEntry(id: string): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/mcp/registry/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  // --- MCP: политика сетевого доступа (ADR-071 §2.3.1) ---
  async getMcpNetworkPolicyInfo(): Promise<{
    policy: McpNetworkPolicy
    isOverridden: boolean
    defaults: McpNetworkPolicy
  }> {
    return fetchJSON<{ policy: McpNetworkPolicy; isOverridden: boolean; defaults: McpNetworkPolicy }>(
      `${BASE_URL}/settings/mcp-network-policy`,
    ).then((r) => ({ policy: r.policy, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveMcpNetworkPolicy(policy: McpNetworkPolicy): Promise<McpNetworkPolicy> {
    return fetchJSON<{ policy: McpNetworkPolicy }>(`${BASE_URL}/settings/mcp-network-policy`, {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    }).then((r) => r.policy)
  },

  /** DELETE /settings/mcp-network-policy — сброс к дефолту (config или deny приватных диапазонов). */
  async resetMcpNetworkPolicy(): Promise<McpNetworkPolicy> {
    return fetchJSON<{ policy: McpNetworkPolicy }>(`${BASE_URL}/settings/mcp-network-policy`, {
      method: 'DELETE',
    }).then((r) => r.policy)
  },

  // --- MCP: политика включения MCP-инструментов (ADR-071 §2.3) ---
  async getMcpPolicyInfo(): Promise<{ policy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }> {
    return fetchJSON<{ mcpPolicy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }>(
      `${BASE_URL}/settings/mcp-policy`,
    ).then((r) => ({ policy: r.mcpPolicy, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveMcpPolicy(mcpPolicy: ToolsPolicy): Promise<ToolsPolicy> {
    return fetchJSON<{ mcpPolicy: ToolsPolicy }>(`${BASE_URL}/settings/mcp-policy`, {
      method: 'PUT',
      body: JSON.stringify({ mcpPolicy }),
    }).then((r) => r.mcpPolicy)
  },

  /** DELETE /settings/mcp-policy — сброс к config-дефолту (live-применение). */
  async resetMcpPolicy(): Promise<ToolsPolicy> {
    return fetchJSON<{ mcpPolicy: ToolsPolicy }>(`${BASE_URL}/settings/mcp-policy`, {
      method: 'DELETE',
    }).then((r) => r.mcpPolicy)
  },
}
