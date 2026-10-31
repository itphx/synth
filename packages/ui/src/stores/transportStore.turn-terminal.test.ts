/**
 * ADR-118 §5: терминальные события хода (`stream.error`/`stream.cancelled`)
 * закрывают ход.
 *
 * Без этого `turnBySession.status` оставался `streaming`: композер навсегда в
 * режиме «в очередь + Стоп», а следующие сообщения не стартули напрямую.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

function startTurn(sessionId = 's1', streamId = 'st-1'): void {
  dispatch(makeEvent('stream.start', sessionId, { stream_id: streamId, turnId: 't1', agent_role: 'leader' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('терминальные события закрывают ход', () => {
  it('stream.error закрывает активный ход', () => {
    startTurn()
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st-1', error: 'boom', error_type: 'provider',
    }))

    expect(useChatStore.getState().turnBySession['s1']?.status).toBe('error')
  })

  it('stream.cancelled закрывает активный ход', () => {
    startTurn()
    dispatch(makeEvent('stream.cancelled', 's1', { stream_id: 'st-1' }))

    expect(useChatStore.getState().turnBySession['s1']?.status).toBe('cancelled')
  })

  it('событие без stream_id закрывает текущий ход', () => {
    startTurn()
    dispatch(makeEvent('stream.cancelled', 's1', {}))

    expect(useChatStore.getState().turnBySession['s1']?.status).toBe('cancelled')
  })

  it('опоздавшее событие чужого хода не закрывает текущий', () => {
    startTurn('s1', 'st-1')
    dispatch(makeEvent('stream.cancelled', 's1', { stream_id: 'st-old' }))

    expect(useChatStore.getState().turnBySession['s1']?.status).toBe('streaming')
  })

  it('recoverable-ошибка (can_retry) ход не закрывает — ретрай будет', () => {
    startTurn()
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st-1', error: 'временная', can_retry: true,
    }))

    expect(useChatStore.getState().turnBySession['s1']?.status).toBe('streaming')
  })
})
