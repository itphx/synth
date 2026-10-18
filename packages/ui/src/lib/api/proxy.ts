// proxy: домен API v2 (ADR-095, ADR-099) — egress-прокси.
//
// GET отдаёт saved/running/defaults (без секретов и userinfo), статус пароля
// профилей и `restartRequired`: настройка применяется при старте процесса.
// PUT/DELETE управляют runtime-override (live не применяют); пароль и TLS/mTLS
// профиля — отдельными write-only endpoint'ами (значения никогда не возвращаются).

import type {
  EgressProxyStatus,
  ProxyAuthChallenge,
  ProxyMode,
  ProxyPasswordStatus,
  ProxyStatusProfile,
  ProxyStatusRule,
} from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

export type {
  EgressProxyStatus,
  ProxyAuthChallenge,
  ProxyMode,
  ProxyPasswordStatus,
  ProxyStatusRule,
}

/** Скоуп источника эффективного значения (`runtime` — runtime-override из UI). */
export type ProxySource = 'env' | 'runtime' | 'config' | 'none'

/** Профиль в статусе: redacted + источник пароля (API обогащает saved). */
export interface ProxyProfileStatus extends ProxyStatusProfile {
  /** `running`/`defaults` могут не содержать поле; значение никогда не отдаётся. */
  password?: ProxyPasswordStatus
}

/** Read-only статус одной конфигурации (`saved`/`running`/`defaults`). */
export type ProxyStatusInfo = Omit<EgressProxyStatus, 'profiles'> & {
  profiles: Record<string, ProxyProfileStatus>
}

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

/** Именованный профиль (сохраняемая форма; пароль/PEM сюда не входят). */
export interface ProxyProfileInput {
  label?: string
  url?: string
  httpProxy?: string
  httpsProxy?: string
  allProxy?: string
  auth?: ProxyAuthConfig
  tls?: ProxyTlsConfig
}

/** Правило маршрутизации (порядок = приоритет, первое совпадение). */
export interface ProxyRuleInput {
  id?: string
  label?: string
  hosts: string[]
  action: 'proxy' | 'direct'
  profile?: string
}

/**
 * Тело `PUT /settings/proxy` — сохраняемый runtime-override (без пароля).
 * В режиме профилей top-level `url`/`auth`/`tls` запрещены сервером —
 * UI отправляет только `profiles`/`rules`.
 */
export interface ProxyConfigInput {
  enabled?: boolean
  mode?: ProxyMode
  defaultProfile?: string
  profiles?: Record<string, ProxyProfileInput>
  rules?: ProxyRuleInput[]
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
  mode?: ProxyMode
  defaultProfile?: string
  profiles?: Record<string, ProxyProfileStatus>
  rules?: ProxyStatusRule[]
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

/** Ответ TLS-мутаций профиля: полный saved-статус (redacted) + рестарт. */
export interface ProxyTlsMutationResponse {
  status: ProxyStatusInfo
  restartRequired: true
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

/** Маршрут проверки target-URL (без секретов: proxyUrl redacted). */
export interface ProxyRouteInfo {
  action: 'proxy' | 'direct'
  via: 'proxy' | 'direct'
  reason: string
  ruleId?: string
  ruleLabel?: string
  profile?: string
  profileLabel?: string
  proxyUrl?: string
}

/**
 * Результат `POST /settings/proxy/test` — проверка **target URL** по saved-
 * конфигурации (HEAD, без редиректов; egress-политика проверяется сервером).
 */
export interface ProxyRouteTestResult {
  url: string
  route: ProxyRouteInfo
  ok: boolean
  httpStatus?: number
  latencyMs: number
  authChallenge: ProxyAuthChallenge
  error?: string
  usingSaved: boolean
  restartRequired: boolean
}

const profilePath = (name: string): string =>
  `${BASE_URL}/settings/proxy/profiles/${encodeURIComponent(name)}`

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

  /**
   * PUT /settings/proxy/password — задать пароль Basic legacy-default (write-only,
   * 409 если env). Оставлен для обратной совместимости; UI использует
   * profile-эндпоинты.
   */
  async setProxyPassword(password: string): Promise<ProxyPasswordStatus> {
    return fetchJSON<{ password: ProxyPasswordStatus }>(`${BASE_URL}/settings/proxy/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    }).then((r) => r.password)
  },

  /** DELETE /settings/proxy/password — удалить файл пароля legacy-default (409 если env). */
  async clearProxyPassword(): Promise<ProxyPasswordStatus> {
    return fetchJSON<{ password: ProxyPasswordStatus }>(`${BASE_URL}/settings/proxy/password`, {
      method: 'DELETE',
    }).then((r) => r.password)
  },

  /** PUT /settings/proxy/profiles/:name/password — пароль профиля (write-only, 409 если env). */
  async setProfilePassword(name: string, password: string): Promise<ProxyPasswordStatus> {
    return fetchJSON<{ password: ProxyPasswordStatus }>(`${profilePath(name)}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    }).then((r) => r.password)
  },

  /** DELETE /settings/proxy/profiles/:name/password — удалить пароль профиля. */
  async clearProfilePassword(name: string): Promise<ProxyPasswordStatus> {
    return fetchJSON<{ password: ProxyPasswordStatus }>(`${profilePath(name)}/password`, {
      method: 'DELETE',
    }).then((r) => r.password)
  },

  /** PUT /settings/proxy/profiles/:name/tls/ca — загрузить CA-бандл (write-only). */
  async uploadProfileCa(name: string, pem: string): Promise<ProxyTlsMutationResponse> {
    return fetchJSON<ProxyTlsMutationResponse>(`${profilePath(name)}/tls/ca`, {
      method: 'PUT',
      body: JSON.stringify({ pem }),
    })
  },

  /** DELETE /settings/proxy/profiles/:name/tls/ca — удалить CA-бандл профиля. */
  async removeProfileCa(name: string): Promise<ProxyTlsMutationResponse> {
    return fetchJSON<ProxyTlsMutationResponse>(`${profilePath(name)}/tls/ca`, {
      method: 'DELETE',
    })
  },

  /** PUT /settings/proxy/profiles/:name/tls/client — mTLS-клиент профиля (write-only). */
  async uploadProfileClient(
    name: string,
    certPem: string,
    keyPem: string,
  ): Promise<ProxyTlsMutationResponse> {
    return fetchJSON<ProxyTlsMutationResponse>(`${profilePath(name)}/tls/client`, {
      method: 'PUT',
      body: JSON.stringify({ certPem, keyPem }),
    })
  },

  /** DELETE /settings/proxy/profiles/:name/tls/client — удалить mTLS-материалы профиля. */
  async removeProfileClient(name: string): Promise<ProxyTlsMutationResponse> {
    return fetchJSON<ProxyTlsMutationResponse>(`${profilePath(name)}/tls/client`, {
      method: 'DELETE',
    })
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

  /**
   * POST /settings/proxy/test — проверка target URL по saved-конфигурации:
   * маршрут (правило/профиль/прокси), доступность, HTTP-статус, ошибка.
   * `HEAD` без редиректов; egress-политика проверяется сервером.
   */
  async testProxyRoute(url: string): Promise<ProxyRouteTestResult> {
    return fetchJSON<ProxyRouteTestResult>(`${BASE_URL}/settings/proxy/test`, {
      method: 'POST',
      body: JSON.stringify({ url: url.trim() }),
    })
  },
}
