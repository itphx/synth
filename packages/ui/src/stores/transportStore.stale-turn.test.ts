/**
 * ADR-118 §5: зависший ход не должен моргать бесконечно.
 *
 * Репорт владельца: после падения хода по ошибке провайдера индикатор «идёт
 * работа» (точка сессии в левом дереве и строка активности в ленте) продолжает
 * моргать. Причина — терминальное событие не применилось молча:
 * - `finishTurn` игнорирует несовпадение `turnId`;
 * - `closeTurnOnTerminal` игнорировал несовпадение `stream_id`;
 * - серверный `activity` (`idle`/`busy`) в рантайме не использовался.
 *
 * Здесь — четыре сценария закрытия (а, б, в, г) плюс сторож по тишине.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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

import {
  closeHungTurn,
  createDispatcher,
  lastEventAtBySession,
  sessionSilenceMs,
  TURN_START_GRACE_MS,
  TURN_FOREIGN_TERMINAL_SILENCE_MS,
} from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const SESSION = 's1'
const dispatch = createDispatcher()

/** База времени: fake timers, чтобы окна грации и тишины были детерминированы. */
const T0 = new Date('2026-11-20T10:00:00.000Z').getTime()

function event(type: string, data: Record<string, unknown> = {}): WSEvent {
  return { type, session_id: SESSION, data }
}

function turn() {
  return useChatStore.getState().turnBySession[SESSION]
}

/** Старт хода «как в жизни»: `stream.start` + `turn.started`. */
function startTurn(turnId = 't-1', streamId = 'st-1'): void {
  dispatch(event('stream.start', { stream_id: streamId }))
  dispatch(event('turn.started', { turnId }))
}

