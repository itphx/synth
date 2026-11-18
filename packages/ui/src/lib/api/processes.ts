// processes: домен API v2 — единый реестр фоновых прогонов (PROP-096/097).
//
// Серверный контракт (core, `server/routes/processes.ts`):
//   GET    /api/v2/processes?sessionId&projectId&kind&status&limit
//            → { runs: BackgroundRunRecord[] }
//   GET    /api/v2/processes?…&include=blocking
//            → { runs: BackgroundRunRecord[], blocking: BlockingRunDto[] }
//   POST   /api/v2/processes/blocking/:id/stop   → { stopped: true }
//   GET    /api/v2/processes/blocking/:id/logs?offset&limit
//            → { content, offset, nextOffset, totalBytes, truncated }
//
// Блокирующие прогоны (ADR-111 §detach) — те, что идут **внутри хода**
// (`execute_shell` foreground / `task`): записи в реестре фоновых прогонов у
// них ещё нет, поэтому они приходят отдельным аддитивным полем `blocking`.
//   GET    /api/v2/processes/:id                → { run }
//   GET    /api/v2/processes/:id/logs?offset&limit&stream=combined|stdout|stderr
//            → { content, offset, nextOffset, totalBytes, truncated }
//   POST   /api/v2/processes/:id/stop            → { status: 'stopping' }
//   DELETE /api/v2/processes/:id                → 204
//
// Реестр обслуживает два вида фоновой работы: `subagent` (фоновая дочерняя
// сессия саб-агента) и `process` (фоновая шелл-команда). Логи есть только
// у `process` — сервер отвечает 400 на `logs` прогона-саб-агента.
//
// Типы — type-only из `@itphx/synth-shared/types` (модуль стирается
// компилятором, core в браузерный бандл не попадает).

