// agents: домен API v2 (ADR-095) — объект `agentsApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'
import type { EffortLevel } from '@itphx/synth-shared/types'

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
  /**
   * ADR-117: явный тир усилия агента (`low|medium|high|xhigh|max`).
   * Отсутствует/`null` — «Авто»: тир выводится из уровня размышлений.
   */
  effort?: EffortLevel | null
  max_steps: number | null
  provider: string | null
  model: string | null
  context_file: string | null
  /**
   * PROP-135 Ф6a: профиль исполнения агента (`execution.remote.profiles`).
   * `null`/отсутствует — наследовать профиль проекта/инстанса.
   */
  executor_profile?: string | null
  /**
   * PROP-135 Ф6a: потолок разрешённых профилей агента.
   * `null`/пустой список — без ограничения.
   */
  allowed_profiles?: string[] | null
  /**
   * PROP-135 (браузерный контур): профиль браузерного пула агента.
   * `null`/отсутствует — наследовать профиль проекта/инстанса.
   */
  browser_profile?: string | null
  /** PROP-135 (браузерный контур): потолок браузерных профилей агента. */
  allowed_browser_profiles?: string[] | null
  is_builtin: boolean
  is_overridden: boolean
}

/**
 * Тело `POST /agents` (создание/обновление override).
 *
 * Поля профиля исполнения: `executor_profile` — строка или `null` (сброс),
 * `allowed_profiles` — массив имён или `null`/`[]` (снять ограничение);
 * отсутствие поля сохраняет прежнее значение записи.
 */
export interface AgentSavePayload {
  id: string
  display_name?: string
  description?: string
  provider?: string
  model?: string
  temperature?: number | null
  top_p?: number
  top_k?: number
  reasoning_level?: string
  effort?: EffortLevel | null
  mode?: 'simple'
  agent_mode?: AgentMode[]
  context_file?: string
  capabilities?: string[]
  max_steps?: number
  icon?: string
  color?: string
  executor_profile?: string | null
  allowed_profiles?: string[] | null
  /** PROP-135 (браузерный контур): профиль браузерного пула агента. */
  browser_profile?: string | null
  /** PROP-135 (браузерный контур): потолок браузерных профилей агента. */
  allowed_browser_profiles?: string[] | null
  [key: string]: unknown
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

  async saveAgent(data: AgentSavePayload): Promise<AgentInfo> {
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
