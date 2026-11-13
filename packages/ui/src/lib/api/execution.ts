// execution: домен API v2 (PROP-135, слайс 6b-1/6b-2a) — профили и пулы исполнения.
//
// Серверный контракт (core, `server/routes/execution.ts`):
//   GET    /api/v2/execution/profiles          → { provider, pooling, defaultProfile, profiles, details }
//   GET    /api/v2/execution/pools             → { provider, pools: PoolInfo[] }
//   POST   /api/v2/execution/pools/:key/drain  → 202 { ok: true }
//   DELETE /api/v2/execution/pools/:key        → 202 { ok: true }
//
// Наружу не отдаются ни адрес пула/исполнителя, ни его токен (инвариант 13):
// DTO содержит только ключ, профиль, состояние и метки времени.
//
// Ошибки — как у остальных клиентов: `fetchJSON` бросает `Error` со `status`
// и `code` (`EXECUTION_PROVIDER_UNAVAILABLE` при 503, `FORBIDDEN` при 403).
// Ключ пула содержит `:` и идентификаторы проекта/сессии — он URL-encoded.

import { BASE_URL, fetchJSON } from './base'

import type {
  ExecutionRuntimeProfile,
  ExecutionRuntimeSettings,
} from '@itphx/synth-shared/types'

/**
 * Runtime-каталог профилей и дефолтов (ADR-135) — та же форма, что в core
 * (`executionRuntimeSettingsSchema`); типы — из `@itphx/synth-shared/types`
 * (browser-safe, type-only).
 */
export type { ExecutionRuntimeProfile, ExecutionRuntimeSettings }

/** Эффективный провайдер исполнения (`inline` — исполнение в процессе). */
export type ExecutionProviderKind = 'inline' | 'static' | 'http'

/** Режим пула (`execution.remote.pooling`). */
export type ExecutionPooling = 'instance' | 'project' | 'session'

/** Состояние пула: задан профилем, готов, снимается. */
export type ExecutionPoolState = 'configured' | 'ready' | 'draining'

/** Список ресурсов профиля (`requests`/`limits` контейнера пула). */
export interface ExecutionProfileResourceList {
  cpu?: string
  memory?: string
  ephemeralStorage?: string
}

/** Ресурсы профиля исполнения (как в PodSpec). */
export interface ExecutionProfileResources {
  requests?: ExecutionProfileResourceList
  limits?: ExecutionProfileResourceList
}

/**
 * Метаданные профиля исполнения (аддитивное поле `details`).
 *
 * Без env и секретов: `mcpServers` — только имена; неизвестное поле — «—».
 */
export interface ExecutionProfileInfo {
  name: string
  description?: string
  image?: string
  network?: 'none' | 'restricted' | 'full'
  resources?: ExecutionProfileResources
  runtimeClass?: string
  mcpServers?: string[]
}

/** Ответ `GET /api/v2/execution/profiles`. */
export interface ExecutionProfilesDto {
  provider: ExecutionProviderKind
  pooling: ExecutionPooling
  /** Профиль по умолчанию (входит в `profiles` всегда). */
  defaultProfile: string
  /** Известные профили **exec**-контура (браузерные имена не входят). */
  profiles: string[]
  /**
   * PROP-135 (браузерный контур): каталог браузерных профилей
   * (`execution.remote.browserProfiles`; пусто → `[browserDefaultProfile]`).
   */
  browserProfiles?: string[]
  /** PROP-135 (браузерный контур): браузерный профиль по умолчанию. */
  browserDefaultProfile?: string
  /** Метаданные профилей (может отсутствовать у старого сервера — `[]`). */
  details: ExecutionProfileInfo[]
}

/**
 * Пул исполнения (`GET /api/v2/execution/pools`).
 *
 * Без адреса и токена: это секреты доступа к исполнителю (инвариант 13).
 * `key` нет у `static`-провайдера (пулы адресуются профилем).
 */
