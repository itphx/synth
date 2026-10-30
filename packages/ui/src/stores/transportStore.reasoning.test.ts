/**
 * ADR-118 §1/§4: рассуждения и повторы.
 *
 * Текст шага — только дельтами (`part.delta`) с детерминированными id частей:
 * `msg:text:<ordinal>` / `msg:reasoning:<ordinal>`. Прежний `stream.chunk`
 * (кумулятивный reasoning в одном кадре) удалён из контракта, поэтому блоки
 * рассуждений не «склеиваются» постфактум — их адресует `partId`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

function part(partId: string) {
  return useChatStore.getState().partsBySession['s1']!['m1']![partId]!
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore dispatcher: рассуждения частями (ADR-118 §1/§4)', () => {
  it('дельты reasoning копятся в одной части `msg:reasoning:<ordinal>`', () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:reasoning:0', field: 'text', delta: 'Дума' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:reasoning:0', field: 'text', delta: 'ю' }))

    expect(part('msg:reasoning:0').text).toBe('Думаю')
  })

  it('новая итерация — новая часть, текст и рассуждения не смешиваются', () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:reasoning:0', field: 'text', delta: 'Думаю' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'Ответ' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:reasoning:1', field: 'text', delta: 'Ещё' }))

    const parts = useChatStore.getState().partsBySession['s1']!['m1']!
    expect(Object.keys(parts).sort()).toEqual(['msg:reasoning:0', 'msg:reasoning:1', 'msg:text:0'])
    expect(parts['msg:reasoning:1']!.text).toBe('Ещё')
    expect(parts['msg:text:0']!.text).toBe('Ответ')
  })

  it('пустая дельта не создаёт часть (модель прислала пустой чанк)', () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: '' }))
    expect(useChatStore.getState().partsBySession['s1']?.['m1']?.['msg:text:0']).toBeUndefined()
  })

  it('part.delta снимает надпись о повторе (стрим реально пошёл)', () => {
    dispatch(makeEvent('turn.started', 's1', { turnId: 't1', messageId: 'm-user' }))
    dispatch(makeEvent('stream.retry', 's1', { stream_id: 't1', attempt: 2, retry_in: 1000, max_retries: 3 }))
    expect(useChatStore.getState().retryBySession['s1']).toMatchObject({ streamId: 't1', attempt: 2 })

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'дальше' }))

    expect(useChatStore.getState().retryBySession['s1']).toBeNull()
  })

  it('turn.started снимает ретрай и плашку финальной ошибки прошлого хода', () => {
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'old', error: 'boom', error_type: 'server_error', can_retry: false,
    }))
    expect(useChatStore.getState().finalErrorBySession['s1']).not.toBeNull()

    dispatch(makeEvent('turn.started', 's1', { turnId: 't2', messageId: 'm-user' }))
    expect(useChatStore.getState().finalErrorBySession['s1']).toBeNull()
    expect(useChatStore.getState().retryBySession['s1']).toBeNull()
  })
})
