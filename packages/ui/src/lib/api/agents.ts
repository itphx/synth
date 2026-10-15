// agents: домен API v2 (ADR-095) — объект `agentsApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export type AgentMode = 'primary' | 'subagent' | 'system'

export interface AgentInfo {
  id: string
  display_name: string
  capabilities: string[]
  enabled: boolean
  icon: string | null
  color: string | null
  description: string | null
  available: boolean
  mode: 'simple' | 'orchestrator'
  agent_mode: AgentMode[] | null
  reasoning_level?: string | null
  subagent_prompt: string | null
  max_steps: number | null
  provider: string | null
  model: string | null
  context_file: string | null
  is_builtin: boolean
  is_overridden: boolean
}

export interface AgentsListResponse {
  agents: AgentInfo[]
  default_agent: string | null
}

export const agentsApi = {
  // Агенты
  async getAgents(sessionId?: string): Promise<AgentsListResponse> {
    const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    return fetchJSON<AgentsListResponse>(`${BASE_URL}/agents${params}`)
  },

  // Все агенты (для админки, GET /agents/all)
  async getAllAgents(): Promise<AgentsListResponse> {
    return fetchJSON<AgentsListResponse>(`${BASE_URL}/agents/all`)
  },

  // Агенты (admin)
  async getAgentDetail(id: string): Promise<Record<string, unknown>> {
    return fetchJSON<Record<string, unknown>>(`${BASE_URL}/agents/${encodeURIComponent(id)}`)
  },

  async saveAgent(data: Record<string, unknown>): Promise<AgentInfo> {
    return fetchJSON<AgentInfo>(`${BASE_URL}/agents`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async toggleAgent(id: string, enabled: boolean): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/agents/${encodeURIComponent(id)}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  },

  async deleteAgent(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}
