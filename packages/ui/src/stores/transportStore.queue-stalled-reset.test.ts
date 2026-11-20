/**
 * ADR-118 §1: липкий клиентский флаг «очередь стоит» (`queueBySession[sid]
 * .isStalled`) снимается **серверным** снимком `session.updated`.
 *
 * Проблема (репорт владельца): флаг ставится событиями (`queue.stalled`,
 * `questionasked`) и снимается только отдельными событиями. Если сервер
 * перестал их присылать (ход умер, состояние уже «простаивает»), флаг
 * «залипает» и точка в дереве красится/моргает вечно.
 *
 * Решение: `activity.idle` (+ пустой `status.blocked`) или явный
 * `status.queue_stopped === false` в серверном снимке — сервер авторитетнее
 * клиентского флага, снимаем `isStalled`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getStickyNotes: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: apiMocks.getSession,
    getSessionMessages: apiMocks.getSessionMessages,
    getStickyNotes: apiMocks.getStickyNotes,
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const SESSION = 's1'
const dispatch = createDispatcher()

function event(type: string, data: Record<string, unknown> = {}): WSEvent {
  return { type, session_id: SESSION, data }
}

/** Ставит сессию в состояние «очередь стоит» (как после `queue.stalled`). */
function stallQueue(pendingCount = 2): void {
  useChatStore.getState().setQueueStalled(SESSION, pendingCount)
  expect(useChatStore.getState().queueBySession[SESSION]?.isStalled).toBe(true)
}

function isStalled(): boolean {
  return useChatStore.getState().queueBySession[SESSION]?.isStalled === true
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  apiMocks.getSession.mockResolvedValue({ id: SESSION, messages: [], activity: { type: 'idle' } })
  apiMocks.getSessionMessages.mockResolvedValue({ session_id: SESSION, messages: [] })
  apiMocks.getStickyNotes.mockResolvedValue({ notes: [] })
})

describe('session.updated снимает липкий isStalled', () => {
  it('activity.idle + пустой status.blocked — флаг снят', () => {
    stallQueue()

    dispatch(event('session.updated', {
      session_id: SESSION,
      activity: { type: 'idle' },
      status: { blocked: null },
    }))

    expect(isStalled()).toBe(false)
    // Состав очереди не теряется: снимается только признак остановки (баннер
    // панели очереди продолжает жить).
    expect(useChatStore.getState().queueBySession[SESSION]?.pendingCount).toBe(2)
  })

  it('status.queue_stopped === false — флаг снят даже без activity', () => {
    stallQueue()

    dispatch(event('session.updated', {
      session_id: SESSION,
      status: { blocked: null, queue_stopped: false },
    }))

    expect(isStalled()).toBe(false)
  })

  it('activity.busy флаг не трогает (работа идёт, но сервер не сказал «не стоим»)', () => {
    stallQueue()

    dispatch(event('session.updated', {
      session_id: SESSION,
      activity: { type: 'busy', turnId: 't-1' },
    }))

    expect(isStalled()).toBe(true)
  })

  it('activity.idle при непустом status.blocked флаг не трогает (ждём подтверждения)', () => {
    stallQueue()

    dispatch(event('session.updated', {
      session_id: SESSION,
      activity: { type: 'idle' },
      status: { blocked: 'LOCKED' },
    }))

    expect(isStalled()).toBe(true)
  })

  it('частичный патч без activity и без queue_stopped флаг не трогает', () => {
    stallQueue()

    dispatch(event('session.updated', { session_id: SESSION, summarization_pending: false }))

    expect(isStalled()).toBe(true)
  })

  it('флага нет — сброс безвреден (не создаёт запись очереди)', () => {
    dispatch(event('session.updated', {
      session_id: SESSION,
      activity: { type: 'idle' },
      status: { blocked: null, queue_stopped: false },
    }))

    expect(useChatStore.getState().queueBySession[SESSION]).toBeUndefined()
  })

  it('серверный queue_stopped: true в том же снимке — флаг НЕ снимается', () => {
    // Иначе у настоящего стопа пропадал бы баннер «Обработка остановлена»:
    // `activity.idle` — про ход, а не про осознанную остановку очереди.
    stallQueue()

    dispatch(event('session.updated', {
      session_id: SESSION,
      activity: { type: 'idle' },
      status: { blocked: null, queue_stopped: true },
    }))

    expect(isStalled()).toBe(true)
  })
})