/** `session.updated` с серверным снимком активности (как в `serializeSession`). */
function sessionUpdated(activity: Record<string, unknown>, blocked: string | null = null): void {
  dispatch(event('session.updated', {
    session_id: SESSION,
    activity,
    status: { blocked },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  resetChatStore()
  lastEventAtBySession.clear()
  apiMocks.getSession.mockResolvedValue({ id: SESSION, messages: [], activity: { type: 'idle' } })
  apiMocks.getSessionMessages.mockResolvedValue({ session_id: SESSION, messages: [] })
  apiMocks.getStickyNotes.mockResolvedValue({ notes: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('(а) ошибка провайдера: терминальные события закрывают ход', () => {
  it('turn.started → stream.error → turn.finished: ход закрыт ошибкой и не возвращается в streaming', () => {
    startTurn()
    expect(turn()?.status).toBe('streaming')

    dispatch(event('stream.error', {
      stream_id: 'st-1',
      error: 'provider exploded',
      error_type: 'provider',
    }))
    expect(turn()?.status).toBe('error')

    // Поздний `turn.finished` статус не переоткрывает.
    dispatch(event('turn.finished', { turnId: 't-1', status: 'error' }))
    expect(turn()?.status).toBe('error')
  })

  it('stream.error без stream.start (у хода нет streamId) ход тоже закрывает', () => {
    dispatch(event('turn.started', { turnId: 't-1' }))
    dispatch(event('stream.error', { stream_id: 'st-unknown', error: 'boom', error_type: 'provider' }))

    expect(turn()?.status).toBe('error')
  })
})

describe('(б) серверный activity — источник истины: ход закрывается без terminal-события', () => {
  it('activity.idle + пустой status.blocked закрывает зависший ход', () => {
    startTurn()
    // Ход стартовал давно: окно грации прошло, событий больше не было.
    vi.setSystemTime(T0 + TURN_START_GRACE_MS + 1000)

    sessionUpdated({ type: 'idle' })

    expect(turn()?.status).toBe('stopped')
    expect(turn()?.status).not.toBe('streaming')
  })

  it('activity.busy ход не закрывает', () => {
    startTurn()
    vi.setSystemTime(T0 + TURN_START_GRACE_MS + 1000)

    sessionUpdated({ type: 'busy', turnId: 't-1', streamId: 'st-1' })

    expect(turn()?.status).toBe('streaming')
  })

  it('activity.idle при непустом status.blocked (ждём подтверждения) ход не закрывает', () => {
    startTurn()
    vi.setSystemTime(T0 + TURN_START_GRACE_MS + 1000)

    sessionUpdated({ type: 'idle' }, 'LOCKED')

    expect(turn()?.status).toBe('streaming')
  })

  it('недавний старт (< окна грации) — ход не закрывается: защита от гонки', () => {
    startTurn()
    vi.setSystemTime(T0 + 1000)
    expect(sessionSilenceMs(SESSION)).toBeLessThan(TURN_START_GRACE_MS)

    sessionUpdated({ type: 'idle' })

    expect(turn()?.status).toBe('streaming')
  })

  it('session.updated без activity (точечные флаги) ход не трогает', () => {
    startTurn()
    vi.setSystemTime(T0 + TURN_START_GRACE_MS + 1000)

    dispatch(event('session.updated', { session_id: SESSION, summarization_pending: false }))

    expect(turn()?.status).toBe('streaming')
  })
})

describe('(в) чужой turnId в turn.finished', () => {
  it('живой ход (события идут) не ломается', () => {
    startTurn()
    // Событие хода только что — тишина меньше порога.
    vi.setSystemTime(T0 + 1000)
    dispatch(event('part.delta', {
      turnId: 't-1', messageId: 'a-1', partId: 'msg:text:0', field: 'text', delta: 'привет',
    }))

    dispatch(event('turn.finished', { turnId: 't-other', status: 'completed' }))

    expect(turn()?.turnId).toBe('t-1')
    expect(turn()?.status).toBe('streaming')
  })

  it('зависший ход (тишина больше порога) чужим терминалом закрывается', () => {
    startTurn()
    vi.setSystemTime(T0 + TURN_FOREIGN_TERMINAL_SILENCE_MS + 1000)

    dispatch(event('turn.finished', { turnId: 't-other', status: 'completed' }))

    expect(turn()?.turnId).toBe('t-1')
    expect(turn()?.status).toBe('completed')
  })

  it('чужой stream_id в stream.error при молчащем ходе закрывает текущий', () => {
    startTurn()
    vi.setSystemTime(T0 + TURN_FOREIGN_TERMINAL_SILENCE_MS + 1000)

    dispatch(event('stream.error', {
      stream_id: 'st-other', error: 'boom', error_type: 'provider',
    }))

    expect(turn()?.status).toBe('error')
  })
})

describe('(г) ошибка после серии stream.retry', () => {
  it('снимает streamRetry и subagentRetry и закрывает ход', () => {
    startTurn()
    dispatch(event('stream.retry', { stream_id: 'st-1', attempt: 1, max_retries: 3, retry_in: 1000 }))
    dispatch(event('stream.retry', { stream_id: 'st-1', attempt: 2, max_retries: 3, retry_in: 2000 }))
    dispatch(event('subagent.retry', {
      parent_call_id: 'call-1', attempt: 2, max_retries: 3,
    }))
    expect(useChatStore.getState().retryBySession[SESSION]).toBeTruthy()
    expect(useChatStore.getState().subagentRetryBySession[SESSION]).toBeTruthy()

    dispatch(event('stream.error', {
      stream_id: 'st-1', error: 'исчерпаны попытки', error_type: 'provider',
    }))

    expect(turn()?.status).toBe('error')
    expect(useChatStore.getState().retryBySession[SESSION]).toBeNull()
    expect(useChatStore.getState().subagentRetryBySession[SESSION]).toBeNull()
  })
})

describe('учёт живости сессии (lastEventAtBySession)', () => {
  it('любое событие сессии обновляет метку и сбрасывает тишину', () => {
    startTurn()
    vi.setSystemTime(T0 + 60_000)
    dispatch(event('part.delta', {
      turnId: 't-1', messageId: 'a-1', partId: 'msg:text:0', field: 'text', delta: 'x',
    }))

    expect(lastEventAtBySession.get(SESSION)).toBe(T0 + 60_000)
    expect(sessionSilenceMs(SESSION)).toBe(0)
  })

  it('метка старта хода — часть записи хода (нужна тишине и грации)', () => {
    startTurn()
    expect(turn()?.startedAt).toBe(T0)
  })
})

describe('closeHungTurn', () => {
  it('идемпотентен: закрытого хода не трогает', () => {
    startTurn()
    dispatch(event('turn.finished', { turnId: 't-1', status: 'completed' }))

    expect(closeHungTurn(SESSION, 'stopped', 'повторный вызов')).toBe(false)
    expect(turn()?.status).toBe('completed')
  })

  it('закрывает оставшиеся live-сегменты закрытого хода', () => {
    startTurn()
    useChatStore.getState().upsertMessage(SESSION, {
      index: 0,
      id: 'a-live',
      role: 'assistant',
      content: '',
      status: 'streaming',
      turn_id: 't-1',
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: new Date(T0).toISOString(),
    })

    expect(closeHungTurn(SESSION, 'stopped', 'тест')).toBe(true)

    const live = useChatStore.getState().messagesBySession[SESSION]?.find((m) => m.id === 'a-live')
    expect(live?.status).toBe('cancelled')
  })
})
