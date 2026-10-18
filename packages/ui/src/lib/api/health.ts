// health: домен API v2 (ADR-095) — объект `healthApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export const healthApi = {
  /** Публичный health-эндпоинт (без auth): проверка версии сервера на клиенте. */
  async getHealth(): Promise<{ status: string; version: string; time: string; startedAt?: string }> {
    return fetchJSON(`${BASE_URL}/health`)
  },

  async checkUpdate(): Promise<{ currentVersion: string; latestVersion: string; hasUpdate: boolean; checkedAt: string }> {
    return fetchJSON(`${BASE_URL}/updates/check`)
  },
}
