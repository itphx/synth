// ssh-keys: домен API v2 (ADR-095) — объект `sshKeysApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/** ADR-076: публичная форма SSH-ключа (секреты `privateKey`/`passphrase` API не отдаёт). */
export interface SSHKeyMetaData {
  id: string
  name: string
  /** Метка типа ключа, дефолт `'user'`. */
  type?: string
  agentIds: string[]
  createdAt: string
  updatedAt?: string
}

/** ADR-076: тело создания SSH-ключа (`POST /ssh-keys`). */
export interface SSHKeyCreateBody {
  name: string
  type?: string
  privateKey: string
  passphrase?: string
  agentIds?: string[]
}

/** ADR-076: тело обновления SSH-ключа (partial; без `privateKey` секрет не меняется). */
export type SSHKeyUpdateBody = Partial<SSHKeyCreateBody>

export const sshKeysApi = {
  // SSH-ключи (ADR-076). Секреты API не возвращает — только SSHKeyMeta.
  async listSshKeys(agentId?: string): Promise<SSHKeyMetaData[]> {
    const params = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
    return fetchJSON(`${BASE_URL}/ssh-keys${params}`)
  },

  /** ADR-076: создание ключа (write — ADMIN). */
  async createSshKey(body: SSHKeyCreateBody): Promise<SSHKeyMetaData> {
    return fetchJSON(`${BASE_URL}/ssh-keys`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /** ADR-076: частичное обновление; без `privateKey` в теле секрет не меняется. */
  async updateSshKey(id: string, body: SSHKeyUpdateBody): Promise<SSHKeyMetaData> {
    return fetchJSON(`${BASE_URL}/ssh-keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  },

  /** ADR-076: удаление ключа целиком. */
  async deleteSshKey(id: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/ssh-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  /** ADR-076 (nested): ключи агента. */
  async listAgentSshKeys(agentId: string): Promise<SSHKeyMetaData[]> {
    return fetchJSON(`${BASE_URL}/agents/${encodeURIComponent(agentId)}/ssh-keys`)
  },

  /** ADR-076 (nested): создание ключа с привязкой к агенту. */
  async createAgentSshKey(agentId: string, body: SSHKeyCreateBody): Promise<SSHKeyMetaData> {
    return fetchJSON(`${BASE_URL}/agents/${encodeURIComponent(agentId)}/ssh-keys`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /** ADR-076 (nested): отвязка ключа от агента (ключ НЕ удаляется). */
  async unlinkAgentSshKey(agentId: string, keyId: string): Promise<SSHKeyMetaData> {
    return fetchJSON(
      `${BASE_URL}/agents/${encodeURIComponent(agentId)}/ssh-keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
    )
  },
}