import type {
  BackgroundRunKind,
  BackgroundRunRecord,
  BackgroundRunStatus,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export type { BackgroundRunKind, BackgroundRunRecord, BackgroundRunStatus }

/**
 * Поток вывода фонового процесса.
 *
 * `combined` (по умолчанию) — общий лог прогона (stdout и stderr в порядке
 * прихода); `stdout`/`stderr` — отдельный файл потока (он есть у прогонов,
 * запущенных после разделения потоков; у более старых — файла нет → 404).
 */
export type ProcessLogStream = 'stdout' | 'stderr' | 'combined'

/** Фильтр выборки фоновых прогонов (все условия — по «И»). */
export interface ProcessesListOptions {
  /** Сессия-владелец прогона (для `subagent` — родитель, для `process` — запустившая команда). */
  sessionId?: string
  /** Проект сессии-владельца. */
  projectId?: string
  /** Вид фоновой работы. */
  kind?: BackgroundRunKind
  /** Статус прогона. */
  status?: BackgroundRunStatus
  /** Предел выборки (сервер: дефолт 50, максимум 200). */
  limit?: number
  /**
   * `blocking` — добавить в ответ блокирующие прогоны (ADR-111 §detach).
   * Другое значение сервер отклоняет (400).
   */
  include?: 'blocking'
}

/**
 * Блокирующий прогон (ADR-111 §detach) — идёт **внутри хода**, записи в
 * реестре фоновых прогонов у него ещё нет.
 *
 * `kind` — вид работы: `process` (foreground `execute_shell`) или `subagent`
 * (блокирующий `task`). `logPath` есть только у процесса; живой лог читается
 * `GET /processes/blocking/:id/logs`.
 */
export interface BlockingRun {
  /** id активного прогона (в памяти оркестратора). */
  id: string
  kind: BackgroundRunKind
  /** Сессия-владелец (проверка доступа идёт через неё). */
  sessionId: string
  /** Человеческое имя: команда процесса или описание саб-агента. */
  title?: string
  /** id процесса исполнителя (`kind: 'process'`). */
  processId?: string
  /** id дочерней сессии (`kind: 'subagent'`). */
  childSessionId?: string
  /** Путь к live-логу (`kind: 'process'`). */
  logPath?: string
  /** Время старта, ISO-8601. */
  startedAt?: string
}

/** Ответ `GET /processes` — реестр фоновых прогонов. */
export interface ProcessesListResponse {
  runs: BackgroundRunRecord[]
  /** Аддитивно (`include=blocking`): блокирующие прогоны видимых сессий. */
  blocking?: BlockingRun[]
}

/** Ответ `GET /processes?include=blocking` — реестр + блокирующие прогоны. */
export interface ProcessesWithBlockingResponse {
  runs: BackgroundRunRecord[]
  blocking: BlockingRun[]
}

/** Ответ `POST /processes/blocking/:id/stop`. */
export interface BlockingStopResponse {
  /** Всегда `true` (неудача — `409`). */
  stopped: boolean
}

/** Ответ `GET /processes/:id` — деталь фонового прогона. */
export interface ProcessResponse {
  run: BackgroundRunRecord
}

/** Отрезок лога фонового процесса. */
export interface ProcessLogsOptions {
  /** Смещение в байтах от начала лога. */
  offset?: number
  /** Предел выдачи, байт (сервер: по умолчанию и максимум 256 КиБ — как отдаёт сервер). */
  limit?: number
  /** Поток вывода (не задан — общий лог прогона, `combined`). */
  stream?: ProcessLogStream
}

/** Ответ `GET /processes/:id/logs` — отрезок лога фонового процесса. */
export interface ProcessLogsResponse {
  /** Текст отрезка лога. */
  content: string
  /** Смещение, с которого начат отрезок. */
  offset: number
  /** Смещение следующего отрезка (конец текущего). */
  nextOffset: number
  /** Полный размер лога, байт. */
  totalBytes: number
  /** Лог обрезан по лимиту записи (хвост потерян). */
  truncated: boolean
}

/** Ответ `POST /processes/:id/stop` — остановка асинхронная. */
export interface ProcessStopResponse {
  /** Всегда `stopping`. */
  status: string
}

/** Query-строка фильтров списка прогонов (пустая — без `?`). */
function buildListQuery(options?: ProcessesListOptions): string {
  const params = new URLSearchParams()
  if (options?.sessionId) params.set('sessionId', options.sessionId)
  if (options?.projectId) params.set('projectId', options.projectId)
  if (options?.kind) params.set('kind', options.kind)
  if (options?.status) params.set('status', options.status)
  if (options?.limit !== undefined) params.set('limit', String(options.limit))
  if (options?.include) params.set('include', options.include)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const processesApi = {
  /** GET /processes — реестр фоновых прогонов (фильтры — по «И»). */
  async list(options?: ProcessesListOptions): Promise<BackgroundRunRecord[]> {
    const response = await fetchJSON<ProcessesListResponse>(
      `${BASE_URL}/processes${buildListQuery(options)}`,
    )
    return response.runs ?? []
  },

  /**
   * GET /processes?include=blocking — реестр **и** блокирующие прогоны.
   *
   * Отдельный метод (а не флаг у `list`): форма ответа отличается, а `list`
   * остаётся прежним — его вызывающие не должны внезапно получать конверт.
   */
  async listWithBlocking(
    options?: Omit<ProcessesListOptions, 'include'>,
  ): Promise<ProcessesWithBlockingResponse> {
    const response = await fetchJSON<ProcessesListResponse>(
      `${BASE_URL}/processes${buildListQuery({ ...options, include: 'blocking' })}`,
    )
    return { runs: response.runs ?? [], blocking: response.blocking ?? [] }
  },

  /** GET /processes/:id — деталь фонового прогона. */
  async get(id: string): Promise<BackgroundRunRecord> {
    const response = await fetchJSON<ProcessResponse>(
      `${BASE_URL}/processes/${encodeURIComponent(id)}`,
    )
    return response.run
  },

  /** GET /processes/:id/logs — отрезок лога фонового процесса. */
  async logs(id: string, options?: ProcessLogsOptions): Promise<ProcessLogsResponse> {
    const params = new URLSearchParams()
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.stream !== undefined) params.set('stream', options.stream)
    const query = params.toString()
    return fetchJSON<ProcessLogsResponse>(
      `${BASE_URL}/processes/${encodeURIComponent(id)}/logs${query ? `?${query}` : ''}`,
    )
  },

  /** POST /processes/:id/stop — остановить фоновый прогон (409, если он уже не выполняется). */
  async stop(id: string): Promise<ProcessStopResponse> {
    return fetchJSON<ProcessStopResponse>(
      `${BASE_URL}/processes/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    )
  },

  /** DELETE /processes/:id — удалить терминальную запись реестра (409, если он ещё выполняется). */
  async remove(id: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/processes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /**
   * POST /processes/blocking/:id/stop — остановить блокирующий прогон.
   *
   * `409 notStoppable` — остановить отсюда нельзя (нет хэндла/уже завершён);
   * `403`/`404` — правило доступа сервера (UI его не дублирует).
   */
  async stopBlocking(id: string): Promise<BlockingStopResponse> {
    return fetchJSON<BlockingStopResponse>(
      `${BASE_URL}/processes/blocking/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    )
  },

  /**
   * GET /processes/blocking/:id/logs — отрезок live-лога блокирующего прогона.
   *
   * Форма ответа — как у `GET /processes/:id/logs` (единый формат отрезка):
   * поток один (`combined`), поэтому `stream` не передаётся.
   */
  async blockingLogs(
    id: string,
    options?: Pick<ProcessLogsOptions, 'offset' | 'limit'>,
  ): Promise<ProcessLogsResponse> {
    const params = new URLSearchParams()
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.toString()
    return fetchJSON<ProcessLogsResponse>(
      `${BASE_URL}/processes/blocking/${encodeURIComponent(id)}/logs${query ? `?${query}` : ''}`,
    )
  },
}
