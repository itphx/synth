// execution: домен API v2 (PROP-135, слайс 6b-1/6b-2a) — профили и пулы исполнения.
//
// Серверный контракт (core, `server/routes/execution.ts`):
//   GET    /api/v2/execution/profiles          → { provider, pooling, defaultProfile, profiles }
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

/** Эффективный провайдер исполнения (`inline` — исполнение в процессе). */
export type ExecutionProviderKind = 'inline' | 'static' | 'http'

/** Режим пула (`execution.remote.pooling`). */
export type ExecutionPooling = 'instance' | 'project' | 'session'

/** Состояние пула: задан профилем, готов, снимается. */
export type ExecutionPoolState = 'configured' | 'ready' | 'draining'

/** Ответ `GET /api/v2/execution/profiles`. */
export interface ExecutionProfilesDto {
  provider: ExecutionProviderKind
  pooling: ExecutionPooling
  /** Профиль по умолчанию (входит в `profiles` всегда). */
  defaultProfile: string
  /** Известные профили. */
  profiles: string[]
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

export const executionApi = {
  /** GET /execution/profiles — эффективные провайдер/пулинг/профили. */
  async getExecutionProfiles(): Promise<ExecutionProfilesDto> {
    return fetchJSON<ExecutionProfilesDto>(`${BASE_URL}/execution/profiles`)
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
}
