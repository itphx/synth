// memory: домен API v2 (ADR-095) — объект `memoryApi` и его DTO.
//
// ADR-107 / PROP-047: портал памяти — read-only просмотр состояния провайдера
// памяти, фактов и индексов. В этой волне раздел только читает: мутаций
// (создание/пересборка индекса, отзыв факта) нет.
//
// Типы объявлены локально (как в соседних доменах): тянуть core в браузерный
// бандл нельзя (см. `packages/ui/AGENTS.md`).

import { BASE_URL, fetchJSON } from './base'

/** Готовность портала памяти (PROP-047 §5.1). */
export type MemoryReadiness = 'ready' | 'degraded' | 'stale' | 'unavailable'

/** Режим исполнения провайдера памяти; `null` — провайдер не подключён. */
export type MemoryProviderMode = 'inline' | 'remote' | null

/** Жизненный цикл факта памяти (ADR-096, порт фактов). */
export type MemoryFactStatus = 'candidate' | 'active' | 'superseded' | 'retracted'

/** Состояние индекса памяти (ADR-096, порт индексов). */
export type MemoryIndexState = 'building' | 'ready' | 'stale' | 'failed'

/** Провенанс факта — откуда взялось утверждение. */
export interface MemoryFactProvenance {
  /** Вид источника (`session`/`project`/`file`/`external`/…). */
  sourceKind: string
  /** Идентификатор источника. */
  sourceId: string
  /** Ссылка на источник (путь, URL, якорь в сессии). */
  uri?: string
  /** Ревизия источника (хеш коммита, `seq` сообщения, версия документа). */
  revision?: string
  /** ISO-момент захвата утверждения. */
  capturedAt: string
}

/** Факт памяти — утверждение с провенансом и версией. */
export interface MemoryFact {
  id: string
  /** Номер версии факта (растёт при коррекции). */
  version: number
  text: string
  /** Вид факта (`decision`/`constraint`/`reference`/`preference`/`observation`). */
  kind: string
  projectId?: string
  userId?: string
  provenance: MemoryFactProvenance
  /** Уверенность в утверждении, 0..1. */
  confidence: number
  status: MemoryFactStatus
  createdAt: string
  updatedAt: string
  /** ISO-момент, после которого утверждение перестаёт быть актуальным. */
  validUntil?: string
  /** id новой версии (если факт заменён). */
  supersededBy?: string
}

/** Фингерпринт эмбеддинга — конфигурация, при которой векторы переиспользуемы. */
export interface MemoryIndexFingerprint {
  /** Модель эмбеддинга. */
  model: string
  /** Размерность вектора. */
  dimension: number
  /** Нормируется ли вектор. */
  normalize?: boolean
  /** Версия чанкера. */
  chunkerVersion: string
  /** Уровень «обёртки» текста перед эмбеддингом. */
  wrapTier?: string
}

/** Источник корпуса индекса (что индексируется). */
export interface MemoryIndexSource {
  /** Вид источника (`project`/`files`/`sessions`/`external`/…). */
  kind: string
  /** Фильтр источника (glob, запрос, предикат). */
  filter?: string
}

/** Индекс памяти — построенный корпус для retrieval. */
export interface MemoryIndex {
  id: string
  name: string
  /** Провайдер памяти, которому принадлежит индекс. */
  providerId: string
  projectId?: string
  source: MemoryIndexSource
  state: MemoryIndexState
  /** Поколение корпуса (инкремент при пересборке). */
  generation: number
  fingerprint: MemoryIndexFingerprint
  stats: { documents: number; chunks: number; updatedAt: string }
  createdAt: string
  updatedAt: string
  /** Текст ошибки (при `state: 'failed'`). */
  error?: string
}

/** Снимок состояния портала памяти. */
export interface MemoryStatus {
  provider: { id: string; mode: MemoryProviderMode; active: boolean }
  readiness: MemoryReadiness
  namespace: string
  facts: { total: number; active: number }
  indexes: { total: number; ready: number; stale: number; failed: number; building: number }
}

/** Постраничный ответ со списком фактов. */
export interface MemoryFactList {
  items: MemoryFact[]
  total: number
  limit: number
  offset: number
}

/** Ответ со списком индексов. */
export interface MemoryIndexList {
  items: MemoryIndex[]
  total: number
}

/** Статус факта (плюс `all` — без фильтра; сервер так понимает). */
export type MemoryFactStatusFilter = MemoryFactStatus | 'all'

/** Фильтры выборки фактов. */
export interface MemoryFactListParams {
  /** Поиск по тексту факта. */
  query?: string
  /** Вид факта. */
  kind?: string
  /** Статус факта (по умолчанию — `active`; `all` — без фильтра). */
  status?: MemoryFactStatusFilter
  /** Проект-владелец факта. */
  projectId?: string
  /** Размер страницы (по умолчанию 50). */
  limit?: number
  /** Смещение страницы (по умолчанию 0). */
  offset?: number
}

/** Фильтры выборки индексов. */
export interface MemoryIndexListParams {
  /** Проект-владелец индекса. */
  projectId?: string
  /** Состояние индекса. */
  state?: MemoryIndexState
}

/** Размер страницы фактов по умолчанию — как на сервере. */
export const MEMORY_FACTS_DEFAULT_LIMIT = 50

/** Статус фактов по умолчанию — как на сервере. */
export const MEMORY_FACTS_DEFAULT_STATUS: MemoryFactStatus = 'active'

/** Значение фильтра «все статусы» — сервер понимает `status=all`. */
export const MEMORY_FACTS_ALL_STATUSES = 'all'

/** Собирает query-строку: пустые и незаданные значения не уходят на сервер. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export const memoryApi = {
  /** GET /memory/status — состояние портала памяти (провайдер, готовность, счётчики). */
  async getMemoryStatus(): Promise<MemoryStatus> {
    return fetchJSON<MemoryStatus>(`${BASE_URL}/memory/status`)
  },

  /** GET /memory/facts — факты с фильтрами и пагинацией. */
  async listMemoryFacts(params: MemoryFactListParams = {}): Promise<MemoryFactList> {
    const query = buildQuery({
      query: params.query,
      kind: params.kind,
      status: params.status ?? MEMORY_FACTS_DEFAULT_STATUS,
      projectId: params.projectId,
      limit: params.limit ?? MEMORY_FACTS_DEFAULT_LIMIT,
      offset: params.offset ?? 0,
    })
    return fetchJSON<MemoryFactList>(`${BASE_URL}/memory/facts${query}`)
  },

  /** GET /memory/facts/:id — факт по id (404 `MEMORY_FACT_NOT_FOUND`). */
  async getMemoryFact(id: string): Promise<MemoryFact> {
    return fetchJSON<MemoryFact>(`${BASE_URL}/memory/facts/${encodeURIComponent(id)}`)
  },

  /** GET /memory/indexes — индексы с фильтрами. */
  async listMemoryIndexes(params: MemoryIndexListParams = {}): Promise<MemoryIndexList> {
    const query = buildQuery({ projectId: params.projectId, state: params.state })
    return fetchJSON<MemoryIndexList>(`${BASE_URL}/memory/indexes${query}`)
  },
}
