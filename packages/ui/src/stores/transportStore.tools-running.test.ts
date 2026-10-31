/**
 * ADR-118 §3: инструменты шага (`step.tools.started` / `step.tools.finished`).
 *
 * Между финалом шага и результатом инструмента живого сегмента в ленте нет —
 * флаг хода `toolsRunning` даёт строке активности честный текст
 * («Выполняется инструмент…»). Сбрасывается на финише инструментов и на любом
 * терминальном событии хода.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getSessionMessage: vi.fn().mockResolvedValue({ message: null }),
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

function startTurn(sessionId = 's1', turnId = 't1'): void {
  dispatch(makeEvent('turn.started', sessionId, { turnId }))
}

function turn(sessionId = 's1') {
  return useChatStore.getState().turnBySession[sessionId]
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('step.tools.* — флаг «выполняется инструмент»', () => {
  it('step.tools.started в активном ходе → toolsRunning, messageId и stepIndex шага', () => {
    startTurn()
    dispatch(makeEvent('step.tools.started', 's1', {
      turnId: 't1',
      stepIndex: 1,
      messageId: 'm-step-1',
      callIds: ['call-1'],
    }))

    const active = turn()
    expect(active?.toolsRunning).toBe(true)
    expect(active?.messageId).toBe('m-step-1')
    expect(active?.stepIndex).toBe(1)
  })

  it('step.tools.started без turnId — применяется к активному ходу', () => {
    startTurn()
    dispatch(makeEvent('step.tools.started', 's1', { messageId: 'm-step-1', callIds: [] }))

    expect(turn()?.toolsRunning).toBe(true)
  })

  it('step.tools.started опоздавшего (чужого) хода индикатор не переключает', () => {
    startTurn('s1', 't1')
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't-old', messageId: 'm-old' }))

    expect(turn()?.toolsRunning).toBeFalsy()
    expect(turn()?.messageId).toBeUndefined()
  })

  it('step.tools.started без активного хода — no-op (фантомного хода нет)', () => {
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't1', messageId: 'm1' }))

    expect(turn()).toBeUndefined()
  })

  it('step.tools.finished снимает флаг', () => {
    startTurn()
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.tools.finished', 's1', { turnId: 't1', messageId: 'm1', callIds: ['call-1'] }))

    expect(turn()?.toolsRunning).toBe(false)
  })

  it('turn.finished сбрасывает toolsRunning', () => {
    startTurn()
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't1' }))
    dispatch(makeEvent('turn.finished', 's1', { turnId: 't1', status: 'completed' }))

    expect(turn()?.toolsRunning).toBe(false)
  })

  it('stream.error (финальная) сбрасывает toolsRunning', () => {
    startTurn()
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st-1', turnId: 't1' }))
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't1' }))
    dispatch(makeEvent('stream.error', 's1', { stream_id: 'st-1', error: 'boom', error_type: 'provider' }))

    expect(turn()?.toolsRunning).toBe(false)
  })

  it('stream.cancelled сбрасывает toolsRunning', () => {
    startTurn()
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st-1', turnId: 't1' }))
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't1' }))
    dispatch(makeEvent('stream.cancelled', 's1', { stream_id: 'st-1' }))

    expect(turn()?.toolsRunning).toBe(false)
  })

  it('recoverable-ошибка флаг не сбрасывает — ход продолжается', () => {
    startTurn()
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st-1', turnId: 't1' }))
    dispatch(makeEvent('step.tools.started', 's1', { turnId: 't1' }))
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st-1', error: 'временная', can_retry: true,
    }))

    expect(turn()?.toolsRunning).toBe(true)
  })
})
