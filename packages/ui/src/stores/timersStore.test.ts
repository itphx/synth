/**
 * Реестр таймеров и будильников (PROP-141, этап 7a).
 *
 * Проверяются: загрузка списка (в т.ч. чистка по скоупу запроса), выборка
 * активных, live-события `timer.*`, точечные `upsert`/`remove` и селекторы
 * (`activeBySession`/`countsBySession`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listTimers: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { listTimers: mocks.listTimers },
}))

import {
  useTimersStore,
  activeBySession,
  countsBySession,
} from './timersStore'
import type { Timer } from '@/lib/api/synthApi'

/** Запись таймера/будильника (активная по умолчанию). */
function makeTimer(id: string, overrides: Partial<Timer> = {}): Timer {
  return {
    id,
    kind: 'timer',
    comment: 'напомнить',
    projectId: 'p1',
    sessionId: 's1',
    ownerId: 'u1',
    repeat: { mode: 'once' },
    status: 'active',
    firesAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Ответ `GET /timers` — страница-сводка. */
function page(timers: Timer[]) {
  return {
    timers,
    total: timers.length,
    offset: 0,
    limit: 50,
    next_offset: null,
  }
}

describe('timersStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTimersStore.setState({
      byId: {},
      order: [],
      pendingIds: [],
      loading: false,
      error: null,
    })
  })

  it('load наполняет реестр и сортирует по ближайшему срабатыванию', async () => {
    mocks.listTimers.mockResolvedValue(
      page([
        makeTimer('late', { firesAt: '2026-10-03T00:00:00.000Z' }),
        makeTimer('soon', { firesAt: '2026-10-02T00:00:00.000Z' }),
      ]),
    )

    await useTimersStore.getState().load()

    const state = useTimersStore.getState()
    expect(mocks.listTimers).toHaveBeenCalledTimes(1)
    expect(state.order).toEqual(['soon', 'late'])
    expect(state.byId['soon']!.id).toBe('soon')
    expect(state.loading).toBe(false)
  })

  it('load убирает записи, которых больше нет в ответе сервера', async () => {
    mocks.listTimers.mockResolvedValue(page([makeTimer('keep')]))
    useTimersStore.getState().upsert(makeTimer('stale'))

    await useTimersStore.getState().load()

    const state = useTimersStore.getState()
    expect(state.byId['stale']).toBeUndefined()
    expect(state.byId['keep']).toBeDefined()
  })

  it('load с фильтром по сессии не трогает записи других сессий', async () => {
    mocks.listTimers.mockResolvedValue(page([makeTimer('s1-timer', { sessionId: 's1' })]))
    useTimersStore.getState().upsert(makeTimer('s2-timer', { sessionId: 's2' }))
    useTimersStore.getState().upsert(makeTimer('s1-stale', { sessionId: 's1' }))

    await useTimersStore.getState().load({ sessionId: 's1' })

    const state = useTimersStore.getState()
    // Запись чужой сессии на месте — от неё зависят значки активности в дереве.
    expect(state.byId['s2-timer']).toBeDefined()
    expect(state.byId['s1-stale']).toBeUndefined()
    expect(state.byId['s1-timer']).toBeDefined()
  })

  it('load не вычищает запись, пришедшую из live-события (список устарел)', async () => {
    mocks.listTimers.mockResolvedValue(page([makeTimer('server')]))
    useTimersStore.getState().applyEvent('timer.created', {
      timer_id: 'tmr_event',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
    })

    await useTimersStore.getState().load()

    const state = useTimersStore.getState()
    expect(state.byId['tmr_event']).toBeDefined()
    expect(state.byId['server']).toBeDefined()
  })

  it('load сохраняет ошибку в сторе', async () => {
    mocks.listTimers.mockRejectedValue(new Error('boom'))

    await useTimersStore.getState().load()

    const state = useTimersStore.getState()
    expect(state.error).toBe('boom')
    expect(state.loading).toBe(false)
  })

  it('loadActive просит только активные и не выкидывает неактивные записи', async () => {
    mocks.listTimers.mockResolvedValue(page([makeTimer('active-1')]))
    useTimersStore.getState().upsert(makeTimer('paused', { status: 'paused' }))

    await useTimersStore.getState().loadActive()

    const state = useTimersStore.getState()
    expect(mocks.listTimers).toHaveBeenCalledWith({ status: 'active', limit: 200 })
    expect(state.byId['active-1']).toBeDefined()
    // `paused` в выборку `active` не попадает — запись остаётся как есть.
    expect(state.byId['paused']).toBeDefined()
  })

  it('loadActive убирает активные записи, которых сервер больше не отдаёт', async () => {
    mocks.listTimers.mockResolvedValue(page([makeTimer('keep')]))
    useTimersStore.getState().upsert(makeTimer('gone'))

    await useTimersStore.getState().loadActive()

    const state = useTimersStore.getState()
    expect(state.byId['gone']).toBeUndefined()
    expect(state.byId['keep']).toBeDefined()
  })

  it('applyEvent заводит запись по timer.created', () => {
    useTimersStore.getState().applyEvent('timer.created', {
      timer_id: 'tmr_1',
      kind: 'alarm',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
      fires_at: '2026-10-05T00:00:00.000Z',
      name: 'будильник',
    })

    const state = useTimersStore.getState()
    const timer = state.byId['tmr_1']!
    expect(timer).toBeDefined()
    expect(timer.kind).toBe('alarm')
    expect(timer.status).toBe('active')
    expect(timer.sessionId).toBe('s1')
    expect(timer.projectId).toBe('p1')
    expect(timer.firesAt).toBe('2026-10-05T00:00:00.000Z')
    expect(state.order).toEqual(['tmr_1'])
  })

  it('applyEvent обновляет статус существующей записи', () => {
    useTimersStore.getState().upsert(makeTimer('tmr_1'))
    useTimersStore.getState().applyEvent('timer.updated', {
      timer_id: 'tmr_1',
      kind: 'timer',
      session_id: 's1',
      project_id: 'p1',
      status: 'paused',
    })

    expect(useTimersStore.getState().byId['tmr_1']!.status).toBe('paused')
  })

  it('applyEvent timer.cancelled снимает запись из активных', () => {
    useTimersStore.getState().upsert(makeTimer('tmr_1'))
    useTimersStore.getState().applyEvent('timer.cancelled', {
      timer_id: 'tmr_1',
      kind: 'timer',
      session_id: 's1',
      project_id: 'p1',
    })

    const state = useTimersStore.getState()
    expect(state.byId['tmr_1']!.status).toBe('cancelled')
    expect(activeBySession(state, 's1')).toHaveLength(0)
  })

  it('applyEvent timer.fired — одноразовый таймер помечается сработавшим', () => {
    useTimersStore.getState().upsert(makeTimer('tmr_1', { repeat: { mode: 'once' } }))
    useTimersStore.getState().applyEvent('timer.fired', {
      timer_id: 'tmr_1',
      kind: 'timer',
      session_id: 's1',
      project_id: 'p1',
      // Ядро публикует событие до перевода записи в терминальный статус —
      // в payload у одноразового таймера ещё лежит `active`.
      status: 'active',
      fired_at: '2026-10-01T00:05:00.000Z',
    })

    const state = useTimersStore.getState()
    expect(state.byId['tmr_1']!.status).toBe('fired')
    expect(state.byId['tmr_1']!.firedAt).toBe('2026-10-01T00:05:00.000Z')
    expect(activeBySession(state, 's1')).toHaveLength(0)
  })

  it('applyEvent timer.fired — повторяющийся таймер остаётся активным', () => {
    useTimersStore.getState().upsert(
      makeTimer('tmr_1', { repeat: { mode: 'every', everySec: 60 } }),
    )
    useTimersStore.getState().applyEvent('timer.fired', {
      timer_id: 'tmr_1',
      kind: 'timer',
      session_id: 's1',
      project_id: 'p1',
      status: 'active',
      fired_at: '2026-10-01T00:05:00.000Z',
    })

    const state = useTimersStore.getState()
    expect(state.byId['tmr_1']!.status).toBe('active')
    expect(activeBySession(state, 's1')).toHaveLength(1)
  })

  it('applyEvent игнорирует чужие типы и события без id', () => {
    useTimersStore.getState().applyEvent('message.added', { timer_id: 'tmr_1' })
    useTimersStore.getState().applyEvent('timer.created', { kind: 'timer' })

    expect(useTimersStore.getState().byId).toEqual({})
  })

  it('upsert добавляет и заменяет запись', () => {
    useTimersStore.getState().upsert(makeTimer('tmr_1'))
    useTimersStore.getState().upsert(makeTimer('tmr_1', { comment: 'новый комментарий' }))

    const state = useTimersStore.getState()
    expect(state.order).toEqual(['tmr_1'])
    expect(state.byId['tmr_1']!.comment).toBe('новый комментарий')
  })

  it('remove убирает запись из реестра', () => {
    useTimersStore.getState().upsert(makeTimer('tmr_1'))
    useTimersStore.getState().remove('tmr_1')

    const state = useTimersStore.getState()
    expect(state.byId['tmr_1']).toBeUndefined()
    expect(state.order).toEqual([])
  })

  it('activeBySession отдаёт только активные записи сессии', () => {
    useTimersStore.setState({
      byId: {
        t1: makeTimer('t1', { sessionId: 's1' }),
        t2: makeTimer('t2', { sessionId: 's1', status: 'paused' }),
        t3: makeTimer('t3', { sessionId: 's2' }),
      },
      order: ['t1', 't2', 't3'],
      pendingIds: [],
    })

    const active = activeBySession(useTimersStore.getState(), 's1')
    expect(active.map((timer) => timer.id)).toEqual(['t1'])
  })

  it('countsBySession считает таймеры и будильники по сессиям', () => {
    useTimersStore.setState({
      byId: {
        t1: makeTimer('t1', { sessionId: 's1', kind: 'timer' }),
        t2: makeTimer('t2', { sessionId: 's1', kind: 'alarm' }),
        t3: makeTimer('t3', { sessionId: 's1', kind: 'alarm', status: 'paused' }),
        t4: makeTimer('t4', { sessionId: 's2', kind: 'timer' }),
      },
      order: ['t1', 't2', 't3', 't4'],
      pendingIds: [],
    })

    const counts = countsBySession(useTimersStore.getState())
    expect(counts.get('s1')).toEqual({ timers: 1, alarms: 1 })
    expect(counts.get('s2')).toEqual({ timers: 1, alarms: 0 })
  })
})