export interface ExecutionPoolInfo {
  key?: string
  profile: string
  state: ExecutionPoolState
  /** Когда пул выдан (ISO-8601). */
  createdAt?: string
  /** Когда пул последний раз использовался (ISO-8601). */
  lastUsedAt?: string
}

/** Ответ `GET /api/v2/execution/pools`. */
export interface ExecutionPoolsDto {
  provider: ExecutionProviderKind
  pools: ExecutionPoolInfo[]
}

/**
 * Ответ `GET/PUT/DELETE /api/v2/settings/execution` (ADR-135, runtime-каталог).
 *
 * - `saved` — сохранённая runtime-секция (`null` — каталог из config.yaml);
 * - `running` — то, что работает сейчас (снимок на старте процесса);
 * - `effective` — что заработает после перезапуска (config + runtime + env);
 * - `restartRequired` — `effective` ≠ `running` (каталог — параметр запуска).
 */
export interface ExecutionSettingsDto {
  saved: ExecutionRuntimeSettings | null
  running: ExecutionRuntimeSettings
  restartRequired: boolean
  effective: ExecutionRuntimeSettings
  defaults: ExecutionRuntimeSettings
  isOverridden: boolean
}

export const executionApi = {
  /** GET /execution/profiles — эффективные провайдер/пулинг/профили. */
  async getExecutionProfiles(): Promise<ExecutionProfilesDto> {
    const response = await fetchJSON<ExecutionProfilesDto>(`${BASE_URL}/execution/profiles`)
    // Сервер до этой версии отдавал только имена — детали необязательны.
    return { ...response, details: response.details ?? [] }
  },

  /** GET /execution/pools — живые пулы (у `static` — профили как `configured`). */
  async getExecutionPools(): Promise<ExecutionPoolsDto> {
    const response = await fetchJSON<ExecutionPoolsDto>(`${BASE_URL}/execution/pools`)
    return { provider: response.provider, pools: response.pools ?? [] }
  },

  /**
   * POST /execution/pools/:key/drain — слить пул (`202`).
   *
   * Фактическое снятие идёт у provisioner'а (best-effort), поэтому ответ — только
   * подтверждение приёма запроса.
   */
  async drainExecutionPool(key: string): Promise<void> {
    await fetchJSON<unknown>(`${BASE_URL}/execution/pools/${encodeURIComponent(key)}/drain`, {
      method: 'POST',
    })
  },

  /** DELETE /execution/pools/:key — удалить пул (`202`, идемпотентно). */
  async releaseExecutionPool(key: string): Promise<void> {
    await fetchJSON<unknown>(`${BASE_URL}/execution/pools/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
  },

  /**
   * GET /settings/execution — runtime-каталог профилей и дефолтов (ADR-135).
   *
   * Секция — **параметр запуска**: изменения применяются после резапуска
   * инстанса (`restartRequired` в ответе).
   */
  async getExecutionSettings(): Promise<ExecutionSettingsDto> {
    return fetchJSON<ExecutionSettingsDto>(`${BASE_URL}/settings/execution`)
  },

  /**
   * PUT /settings/execution — сохранить runtime-секцию целиком.
   *
   * Тело — сама секция (`{ defaultProfile, browserProfile, browserProfiles,
   * profiles }`); сервер проверяет ссылочную целостность каталога и отвечает
   * `400 VALIDATION_ERROR` с коротким текстом.
   */
  async saveExecutionSettings(
    settings: ExecutionRuntimeSettings,
  ): Promise<ExecutionSettingsDto> {
    return fetchJSON<ExecutionSettingsDto>(`${BASE_URL}/settings/execution`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    })
  },

  /** DELETE /settings/execution — сброс к каталогу config.yaml. */
  async resetExecutionSettings(): Promise<ExecutionSettingsDto> {
    return fetchJSON<ExecutionSettingsDto>(`${BASE_URL}/settings/execution`, {
      method: 'DELETE',
    })
  },
}
