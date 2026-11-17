/**
 * timersStore: реестр таймеров и будильников (PROP-141, этап 7a).
 *
 * Таймер и будильник — **один тип** с двумя видами (`kind`): таймер
 * относительный («через 15 минут»), будильник — абсолютный/повторяющийся.
 *
 * Источник истины — сервер: `GET /api/v2/timers` (страница-сводка) +
 * live-события `timer.created|updated|fired|cancelled` (диспетчер
 * `stores/transportStore.ts`).
 *
 * Live-события несут **только метаданные** (id/вид/статус/время): комментарий
 * таймера — пользовательский текст, в событие он не попадает. Поэтому запись,
 * которой в сторе ещё нет, заводится «пустой» — без комментария.
 */

import { create } from 'zustand'

import { synthApi } from '@/lib/api/synthApi'
import type { Timer, TimerStatus } from '@/lib/api/synthApi'

/**
 * Предел выборки активных таймеров (`loadActive`).
 *
 * Сервер отдаёт не больше 200 записей за раз — этого хватает, чтобы значки
 * в дереве не «мигали» на больших инстансах.
 */
const ACTIVE_LIST_LIMIT = 200

/** Статус, при котором таймер ещё ждёт срабатывания. */
const ACTIVE_STATUS: TimerStatus = 'active'

export interface TimersState {
  /** Записи реестра по id. */
  byId: Record<string, Timer>
  /** id записей в порядке «свежие первыми» (`firesAt` убыв.). */
  order: string[]
  /**
   * id записей, пришедших из live-событий и ещё не подтверждённых списком
   * сервера.
   *
   * Защита от гонки «список устарел»: ответ на запрос, ушедший **до**
   * создания таймера, новую запись не содержит — без защиты значок в дереве
   * мигнул бы (запись исчезла бы до следующей перечитки).
   */
  pendingIds: string[]
  /** Идёт ли загрузка списка. */
  loading: boolean
  /** Ошибка загрузки/мутации (текст). */
  error: string | null

  /**
   * Загрузить реестр и слить его с текущим состоянием.
   *
   * Чистка — **по скоупу запроса**: при `sessionId`/`projectId` убираются
   * только записи этого скоупа, которых больше нет в ответе; без фильтров —
   * весь реестр (прежнее поведение).
   */
  load: (options?: TimersLoadOptions) => Promise<void>
  /**
   * Загрузить **только активные** таймеры инстанса (`status=active`).
   *
   * Нужен дереву сессий: значки активных таймеров должны быть видны до
   * открытия панели «Автоматизация». Ответ сервера — выборка `active`,
   * поэтому терминальные записи (`fired`/`cancelled`) и `paused` из неё
   * выпасть не могут и остаются в реестре как есть.
   */
  loadActive: () => Promise<void>
  /** Применить live-событие (`timer.*`). */
  applyEvent: (type: string, payload: Record<string, unknown>) => void
  /** Добавить или заменить запись реестра. */
  upsert: (timer: Timer) => void
  /** Убрать запись реестра. */
  remove: (id: string) => void
  /** Очистить реестр целиком (смена пользователя/инстанса). */
  clear: () => void
}

/** Фильтр выборки таймеров (все условия — по «И»). */
export interface TimersLoadOptions {
  /** Сессия-получатель сообщения. */
  sessionId?: string
  /** Проект автоматизации. */
  projectId?: string
  /** Статус записи. */
  status?: TimerStatus
  /** Вид автоматизации (`timer`/`alarm`). */
  kind?: Timer['kind']
  /** Потолок выборки. */
  limit?: number
  /** Смещение выборки. */
  offset?: number
}

