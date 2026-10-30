/**
 * ADR-118 §1/§5: индикатор «идёт» (три точки) может быть только у **последнего**
 * (живого) сегмента хода.
 *
 * `ChatMessage` рисует индикатор по `message.status === 'streaming'`. Если
 * `step.finished` предыдущего сегмента не пришёл/не применился, сегмент
 * оставался `streaming` и точки висели в середине склеенного блока хода.
 * Поэтому границы закрываются ещё и по событиям хода: новый `step.started`
 * закрывает предыдущие сегменты того же хода, `turn.finished` — все оставшиеся.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const api = {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  }
  return { api }
})

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks.api }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId = 's1'): WSEvent {
  return { type, session_id: sessionId, data }
}

function streamingIds(sessionId = 's1'): string[] {
  return (useChatStore.getState().messagesBySession[sessionId] ?? [])
    .filter((m) => m.status === 'streaming')
    .map((m) => m.id ?? '')
}

function statusOf(messageId: string, sessionId = 's1'): string | null | undefined {
  return (useChatStore.getState().messagesBySession[sessionId] ?? [])
    .find((m) => m.id === messageId)?.status
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.api.getSession.mockResolvedValue({ id: 's1', messages: [] })
  mocks.api.getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })
  resetChatStore()
})

describe('transportStore: границы сегментов хода (ADR-118 §1/§5)', () => {
  it('новый step.started переводит предыдущий сегмент того же хода в completed', () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))
    expect(statusOf('m1')).toBe('streaming')

    // `step.finished` для m1 «потерян» — закрываем границей шага.
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm2', stepIndex: 1 }))

    expect(statusOf('m1')).toBe('completed')
    expect(statusOf('m2')).toBe('streaming')
    // Индикатор — ровно у одного (последнего) сегмента.
    expect(streamingIds()).toEqual(['m2'])
  })

  it('step.started нового хода закрывает «зависший» сегмент прошлого хода', () => {
    dispatch(makeEvent('turn.started', { turnId: 't0', messageId: 'm0' }))
    dispatch(makeEvent('step.started', { turnId: 't0', messageId: 'm0', stepIndex: 0 }))

    // Ход t0 завершился, но его `turn.finished`/`step.finished` потерялись.
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm2', stepIndex: 0 }))

    expect(statusOf('m0')).toBe('completed')
    expect(streamingIds()).toEqual(['m2'])
  })

  it('поздний turn.finished прошлого хода не гасит живой сегмент нового', () => {
    dispatch(makeEvent('turn.started', { turnId: 't0', messageId: 'm0' }))
    dispatch(makeEvent('step.started', { turnId: 't0', messageId: 'm0', stepIndex: 0 }))
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))

    // Опоздавшее терминальное событие старого хода.
    dispatch(makeEvent('turn.finished', { turnId: 't0', status: 'completed' }))

    expect(statusOf('m1')).toBe('streaming')
  })

  it('turn.finished финализирует все оставшиеся streaming сегменты хода', () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))
    // Второй сегмент появился без своего `step.started` (части пришли раньше) —
    // m1 остался streaming: оба висят.
    dispatch(makeEvent('part.delta', { messageId: 'm2', partId: 'msg:text:0', field: 'text', delta: 'ещё' }))
    expect(streamingIds().sort()).toEqual(['m1', 'm2'])

    dispatch(makeEvent('turn.finished', { turnId: 't1', status: 'completed' }))

    expect(streamingIds()).toEqual([])
    expect(statusOf('m1')).toBe('completed')
    expect(statusOf('m2')).toBe('completed')
  })

  it('turn.finished со статусом cancelled/error кладёт терминальный статус', () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))
    dispatch(makeEvent('turn.finished', { turnId: 't1', status: 'cancelled' }))
    expect(statusOf('m1')).toBe('cancelled')

    dispatch(makeEvent('turn.started', { turnId: 't2', messageId: 'm3' }))
    dispatch(makeEvent('step.started', { turnId: 't2', messageId: 'm3', stepIndex: 0 }))
    dispatch(makeEvent('turn.finished', { turnId: 't2', status: 'error' }))
    expect(statusOf('m3')).toBe('error')
  })

  it('turn.finished без статуса (default) и не трогает сообщения другой сессии', () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))
    dispatch(makeEvent('turn.started', { turnId: 't2', messageId: 'm2' }, 's2'))
    dispatch(makeEvent('step.started', { turnId: 't2', messageId: 'm2', stepIndex: 0 }, 's2'))

    dispatch(makeEvent('turn.finished', { turnId: 't1' }))

    expect(statusOf('m1')).toBe('completed')
    expect(streamingIds('s2')).toEqual(['m2'])
  })
})
