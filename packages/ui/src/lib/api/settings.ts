// settings: домен API v2 (ADR-095) — объект `settingsApi` и его DTO.

import type { ToolsDisabledConfig } from '@itphx/synth-shared'
import type { ToolsPolicy } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export const settingsApi = {
  // --- Инструменты: политика включения (ADR-071 §2.3) ---
  async getToolsPolicyInfo(): Promise<{ policy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }> {
    return fetchJSON<{ toolsPolicy: ToolsPolicy; isOverridden: boolean; defaults: ToolsPolicy }>(
      `${BASE_URL}/settings/tools-policy`,
    ).then((r) => ({ policy: r.toolsPolicy, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveToolsPolicy(toolsPolicy: ToolsPolicy): Promise<ToolsPolicy> {
    return fetchJSON<{ toolsPolicy: ToolsPolicy }>(`${BASE_URL}/settings/tools-policy`, {
      method: 'PUT',
      body: JSON.stringify({ toolsPolicy }),
    }).then((r) => r.toolsPolicy)
  },

  /** DELETE /settings/tools-policy — сброс к config-дефолту (live-применение). */
  async resetToolsPolicy(): Promise<ToolsPolicy> {
    return fetchJSON<{ toolsPolicy: ToolsPolicy }>(`${BASE_URL}/settings/tools-policy`, {
      method: 'DELETE',
    }).then((r) => r.toolsPolicy)
  },

  // --- Инструменты: instance-wide отключение (ADR-071 §2.6) ---
  /** GET /settings/tools-disabled — жёстко отключённые admin'ом capability и тулы. */
  async getToolsDisabledInfo(): Promise<{
    config: ToolsDisabledConfig
    isOverridden: boolean
    defaults: ToolsDisabledConfig
  }> {
    return fetchJSON<{ toolsDisabled: ToolsDisabledConfig; isOverridden: boolean; defaults: ToolsDisabledConfig }>(
      `${BASE_URL}/settings/tools-disabled`,
    ).then((r) => ({ config: r.toolsDisabled, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  /** PUT /settings/tools-disabled — сохранить и live-применить отключение инструментов. */
  async saveToolsDisabled(config: ToolsDisabledConfig): Promise<ToolsDisabledConfig> {
    return fetchJSON<{ toolsDisabled: ToolsDisabledConfig }>(`${BASE_URL}/settings/tools-disabled`, {
      method: 'PUT',
      body: JSON.stringify({ toolsDisabled: config }),
    }).then((r) => r.toolsDisabled)
  },

  /** DELETE /settings/tools-disabled — сброс к config-дефолту (пусто; live-применение). */
  async resetToolsDisabled(): Promise<ToolsDisabledConfig> {
    return fetchJSON<{ toolsDisabled: ToolsDisabledConfig }>(`${BASE_URL}/settings/tools-disabled`, {
      method: 'DELETE',
    }).then((r) => r.toolsDisabled)
  },

  // --- Агент по умолчанию (админка «Агенты») ---
  /** GET /settings/default-agent — эффективный агент по умолчанию и источник значения. */
  async getDefaultAgentInfo(): Promise<{ defaultAgent: string; isOverridden: boolean; defaults: string }> {
    return fetchJSON<{ defaultAgent: string; isOverridden: boolean; defaults: string }>(
      `${BASE_URL}/settings/default-agent`,
    )
  },

  /** PUT /settings/default-agent — сохранить агента по умолчанию (live-применение). */
  async setDefaultAgent(defaultAgent: string): Promise<{ defaultAgent: string }> {
    return fetchJSON<{ defaultAgent: string }>(`${BASE_URL}/settings/default-agent`, {
      method: 'PUT',
      body: JSON.stringify({ defaultAgent }),
    })
  },

  /** DELETE /settings/default-agent — сброс к дефолту (`DEFAULT_AGENT_ID`). */
  async resetDefaultAgent(): Promise<{ status: string; defaultAgent: string; isOverridden: boolean; defaults: string }> {
    return fetchJSON<{ status: string; defaultAgent: string; isOverridden: boolean; defaults: string }>(
      `${BASE_URL}/settings/default-agent`,
      { method: 'DELETE' },
    )
  },
}
