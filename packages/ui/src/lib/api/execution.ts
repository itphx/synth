// execution: домен API v2 (PROP-135, слайс 6b-1/6b-2a) — профили и пулы исполнения.
//
// Серверный контракт (core, `server/routes/execution.ts`):
//   GET    /api/v2/execution/profiles          → { provider, pooling, defaultProfile, profiles, details }
//   GET    /api/v2/execution/pools             → { provider, pools: PoolInfo[] }
//   POST   /api/v2/execution/pools/:key/drain  → 202 { ok: true }
//   DELETE /api/v2/execution/pools/:key        → 202 { ok: true }
//   POST   /api/v2/execution/images/warm       → 200 { results: ImageWarmResult[] }
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

/**
 * Класс профиля (ADR-135, аддендум §11): `exec` — исполнитель команд,
 * `browser` — браузерный контур, `both` — оба контура одним профилем.
 */
export type ExecutionProfileClass = 'exec' | 'browser' | 'both'

/**
 * Происхождение профиля: `config` — из `config.yaml` (не редактируется, его
 * можно отключить или продублировать), `runtime` — создан в runtime-каталоге.
 */
export type ExecutionProfileOrigin = 'config' | 'runtime'

/**
 * MCP-сервер профиля: имя + команда + аргументы + env.
 *
 * Строка (`'playwright-mcp'`) — legacy-форма: нормализуется в `{ name }`.
 */
export interface ExecutionProfileMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/** Оператор toleration'а пода (Kubernetes). */
export type ExecutionTolerationOperator = 'Equal' | 'Exists'

/** Эффект toleration'а пода (Kubernetes). */
export type ExecutionTolerationEffect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'

/** Toleration профиля (размещение пода на «tainted» нодах). */
export interface ExecutionProfileToleration {
  key?: string
  operator?: ExecutionTolerationOperator
  value?: string
  effect?: ExecutionTolerationEffect
}

/**
 * Список ресурсов профиля (`requests`/`limits` контейнера пула).
 *
 * Известные ключи объявлены явно, произвольные — через индекс-сигнатуру
 * (`nvidia.com/gpu`, `example.com/fpka`): без них GPU-профиль не задать.
 */
export interface ExecutionProfileResourceList {
  cpu?: string
  memory?: string
  ephemeralStorage?: string
  [key: string]: string | undefined
}

/** Ресурсы профиля исполнения (как в PodSpec). */
export interface ExecutionProfileResources {
  requests?: ExecutionProfileResourceList
  limits?: ExecutionProfileResourceList
}

/**
 * Метаданные профиля исполнения (аддитивное поле `details`).
 *
 * Без env и секретов: у `mcpServers` — имя/команда/аргументы, но не env
 * (инвариант 13); неизвестное поле — «—».
 */
export interface ExecutionProfileInfo {
  name: string
  description?: string
  image?: string
  url?: string[]
  network?: 'none' | 'restricted' | 'full'
  resources?: ExecutionProfileResources
  runtimeClass?: string
  /** Класс профиля (`exec`/`browser`/`both`). */
  class?: ExecutionProfileClass
  /** MCP-серверы профиля (имя + команда + аргументы). */
  mcpServers?: ExecutionProfileMcpServer[]
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
  /**
   * Происхождение профилей (аддитивно): `config` — из `config.yaml`,
   * `runtime` — создан в runtime-каталоге. Старый сервер — `undefined`.
   */
  profileOrigins?: Record<string, ExecutionProfileOrigin>
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
  /**
   * Происхождение профилей (аддитивно): `config` — из `config.yaml`
   * (не редактируется), `runtime` — создан в runtime-каталоге.
   */
  profileOrigins?: Record<string, ExecutionProfileOrigin>
}

/**
 * Итог прогрева одного образа (`POST /api/v2/execution/images/warm`).
 *
 * `ok` — образ прогрет; `nodes` — на скольких нодах; `error` — причина
 * неудачи (без секретов).
 */
export interface ExecutionImageWarmResult {
  image: string
  ok: boolean
  nodes: number
  error?: string
}

/** Ответ `POST /api/v2/execution/images/warm`. */
export interface ExecutionImagesWarmDto {
  results: ExecutionImageWarmResult[]
}

/**
 * Нормализация MCP-серверов профиля: legacy-строка (`'playwright-mcp'`) →
 * объект `{ name }`; неизвестное — отбрасывается.
 */
function normalizeMcpServers(raw: unknown): ExecutionProfileMcpServer[] {
  if (!Array.isArray(raw)) return []
  const out: ExecutionProfileMcpServer[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const name = entry.trim()
      if (name) out.push({ name })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) continue
    const server: ExecutionProfileMcpServer = { name }
    if (typeof record.command === 'string' && record.command.trim() !== '') {
      server.command = record.command.trim()
    }
    if (Array.isArray(record.args)) {
      const args = record.args.filter((arg): arg is string => typeof arg === 'string')
      if (args.length > 0) server.args = args
    }
    out.push(server)
  }
  return out
}

export const executionApi = {
  /** GET /execution/profiles — эффективные провайдер/пулинг/профили. */
  async getExecutionProfiles(): Promise<ExecutionProfilesDto> {
    const response = await fetchJSON<ExecutionProfilesDto>(`${BASE_URL}/execution/profiles`)
    // Сервер до этой версии отдавал только имена — детали необязательны.
    return {
      ...response,
      details: (response.details ?? []).map((detail) => ({
        ...detail,
        mcpServers: normalizeMcpServers(detail.mcpServers),
      })),
    }
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
   * POST /execution/images/warm — прогреть образы на нодах кластера.
   *
   * Провайдер без управления подами (`static`) отвечает `501` — UI показывает
   * это понятным сообщением.
   */
  async warmExecutionImages(images: string[]): Promise<ExecutionImagesWarmDto> {
    const response = await fetchJSON<ExecutionImagesWarmDto>(
      `${BASE_URL}/execution/images/warm`,
      { method: 'POST', body: JSON.stringify({ images }) },
    )
    return { results: response.results ?? [] }
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
