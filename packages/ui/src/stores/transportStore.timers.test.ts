/**
 * PROP-141: live-события таймеров и будильников в диспетчере транспорта.
 *
 * События `timer.created|updated|fired|cancelled` публикуются в канал
 * сессии-получателя, но разбираются **до** проверки `sid`: id сессии лежит в
 * payload, а в кадре WS его может не быть (как у `process.*`/`child.*`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
    listProcesses: vi.fn().mockResolvedValue([]),
    listTimers: vi.fn().mockResolvedValue({
      timers: [],
      total: 0,
      offset: 0,
      limit: 200,
      next_offset: null,
    }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useTimersStore } from './timersStore'
import type { Timer } from '@/lib/api/synthApi'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

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

function makeEvent(type: string, sessionId: string | undefined, data: Record<string, unknown>): WSEvent {
  return {
    type,
    ...(sessionId ? { session_id: sessionId } : {}),
    data,
  } as WSEvent
}

describe('transportStore dispatcher: timer.* (таймеры и будильники)', () => {
  beforeEach(() => {
    useTimersStore.setState({
      byId: {},
      order: [],
      pendingIds: [],
      loading: false,
      error: null,
    })
  })

  it('timer.created — заводит запись таймера', () => {
    dispatch(makeEvent('timer.created', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
      fires_at: '2026-10-01T00:00:00.000Z',
      name: 'отложить',
    }))

    const timer = useTimersStore.getState().byId['tmr_1']!
    expect(timer).toBeDefined()
    expect(timer.kind).toBe('timer')
    expect(timer.status).toBe('active')
    expect(timer.sessionId).toBe('s1')
    expect(timer.projectId).toBe('p1')
  })

  it('timer.created без session_id в кадре — запись всё равно появляется', () => {
    dispatch(makeEvent('timer.created', undefined, {
      timer_id: 'tmr_1',
      kind: 'alarm',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
    }))

    const timer = useTimersStore.getState().byId['tmr_1']!
    expect(timer).toBeDefined()
    expect(timer.kind).toBe('alarm')
    expect(timer.sessionId).toBe('s1')
  })

  it('timer.updated — обновляет статус записи', () => {
    dispatch(makeEvent('timer.created', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
    }))
    dispatch(makeEvent('timer.updated', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'paused',
    }))

    expect(useTimersStore.getState().byId['tmr_1']!.status).toBe('paused')
  })

  it('timer.fired — помечает запись сработавшей', () => {
    dispatch(makeEvent('timer.created', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
    }))
    dispatch(makeEvent('timer.fired', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'fired',
      fired_at: '2026-10-01T00:05:00.000Z',
      scheduled_for: '2026-10-01T00:05:00.000Z',
    }))

    const timer = useTimersStore.getState().byId['tmr_1']!
    expect(timer.status).toBe('fired')
    expect(timer.firedAt).toBe('2026-10-01T00:05:00.000Z')
  })

  it('timer.cancelled — снимает запись из активных', () => {
    dispatch(makeEvent('timer.created', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
    }))
    dispatch(makeEvent('timer.cancelled', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'cancelled',
    }))

    const timer = useTimersStore.getState().byId['tmr_1']!
    expect(timer.status).toBe('cancelled')
    expect(timer.status === 'active').toBe(false)
  })

  it('timer.fired — повторяющийся таймер остаётся активным', () => {
    useTimersStore.getState().upsert(
      makeTimer('tmr_1', { repeat: { mode: 'every', everySec: 60 } }),
    )
    dispatch(makeEvent('timer.fired', 's1', {
      timer_id: 'tmr_1',
      kind: 'timer',
      project_id: 'p1',
      session_id: 's1',
      status: 'active',
      fired_at: '2026-10-01T00:05:00.000Z',
    }))

    expect(useTimersStore.getState().byId['tmr_1']!.status).toBe('active')
  })

  it('чужие события не попадают в реестр таймеров', () => {
    dispatch(makeEvent('stream.chunk', 's1', { content: 'привет', stream_id: 'st1' }))

    expect(useTimersStore.getState().order).toEqual([])
  })
})
