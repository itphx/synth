// hybrid: домен API v2 (ADR-095) — объект `hybridApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/** Ответ GET /api/v2/hybrid/status — статус гибридного режима (core ↔ удалённый backend). */
export interface HybridStatus {
  enabled: boolean
  connected: boolean
  backendUrl: string | null
  /** Адрес сервера известен (--connect/env/конфиг) — информационное поле. */
  serverConfigured: boolean
  /** Доступен вход на сервер (адрес/issuer известен или уже подключено) — серверная форма логина. */
  serverLoginAvailable: boolean
  user?: {
    id: string
    username: string
    roles: string[]
  } | null
  /** URL известных серверов из реестра профилей core (список для datalist формы входа). */
  knownServers?: string[]
  /** URL последнего использованного сервера (предзаполнение поля адреса). */
  lastServer?: string | null
}

export const hybridApi = {
  // Гибридный режим: статус подключения к удалённому backend (без auth, как /health)
  async getHybridStatus(): Promise<HybridStatus> {
    return fetchJSON<HybridStatus>(`${BASE_URL}/hybrid/status`)
  },
}
