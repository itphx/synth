// timers: домен API v2 — таймеры и будильники (PROP-141, этап 5 B-2).
//
// Серверный контракт (core, `server/routes/timers.ts`):
//   GET    /api/v2/timers?sessionId&projectId&status&kind&limit&offset
//            → { timers, total, offset, limit, next_offset }
//   POST   /api/v2/timers           → 201 { timer }
//   PATCH  /api/v2/timers/:id       → { timer }
//   POST   /api/v2/timers/:id/stop  → { timer } (cancelled, запись остаётся)
//   POST   /api/v2/timers/:id/pause → { timer }
//   POST   /api/v2/timers/:id/resume→ { timer }
//   DELETE /api/v2/timers/:id       → 204
//   GET    /api/v2/timers/:id/firings?limit&offset
//            → { firings, total, offset, limit, next_offset }
//
// Таймер и будильник — **один тип** с двумя видами (`kind`): таймер
// относительный («через 15 минут»), будильник — абсолютный/повторяющийся.
//
// Типы — type-only из `@itphx/synth-shared/types` (модуль стирается
// компилятором, core в браузерный бандл не попадает).

import type {
  Timer,
  TimerFiring,
  TimerKind,
  TimerRepeat,
  TimerStatus,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export type { Timer, TimerFiring, TimerKind, TimerRepeat, TimerStatus }

/** Фильтр выборки таймеров (все условия — по «И»). */
export interface TimersListOptions {
  /** Сессия-получатель сообщения. */
  sessionId?: string
  /** Проект автоматизации. */
  projectId?: string
  /** Статус записи (`active`/`paused`/`fired`/`cancelled`). */
  status?: TimerStatus
  /** Вид автоматизации (`timer`/`alarm`). */
  kind?: TimerKind
  /** Потолок выборки (сервер: дефолт 50, максимум 200). */
  limit?: number
  /** Смещение выборки (постраничный листинг, ADR-118 §4). */
  offset?: number
}

/** Ответ `GET /timers` — страница-сводка таймеров. */
export interface TimersListResponse {
  timers: Timer[]
  total: number
  offset: number
  limit: number
  next_offset: number | null
}

/** Ответ `GET /timers/:id/firings` — страница-сводка истории срабатываний. */
export interface TimerFiringsListResponse {
  firings: TimerFiring[]
  total: number
  offset: number
  limit: number
  next_offset: number | null
}

/**
 * Тело создания таймера/будильника.
 *
 * Это **интент** — правило первого срабатывания:
 * - `repeat.mode = 'once'` + `kind:'timer'` — относительная задержка `delaySec`;
 * - `repeat.mode = 'once'` + `kind:'alarm'` — абсолютное время `at`;
 * - `repeat.mode = 'daily'|'every'` — правило повтора.
 *
 * `projectId` необязателен: сервер выводит его из сессии (`sessionId`) и сверяет
 * с переданным (несовпадение → 400).
 */
export interface TimerCreateInput {
  /** Вид автоматизации. */
  kind: TimerKind
  /** Необязательное имя (карточка в панели «Автоматизация»). */
  name?: string
  /** Комментарий (1…500 символов) — единственный «смысл» срабатывания. */
  comment: string
  /** Сессия-получатель сообщения (обязательна). */
  sessionId: string
  /** Проект автоматизации (выводится сервером из сессии, если не передан). */
  projectId?: string
  /** Правило повтора. */
  repeat: TimerRepeat
  /** Относительная задержка, с (для `kind:'timer'` + `repeat.mode='once'`). */
  delaySec?: number
  /** Абсолютное время срабатывания, ISO-8601 (для `kind:'alarm'` + `once`). */
  at?: string
}

/** Тело частичной правки таймера (`name: null` — сбросить имя). */
export interface TimerPatchInput {
  /** Имя (`null` — сбросить). */
  name?: string | null
  /** Комментарий. */
  comment?: string
  /** Правило повтора (смена пересчитывает ближайшее срабатывание). */
  repeat?: TimerRepeat
}

export const timersApi = {
  /** GET /timers — список таймеров/будильников (страница-сводка). */
  async list(options?: TimersListOptions): Promise<TimersListResponse> {
    const params = new URLSearchParams()
    if (options?.sessionId) params.set('sessionId', options.sessionId)
    if (options?.projectId) params.set('projectId', options.projectId)
    if (options?.status) params.set('status', options.status)
    if (options?.kind) params.set('kind', options.kind)
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    const query = params.toString()
    return fetchJSON<TimersListResponse>(
      `${BASE_URL}/timers${query ? `?${query}` : ''}`,
    )
  },

  /** POST /timers — создать таймер/будильник. */
  async create(input: TimerCreateInput): Promise<Timer> {
    const res = await fetchJSON<{ timer: Timer }>(`${BASE_URL}/timers`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.timer
  },

  /** PATCH /timers/:id — правка (`name`/`comment`/`repeat`). */
  async patch(id: string, input: TimerPatchInput): Promise<Timer> {
    const res = await fetchJSON<{ timer: Timer }>(
      `${BASE_URL}/timers/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )
    return res.timer
  },

  /** POST /timers/:id/stop — остановить насовсем (`status: cancelled`). */
  async stop(id: string): Promise<Timer> {
    const res = await fetchJSON<{ timer: Timer }>(
      `${BASE_URL}/timers/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    )
    return res.timer
  },

  /** POST /timers/:id/pause — поставить таймер на паузу. */
  async pause(id: string): Promise<Timer> {
    const res = await fetchJSON<{ timer: Timer }>(
      `${BASE_URL}/timers/${encodeURIComponent(id)}/pause`,
      { method: 'POST' },
    )
    return res.timer
  },

  /** POST /timers/:id/resume — снять таймер с паузы. */
  async resume(id: string): Promise<Timer> {
    const res = await fetchJSON<{ timer: Timer }>(
      `${BASE_URL}/timers/${encodeURIComponent(id)}/resume`,
      { method: 'POST' },
    )
    return res.timer
  },

  /** DELETE /timers/:id — удалить таймер (история срабатываний остаётся). */
  async remove(id: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/timers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** GET /timers/:id/firings — история срабатываний (страница-сводка). */
  async firings(id: string, limit?: number): Promise<TimerFiring[]> {
    const params = new URLSearchParams()
    if (limit !== undefined) params.set('limit', String(limit))
    const query = params.toString()
    const res = await fetchJSON<TimerFiringsListResponse>(
      `${BASE_URL}/timers/${encodeURIComponent(id)}/firings${query ? `?${query}` : ''}`,
    )
    return res.firings ?? []
  },
}