/** Момент ближайшего срабатывания в миллисекундах (0 — дата не разбирается). */
function firesAtMs(timer: Timer | undefined): number {
  const parsed = Date.parse(timer?.firesAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Порядок записей: ближайшее срабатывание первым, при равенстве — по id. */
function sortOrder(byId: Record<string, Timer>): string[] {
  return Object.keys(byId).sort((a, b) => {
    const diff = firesAtMs(byId[a]) - firesAtMs(byId[b])
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Попадает ли запись в скоуп запроса списка таймеров.
 *
 * Ответ сервера отфильтрован (`sessionId`/`projectId`), поэтому записи
 * **вне** скоупа в нём просто не приходят — но и удалять их нельзя: реестр
 * общий, и от чужих записей зависят значки активности в дереве сессий.
 * Без фильтра запроса скоуп — весь реестр (прежнее поведение).
 */
function inRequestedScope(timer: Timer, options?: TimersLoadOptions): boolean {
  if (options?.sessionId) return timer.sessionId === options.sessionId
  if (options?.projectId) return timer.projectId === options.projectId
  return true
}

/** Читает строковое поле payload. */
function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Статус записи из payload события (неизвестное — `active`). */
function statusFromPayload(payload: Record<string, unknown>): TimerStatus {
  const value = str(payload, 'status')
  if (value === 'paused' || value === 'fired' || value === 'cancelled') return value
  return ACTIVE_STATUS
}

/** Вид автоматизации из payload события (неизвестное — `timer`). */
function kindFromPayload(payload: Record<string, unknown>): Timer['kind'] {
  return str(payload, 'kind') === 'alarm' ? 'alarm' : 'timer'
}

/**
 * Статус записи по live-событию.
 *
 * `timer.fired` — особый случай: ядро публикует событие **до** перевода
 * записи в терминальный статус (`_applyFiringResult`), поэтому в payload
 * у одноразового таймера ещё лежит `active`. Одноразовый таймер после
 * срабатывания больше не активен — помечаем его `fired`. Повторяющийся
 * (`daily`/`every`) остаётся активным: у него следующий цикл.
 *
 * Повтор известен только из снимка сервера (в live-событии `repeat` нет):
 * неизвестный режим трактуем как одноразовый — повторяющийся таймер в реестре
 * виден сразу (он активен с момента создания).
 */
function statusFromEvent(
  type: string,
  payload: Record<string, unknown>,
  prev: Timer | undefined,
): TimerStatus {
  if (type === 'timer.cancelled') return 'cancelled'
  if (type === 'timer.fired') {
    const repeating = prev?.repeat !== undefined && prev.repeat.mode !== 'once'
    return repeating ? 'active' : 'fired'
  }
  return statusFromPayload(payload)
}

export const useTimersStore = create<TimersState>()((set) => ({
  byId: {},
  order: [],
  pendingIds: [],
  loading: false,
  error: null,

  load: async (options) => {
    set({ loading: true, error: null })
    try {
      const page = await synthApi.listTimers(options)
      set((s) => {
        const byId: Record<string, Timer> = { ...s.byId }
        const fetched = new Set(page.timers.map((timer) => timer.id))
        for (const timer of page.timers) {
          byId[timer.id] = { ...byId[timer.id], ...timer }
        }
        // Записи, которых больше нет в ответе сервера, убираем — но только
        // **в том скоупе, который запросили**: ответ отфильтрован сервером,
        // и записи других сессий/проектов в нём не приходят вовсе. Иначе
        // открытая панель «Автоматизация» вычищала бы из общего реестра чужие
        // записи (от них зависят значки активности в дереве сессий).
        // Записи из live-событий (ещё не подтверждённые сервером) не трогаем:
        // ответ мог уйти до их появления.
        for (const [id, timer] of Object.entries(byId)) {
          if (fetched.has(id)) continue
          if (s.pendingIds.includes(id)) continue
          if (!inRequestedScope(timer, options)) continue
          delete byId[id]
        }
        return {
          byId,
          order: sortOrder(byId),
          pendingIds: s.pendingIds.filter((id) => !fetched.has(id)),
          loading: false,
          error: null,
        }
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  loadActive: async () => {
    try {
      const page = await synthApi.listTimers({
        status: ACTIVE_STATUS,
        limit: ACTIVE_LIST_LIMIT,
      })
      set((s) => {
        const byId: Record<string, Timer> = { ...s.byId }
        const fetched = new Set(page.timers.map((timer) => timer.id))
        for (const timer of page.timers) {
          byId[timer.id] = { ...byId[timer.id], ...timer }
        }
        // Ответ — выборка `active`, поэтому неактивные записи в нём
        // отсутствуют и остаются в реестре как есть. Убираем только
        // `active`-записи, которых сервер больше не отдаёт.
        for (const [id, timer] of Object.entries(byId)) {
          if (timer.status !== ACTIVE_STATUS) continue
          if (fetched.has(id)) continue
          if (s.pendingIds.includes(id)) continue
          delete byId[id]
        }
        return {
          byId,
          order: sortOrder(byId),
          pendingIds: s.pendingIds.filter((id) => !fetched.has(id)),
          error: null,
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  applyEvent: (type, payload) => {
    if (!type.startsWith('timer.')) return

    const id = str(payload, 'timer_id')
    if (!id) return

    set((s) => {
      const prev = s.byId[id]
      const now = new Date().toISOString()
      const status = statusFromEvent(type, payload, prev)
      const patch: Partial<Timer> = {
        // `id` — часть записи (не только ключ реестра): карточка/история/
        // действия используют `timer.id`, а live-событие приходит без тела.
        id,
        kind: kindFromPayload(payload),
        status,
        sessionId: str(payload, 'session_id') ?? prev?.sessionId ?? '',
        projectId: str(payload, 'project_id') ?? prev?.projectId ?? '',
        ...(str(payload, 'fires_at') ? { firesAt: str(payload, 'fires_at')! } : {}),
        ...(str(payload, 'fired_at') ? { firedAt: str(payload, 'fired_at')! } : {}),
        ...(str(payload, 'name') ? { name: str(payload, 'name')! } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      }
      const byId = { ...s.byId, [id]: { ...prev, ...patch } as Timer }
      const pendingIds = s.pendingIds.includes(id)
        ? s.pendingIds
        : [...s.pendingIds, id]
      return { byId, order: sortOrder(byId), pendingIds }
    })
  },

  upsert: (timer) => {
    set((s) => {
      const byId = { ...s.byId, [timer.id]: { ...s.byId[timer.id], ...timer } }
      return {
        byId,
        order: sortOrder(byId),
        pendingIds: s.pendingIds.filter((id) => id !== timer.id),
      }
    })
  },

  remove: (id) => {
    set((s) => {
      if (!s.byId[id]) return {}
      const byId = { ...s.byId }
      delete byId[id]
      return {
        byId,
        order: sortOrder(byId),
        pendingIds: s.pendingIds.filter((pending) => pending !== id),
      }
    })
  },

  clear: () => {
    set({ byId: {}, order: [], pendingIds: [], loading: false, error: null })
  },
}))

/** Счётчики активных автоматизаций сессии (таймеры/будильники). */
export interface TimerSessionCounts {
  /** Активных таймеров (`kind === 'timer'`). */
  timers: number
  /** Активных будильников (`kind === 'alarm'`). */
  alarms: number
}

/**
 * Активные таймеры сессии (в порядке реестра — ближайшее срабатывание первым).
 *
 * Активен только статус `active`: `paused` не сработает, `fired`/`cancelled`
 * — терминальные.
 */
export function activeBySession(
  state: { byId: Record<string, Timer>; order: string[] },
  sessionId: string,
): Timer[] {
  const out: Timer[] = []
  for (const id of state.order) {
    const timer = state.byId[id]
    if (timer && timer.sessionId === sessionId && timer.status === ACTIVE_STATUS) {
      out.push(timer)
    }
  }
  return out
}

/**
 * Счётчики активных таймеров и будильников по сессиям.
 *
 * Сессии без активных автоматизаций в карте не попадают.
 */
export function countsBySession(state: {
  byId: Record<string, Timer>
  order: string[]
}): Map<string, TimerSessionCounts> {
  const counts = new Map<string, TimerSessionCounts>()
  for (const id of state.order) {
    const timer = state.byId[id]
    if (!timer || timer.status !== ACTIVE_STATUS) continue
    if (!timer.sessionId) continue
    let entry = counts.get(timer.sessionId)
    if (!entry) {
      entry = { timers: 0, alarms: 0 }
      counts.set(timer.sessionId, entry)
    }
    if (timer.kind === 'alarm') entry.alarms += 1
    else entry.timers += 1
  }
  return counts
}
