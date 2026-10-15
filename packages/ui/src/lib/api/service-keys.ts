// service-keys: домен API v2 (ADR-095) — объект `serviceKeysApi` и его DTO.

import type {
  CreateServiceApiKeyInput,
  ServiceApiKey,
  ServiceApiKeyCreated,
  UpdateServiceApiKeyPatch,
} from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

export const serviceKeysApi = {
  // --- Service-key (ADR-052, этап I): scoped-ключи инстанса ---
  /** GET /service-keys — список service-ключей (без секретов). */
  async getServiceKeys(): Promise<{ keys: ServiceApiKey[] }> {
    return fetchJSON<{ keys: ServiceApiKey[] }>(`${BASE_URL}/service-keys`)
  },

  /** GET /service-keys/scopes — каталог scope'ов/семейств/ролей для форм (ADR-052). */
  async getServiceKeyScopes(): Promise<{ scopes: string[]; families: string[]; roles: string[] }> {
    return fetchJSON<{ scopes: string[]; families: string[]; roles: string[] }>(
      `${BASE_URL}/service-keys/scopes`,
    )
  },

  /** GET /service-keys/:id — метаданные одного service-ключа. */
  async getServiceKey(id: string): Promise<ServiceApiKey> {
    return fetchJSON<ServiceApiKey>(`${BASE_URL}/service-keys/${encodeURIComponent(id)}`)
  },

  /** POST /service-keys — создание ключа; секрет (`key`) возвращается один раз. */
  async createServiceKey(input: CreateServiceApiKeyInput): Promise<ServiceApiKeyCreated> {
    return fetchJSON<ServiceApiKeyCreated>(`${BASE_URL}/service-keys`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PATCH /service-keys/:id — частичное обновление (`null` сбрасывает поле). */
  async updateServiceKey(id: string, patch: UpdateServiceApiKeyPatch): Promise<ServiceApiKey> {
    return fetchJSON<ServiceApiKey>(`${BASE_URL}/service-keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** DELETE /service-keys/:id — удаление ключа. */
  async deleteServiceKey(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/service-keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** POST /service-keys/:id/revoke — мягкий отзыв ключа (идемпотентно). */
  async revokeServiceKey(id: string): Promise<ServiceApiKey> {
    return fetchJSON<ServiceApiKey>(`${BASE_URL}/service-keys/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    })
  },
}
