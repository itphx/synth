// memory: домен API v2 (ADR-095) — объект `memoryApi` и его DTO.
//
// ADR-107 / PROP-047: портал памяти — состояние провайдера памяти, факты и
// индексы. Чтение (`status`/`facts`/`indexes`/`graph`) плюс операции с индексами:
// создание, пересборка и удаление, и консолидация фактов (дубли → заменённые).
// Отзыв факта в мутации не входит.
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

/**
 * Область видимости индекса памяти (ADR-107, порт индексов).
 *
 * `project` — индекс виден только своему проекту (по умолчанию),
 * `instance` — общий для всех пользователей инстанса.
 */
export type MemoryIndexScope = 'project' | 'instance'

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
  /**
   * Проект-владелец индекса.
   *
   * Для `scope: 'project'` — проект-владелец; для `scope: 'instance'` —
   * источник корпуса (чей workspace индексируется), может отсутствовать.
   */
  projectId?: string
  /** Область видимости индекса (легаси-записи без поля читаются как `project`). */
  scope: MemoryIndexScope
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
  /** Область видимости индекса (`project`/`instance`). */
  scope?: MemoryIndexScope
}

/**
 * Вид источника корпуса, который умеет создавать UI.
 *
 * `files` — файлы проекта (нужен `projectId`), `facts` — факты памяти.
 */
export type MemoryIndexSourceKind = 'files' | 'facts'

/** Тело создания индекса (`POST /memory/indexes`). */
export interface CreateMemoryIndexInput {
  /** Имя индекса (обязательное на сервере). */
  name?: string
  /** Источник корпуса: что индексируем и с каким фильтром. */
  source?: { kind: MemoryIndexSourceKind; filter?: string }
  /**
   * Проект-владелец индекса.
   *
   * Обязателен для `scope: 'project'` и для источника `files`; для
   * `scope: 'instance'` с источником `facts` не нужен (индекс общий для инстанса).
   */
  projectId?: string
  /** Область видимости индекса (не задан — `project`, как на сервере). */
  scope?: MemoryIndexScope
}

/**
 * Кластер дубликатов фактов: оставленный факт и факты, помеченные заменёнными.
 */
export interface MemoryConsolidationCluster {
  /** id факта, который остался активным. */
  keptId: string
  /** id фактов, помеченных заменёнными. */
  supersededIds: string[]
  /** Схожесть внутри кластера (0..1). */
  similarity: number
}

/** Отчёт консолидации фактов (PROP-047: дубли → заменённые). */
export interface MemoryConsolidationReport {
  /** Сколько кластеров дубликатов найдено. */
  clusters: number
  /** Сколько фактов помечено заменёнными. */
  superseded: number
  /** Сколько фактов оставлено активными. */
  kept: number
  /** Состав кластеров. */
  items: MemoryConsolidationCluster[]
}

/** Тело консолидации фактов (`POST /memory/consolidate`). */
export interface ConsolidateMemoryInput {
  /** Проект-владелец фактов (не задан — все проекты). */
  projectId?: string
  /** Порог схожести дубликатов (0.5..0.99). */
  threshold?: number
  /** Пробный прогон: только показать, что будет заменено. */
  dryRun?: boolean
}

/** Вид узла графа памяти: сущность (упоминание) или факт. */
export type MemoryGraphNodeKind = 'entity' | 'fact'

/** Узел графа памяти — сущность или факт. */
export interface MemoryGraphNode {
  id: string
  kind: MemoryGraphNodeKind
  /** Отображаемое имя сущности (для `kind: 'entity'`). */
  name?: string
  /** id факта-источника (для `kind: 'fact'`). */
  factId?: string
  /** Текст факта-источника, обрезанный сервером (для `kind: 'fact'`). */
  text?: string
  /**
   * Ключ сущности (для `kind: 'entity'`). У узла-факта — упомянутая
   * сущность, если сервер её прислал; связь факта с сущностями иначе идёт
   * через рёбра.
   */
  entity?: string
}

/** Ребро графа памяти — связь между двумя узлами. */
export interface MemoryGraphEdge {
  /** id узла-источника. */
  from: string
  /** id узла-приёмника. */
  to: string
  /** Тип связи (`mentions`, `related`, …). */
  relation?: string
}

/** Счётчики графа памяти. */
export interface MemoryGraphStats {
  entities: number
  facts: number
  edges: number
}

/** Граф памяти — узлы, связи и счётчики. */
export interface MemoryGraph {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  stats: MemoryGraphStats
}

/** Фильтры выборки графа памяти (`GET /memory/graph`). */
export interface MemoryGraphParams {
  /** Сущность-центр графа (не задана — весь граф). */
  entity?: string
  /** Глубина обхода (1..3). */
  depth?: number
  /** Предел числа узлов (1..200). */
  limit?: number
  /** Проект-владелец фактов. */
  projectId?: string
}

