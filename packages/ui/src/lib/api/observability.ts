// observability: домен API v2 (ADR-095) — объект `observabilityApi` и его DTO.
//
// ADR-094: runtime-настройки наблюдаемости (`GET/PUT/DELETE /settings/metrics`).
// `GET /metrics` живёт вне `/api/v2`, но управление экспортом и токеном — обычные
// admin-настройки. Типы объявлены локально (как в соседних доменах): тянуть
// core в браузерный бандл нельзя (см. `packages/ui/AGENTS.md`).

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения настройки (приоритет env > runtime > config > default). */
export type MetricsSource = 'env' | 'runtime' | 'config' | 'default'

/** Источник bearer-токена `/metrics` (`env` — `SYNTH_METRICS_TOKEN`, `file` — `secrets/metrics-token`). */
export type MetricsTokenSource = 'env' | 'file' | 'none'

/** Состояние слоя хранения в `/ready` (деградация остаётся ready). */
export type MetricsStorageState = 'ok' | 'degraded'

/** Backend хранения инстанса. */
export type MetricsStorageBackend = 'file' | 'memory' | 'postgres'

/** ADR-094: статус bearer-токена `/metrics` (значение никогда не возвращается). */
export interface MetricsTokenStatus {
  /** Токен задан (env или файл). */
  configured: boolean
  source: MetricsTokenSource
}

/** ADR-094: публичные эндпоинты наблюдаемости (вне `/api/v2`). */
export interface MetricsEndpoints {
  metrics: '/metrics'
  ready: '/ready'
}

/** Ответ `PUT/DELETE /settings/metrics/token` — только статус токена (без значения). */
export interface MetricsTokenResponse {
  token: MetricsTokenStatus
}

/** ADR-094: runtime-настройки экспорта (`GET/PUT/DELETE /settings/metrics`). */
export interface MetricsSettingsInfo {
  /** Сохранённое (или эффективное) значение runtime-настройки. */
  metrics: { enabled: boolean }
  /** Значение по умолчанию (config.yaml / дефолт). */
  defaults: { enabled: boolean }
  /** Runtime-override присутствует (`settings.json`). */
  isOverridden: boolean
  /** Источник эффективного значения. */
  source: MetricsSource
  /** Экспорт реально работает сейчас (может отличаться от сохранённого). */
  running: boolean
  /** Изменения применятся после перезапуска инстанса. */
  restartRequired: boolean
  token: MetricsTokenStatus
  endpoints: MetricsEndpoints
}

/** ADR-094: снимок состояния наблюдаемости (`GET /settings/metrics/status`). */
export interface MetricsStatus {
  /** Экспорт включён в конфигурации. */
  enabled: boolean
  /** Экспорт работает в запущенном процессе. */
  running: boolean
  source: MetricsSource
  restartRequired: boolean
  /** Readiness инстанса (`GET /ready`: 200 / 503). */
  ready: boolean
  storage: MetricsStorageState
  storageBackend: MetricsStorageBackend
  version: string
  /** Время работы процесса в секундах. */
  uptimeSec: number
  /** Объём exposition: серии, байты ответа, отброшенные серии (предел кардинальности). */
  exposition: { series: number; bytes: number; droppedSeries: number }
  token: MetricsTokenStatus
  endpoints: MetricsEndpoints
}

export const observabilityApi = {
  // --- ADR-094: настройки наблюдаемости (`/settings/metrics`) ---
  /** GET /settings/metrics — runtime-настройка экспорта, дефолты, источник, токен, эндпоинты. */
  async get(): Promise<MetricsSettingsInfo> {
    return fetchJSON<MetricsSettingsInfo>(`${BASE_URL}/settings/metrics`)
  },

  /** PUT /settings/metrics — включить/выключить экспорт (`{metrics:{enabled}}`). */
  async setEnabled(enabled: boolean): Promise<MetricsSettingsInfo> {
    return fetchJSON<MetricsSettingsInfo>(`${BASE_URL}/settings/metrics`, {
      method: 'PUT',
      body: JSON.stringify({ metrics: { enabled } }),
    })
  },

  /** DELETE /settings/metrics — сброс runtime-настройки к config.yaml-дефолту. */
  async reset(): Promise<MetricsSettingsInfo> {
    return fetchJSON<MetricsSettingsInfo>(`${BASE_URL}/settings/metrics`, { method: 'DELETE' })
  },

  /** GET /settings/metrics/status — снимок состояния (ready/storage/uptime/exposition). */
  async status(): Promise<MetricsStatus> {
    return fetchJSON<MetricsStatus>(`${BASE_URL}/settings/metrics/status`)
  },

  /** PUT /settings/metrics/token — задать bearer-токен (write-only, в ответе значения нет). */
  async setToken(token: string): Promise<MetricsTokenResponse> {
    return fetchJSON<MetricsTokenResponse>(`${BASE_URL}/settings/metrics/token`, {
      method: 'PUT',
      body: JSON.stringify({ token }),
    })
  },

  /** DELETE /settings/metrics/token — удалить файл токена (при env — 409). */
  async deleteToken(): Promise<MetricsTokenResponse> {
    return fetchJSON<MetricsTokenResponse>(`${BASE_URL}/settings/metrics/token`, {
      method: 'DELETE',
    })
  },
}
