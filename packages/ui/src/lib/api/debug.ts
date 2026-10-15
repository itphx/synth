// debug: домен API v2 (ADR-095) — объект `debugApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/** Конфиг debug-логов (admin: `GET/POST /admin/debug/config`). */
export interface DebugConfigData {
  groups: Record<string, string>
  available_levels: string[]
}

export const debugApi = {
  // Debug (admin)
  async getDebugConfig<T = DebugConfigData>(): Promise<T> {
    return fetchJSON<T>(`${BASE_URL}/admin/debug/config`)
  },

  async saveDebugConfig(groups: Record<string, string>): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/admin/debug/config`, {
      method: 'POST',
      body: JSON.stringify({ groups }),
    })
  },
}
