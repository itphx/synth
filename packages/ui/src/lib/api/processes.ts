// processes: домен API v2 — единый реестр фоновых прогонов (PROP-096/097).
//
// Серверный контракт (core, `server/routes/processes.ts`):
//   GET    /api/v2/processes?sessionId&projectId&kind&status&limit
//            → { runs: BackgroundRunRecord[] }
//   GET    /api/v2/processes/:id                → { run }
//   GET    /api/v2/processes/:id/logs?offset&limit
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
}

/** Ответ `GET /processes` — реестр фоновых прогонов. */
export interface ProcessesListResponse {
  runs: BackgroundRunRecord[]
}

/** Ответ `GET /processes/:id` — деталь фонового прогона. */
export interface ProcessResponse {
  run: BackgroundRunRecord
}

/** Отрезок лога фонового процесса. */
export interface ProcessLogsOptions {
  /** Смещение в байтах от начала лога. */
  offset?: number
  /** Предел выдачи, байт (сервер: дефолт 64 КиБ, максимум 256 КиБ). */
  limit?: number
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

export const processesApi = {
  /** GET /processes — реестр фоновых прогонов (фильтры — по «И»). */
  async list(options?: ProcessesListOptions): Promise<BackgroundRunRecord[]> {
    const params = new URLSearchParams()
    if (options?.sessionId) params.set('sessionId', options.sessionId)
    if (options?.projectId) params.set('projectId', options.projectId)
    if (options?.kind) params.set('kind', options.kind)
    if (options?.status) params.set('status', options.status)
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.toString()
    const response = await fetchJSON<ProcessesListResponse>(
      `${BASE_URL}/processes${query ? `?${query}` : ''}`,
    )
    return response.runs ?? []
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
}
