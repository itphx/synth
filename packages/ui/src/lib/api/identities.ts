// identities: домен API v2 (ADR-095) — объект `identitiesApi` и его DTO.

import type { ExternalIdentity } from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

export const identitiesApi = {
  // --- Идентичности текущего пользователя (ADR-089) ---
  /** GET /me/identities — внешние идентичности, привязанные к профилю. */
  async getMyIdentities(): Promise<{ identities: ExternalIdentity[] }> {
    return fetchJSON<{ identities: ExternalIdentity[] }>(`${BASE_URL}/me/identities`)
  },

  /** DELETE /me/identities/:provider/:externalId — отвязать идентичность (только свои). */
  async deleteMyIdentity(provider: string, externalId: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/me/identities/${encodeURIComponent(provider)}/${encodeURIComponent(externalId)}`,
      { method: 'DELETE' },
    )
  },

  /**
   * POST /me/identities/claim — подтвердить владение внешней идентичностью по
   * одноразовому коду (ADR-089 claim-flow). `provider`/`externalId` берутся ядром
   * из серверной записи claim, а не из тела — подставить чужой id нельзя.
   */
  async claimIdentity(code: string): Promise<{ identity: ExternalIdentity }> {
    return fetchJSON<{ identity: ExternalIdentity }>(`${BASE_URL}/me/identities/claim`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
  },
}