/** Размер страницы фактов по умолчанию — как на сервере. */
export const MEMORY_FACTS_DEFAULT_LIMIT = 50

/** Статус фактов по умолчанию — как на сервере. */
export const MEMORY_FACTS_DEFAULT_STATUS: MemoryFactStatus = 'active'

/** Значение фильтра «все статусы» — сервер понимает `status=all`. */
export const MEMORY_FACTS_ALL_STATUSES = 'all'

/** Нижняя граница порога схожести при консолидации (сервер: 400 вне 0.5..0.99). */
export const MEMORY_CONSOLIDATION_THRESHOLD_MIN = 0.5

/** Верхняя граница порога схожести при консолидации. */
export const MEMORY_CONSOLIDATION_THRESHOLD_MAX = 0.99

/** Порог схожести по умолчанию — консервативный (почти только явные дубли). */
export const MEMORY_CONSOLIDATION_THRESHOLD_DEFAULT = 0.9

/** Минимальная глубина обхода графа (сервер: 400 вне 1..3). */
export const MEMORY_GRAPH_DEPTH_MIN = 1

/** Максимальная глубина обхода графа. */
export const MEMORY_GRAPH_DEPTH_MAX = 3

/** Глубина обхода графа по умолчанию. */
export const MEMORY_GRAPH_DEPTH_DEFAULT = 1

/** Минимальный предел числа узлов графа (сервер: 400 вне 1..200). */
export const MEMORY_GRAPH_LIMIT_MIN = 1

/** Максимальный предел числа узлов графа. */
export const MEMORY_GRAPH_LIMIT_MAX = 200

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
    const query = buildQuery({
      projectId: params.projectId,
      state: params.state,
      scope: params.scope,
    })
    return fetchJSON<MemoryIndexList>(`${BASE_URL}/memory/indexes${query}`)
  },

  /**
   * POST /memory/indexes — создать индекс (202, сборка идёт в фоне).
   *
   * Ошибки сервера: 400 `MEMORY_PROJECT_REQUIRED`/`MEMORY_WORKSPACE_REQUIRED`,
   * 404 `PROJECT_NOT_FOUND`, 409 `MEMORY_PROVIDER_UNAVAILABLE`,
   * 422 `MEMORY_INDEX_FAILED`.
   */
  async createMemoryIndex(input: CreateMemoryIndexInput): Promise<{ index: MemoryIndex }> {
    return fetchJSON<{ index: MemoryIndex }>(`${BASE_URL}/memory/indexes`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** POST /memory/indexes/:id/rebuild — пересобрать индекс (202). */
  async rebuildMemoryIndex(id: string, opts?: { force?: boolean }): Promise<{ index: MemoryIndex }> {
    return fetchJSON<{ index: MemoryIndex }>(
      `${BASE_URL}/memory/indexes/${encodeURIComponent(id)}/rebuild`,
      { method: 'POST', body: JSON.stringify(opts ?? {}) },
    )
  },

  /** DELETE /memory/indexes/:id — удалить индекс (204, без тела). */
  async deleteMemoryIndex(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/memory/indexes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /**
   * POST /memory/consolidate — консолидация фактов: поиск дублей и пометка
   * заменённых (PROP-047).
   *
   * Ошибки сервера: 400 `VALIDATION_ERROR` (порог вне 0.5..0.99),
   * 404 `PROJECT_NOT_FOUND`, 409 `MEMORY_PROVIDER_UNAVAILABLE`,
   * 422 `MEMORY_CONSOLIDATION_FAILED`.
   */
  async consolidateMemory(
    input: ConsolidateMemoryInput = {},
  ): Promise<{ report: MemoryConsolidationReport }> {
    return fetchJSON<{ report: MemoryConsolidationReport }>(`${BASE_URL}/memory/consolidate`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /**
   * GET /memory/graph — граф памяти: сущности, факты и связи между ними.
   *
   * Пустая `entity` — весь граф; `depth` — глубина обхода (1..3),
   * `limit` — предел числа узлов (1..200).
   *
   * Ошибки сервера: 400 `VALIDATION_ERROR` (глубина/предел вне диапазона),
   * 404 `PROJECT_NOT_FOUND`, 409 `MEMORY_PROVIDER_UNAVAILABLE`,
   * 422 `MEMORY_GRAPH_FAILED`.
   */
  async getMemoryGraph(params: MemoryGraphParams = {}): Promise<MemoryGraph> {
    const query = buildQuery({
      entity: params.entity,
      depth: params.depth,
      limit: params.limit,
      projectId: params.projectId,
    })
    return fetchJSON<MemoryGraph>(`${BASE_URL}/memory/graph${query}`)
  },
}
