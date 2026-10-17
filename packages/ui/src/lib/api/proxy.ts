// proxy: домен API v2 (ADR-095, ADR-099) — egress-прокси.
//
// GET отдаёт saved/running/defaults (без секретов и userinfo), статус пароля и
// `restartRequired`: настройка применяется при старте процесса. PUT/DELETE
// управляют runtime-override (live не применяют); пароль — только отдельными
// write-only методами (значение никогда не возвращается).

import type {
  EgressProxyStatus,
  ProxyAuthChallenge,
  ProxyPasswordStatus,
} from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

export type { EgressProxyStatus, ProxyAuthChallenge, ProxyPasswordStatus }

/** Скоуп источника эффективного значения (`runtime` — runtime-override из UI). */
export type ProxySource = 'env' | 'runtime' | 'config' | 'none'

/** Read-only статус одной конфигурации (`saved`/`running`/`defaults`). */
export type ProxyStatusInfo = EgressProxyStatus

/** Basic-аутентификация прокси (только `basic`; пароль — отдельным endpoint'ом). */
export interface ProxyAuthConfig {
  type: 'basic'
  username: string
}

/** TLS/mTLS к самому прокси (ADR-099): `caFile`/`caPem` взаимоисключающие, `cert`+`key` — вместе. */
export interface ProxyTlsConfig {
  caFile?: string
  caPem?: string
  certFile?: string
  keyFile?: string
  rejectUnauthorized?: boolean
}

/** Тело `PUT /settings/proxy` — сохраняемый runtime-override (без пароля). */
export interface ProxyConfigInput {
  enabled?: boolean
  url?: string
  httpProxy?: string
  httpsProxy?: string
  allProxy?: string
  noProxy: string[]
  fromEnv: boolean
  fallbackDirect: boolean
  connectTimeoutMs: number
  auth?: ProxyAuthConfig
  tls?: ProxyTlsConfig
}

/**
 * `GET /settings/proxy`. Плоские поля — `saved` (обратная совместимость).
 * `fromEnv`/`auth`/`tls` приходят расширением saved-формы (читаем опционально,
 * старый сервер их не отдаёт).
 */
export interface ProxySettingsResponse {
  enabled: boolean
  source: ProxySource
  url?: string
  httpProxy?: string
  httpsProxy?: string
  allProxy?: string
  noProxy: string[]
  fromEnv?: boolean
  fallbackDirect: boolean
  connectTimeoutMs: number
  auth?: ProxyAuthConfig
  tls?: ProxyTlsConfig
  saved: ProxyStatusInfo
  running: ProxyStatusInfo
  isOverridden: boolean
  defaults: ProxyStatusInfo
  password: ProxyPasswordStatus
  restartRequired: boolean
}

/** Ответ `PUT /settings/proxy`: сохранено, live не применено. */
export interface ProxySaveResponse {
  saved: ProxyStatusInfo
  running: ProxyStatusInfo
  restartRequired: boolean
}

/** Ответ `DELETE /settings/proxy`: runtime-override сброшен. */
export interface ProxyResetResponse extends ProxySaveResponse {
  status: 'restored'
  defaults: ProxyStatusInfo
}

/** Результат `POST /settings/proxy/check`: проверка коннекта к прокси, не к цели. */
export interface ProxyCheckResult {
  reachable: boolean
  latencyMs?: number
  error?: string
  authChallenge?: ProxyAuthChallenge
  /** `true` — проверялась saved-конфигурация (без явного URL). */
  usingSaved: boolean
}

export const proxyApi = {
  /** GET /settings/proxy — saved/running/defaults, статус пароля, restartRequired. */
  async getProxy(): Promise<ProxySettingsResponse> {
    return fetchJSON<ProxySettingsResponse>(`${BASE_URL}/settings/proxy`)
  },

  /** PUT /settings/proxy — сохранить runtime-override (применяется после рестарта). */
  async saveProxy(proxy: ProxyConfigInput): Promise<ProxySaveResponse> {
    return fetchJSON<ProxySaveResponse>(`${BASE_URL}/settings/proxy`, {
      method: 'PUT',
      body: JSON.stringify({ proxy }),
    })
  },

  /** DELETE /settings/proxy — сбросить runtime-override к config.yaml/env. */
  async resetProxy(): Promise<ProxyResetResponse> {
    return fetchJSON<ProxyResetResponse>(`${BASE_URL}/settings/proxy`, {
      method: 'DELETE',
    })
  },

  /** PUT /settings/proxy/password — задать пароль Basic (write-only, 409 если env). */
  async setProxyPassword(password: string): Promise<ProxyPasswordStatus> {
    return fetchJSON<{ password: ProxyPasswordStatus }>(`${BASE_URL}/settings/proxy/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    }).then((r) => r.password)
  },

  /** DELETE /settings/proxy/password — удалить файл пароля (409 если env). */
  async clearProxyPassword(): Promise<ProxyPasswordStatus> {
    return fetchJSON<{ password: ProxyPasswordStatus }>(`${BASE_URL}/settings/proxy/password`, {
      method: 'DELETE',
    }).then((r) => r.password)
  },

  /**
   * POST /settings/proxy/check — проверка соединения с прокси (ADMIN).
   * Без `url` проверяется saved-конфигурация (`usingSaved: true`), с `url` — он.
   * Цель не запрашивается; auth-схема только распознаётся.
   */
  async checkProxy(url?: string): Promise<ProxyCheckResult> {
    const trimmed = url?.trim()
    return fetchJSON<ProxyCheckResult>(`${BASE_URL}/settings/proxy/check`, {
      method: 'POST',
      body: JSON.stringify(trimmed ? { url: trimmed } : {}),
    })
  },
}
