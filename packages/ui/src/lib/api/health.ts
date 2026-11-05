// health: домен API v2 (ADR-095) — объект `healthApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export const healthApi = {
  /**
   * Публичный health-эндпоинт (без auth): проверка версии сервера на клиенте.
   * `build` — идентификатор сборки (аддитивно, ADR: PWA обновление); пусто —
   * неизвестен, тогда клиент сравнивает semver.
   */
  async getHealth(): Promise<{
    status: string
    version: string
    time: string
    startedAt?: string
    build?: string
  }> {
    return fetchJSON(`${BASE_URL}/health`)
  },

  async checkUpdate(): Promise<{ currentVersion: string; latestVersion: string; hasUpdate: boolean; checkedAt: string }> {
    return fetchJSON(`${BASE_URL}/updates/check`)
  },
}
