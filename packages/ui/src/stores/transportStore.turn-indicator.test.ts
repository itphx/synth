/**
 * ADR-118 §5: индикатор «идёт» живёт **у реплики пользователя**, пока ход не
 * дал контента; после первой части ответа — в живом сегменте ответа.
 *
 * Регрессии, которые закрывает набор:
 * - `turn.started` не должен создавать «живое сообщение» (в payload — id
 *   **реплики пользователя**) и не должен стирать `streamId` хода: по нему
 *   сопоставляется `stream.retry` (статус автоповтора).
 * - первая часть ответа помечает ход как начавшийся (`contentStarted`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function event(type: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: 's1', data }
}

function turn() {
  return useChatStore.getState().turnBySession['s1']
}

function assistantMessages() {
  return (useChatStore.getState().messagesBySession['s1'] ?? []).filter((m) => m.role === 'assistant')
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore: начало хода не ломает границы хода (ADR-118 §5)', () => {
  it('turn.started не создаёт живое сообщение и не стирает streamId хода', () => {
    dispatch(event('stream.start', {
      stream_id: 'stream-1',
      agent_role: 'leader',
      provider: 'itphx',
      model: 'gpt-x',
    }))
    dispatch(event('turn.started', { turnId: 'turn-1', messageId: 'u-1' }))

    expect(turn()).toMatchObject({
      turnId: 'turn-1',
      streamId: 'stream-1',
      agentRole: 'leader',
      provider: 'itphx',
      model: 'gpt-x',
      status: 'streaming',
      contentStarted: false,
    })
    // `messageId` из `turn.started` — id реплики пользователя, а не живого
    // сообщения шага (оно приходит в `step.started`).
    expect(turn()?.messageId).toBeUndefined()
    // Живого сообщения на этом этапе нет вовсе.
    expect(assistantMessages()).toHaveLength(0)
  })

  it('stream.retry сопоставляется с ходом по сохранённому streamId', () => {
    dispatch(event('stream.start', { stream_id: 'stream-1' }))
    dispatch(event('turn.started', { turnId: 'turn-1', messageId: 'u-1' }))
    dispatch(event('stream.retry', {
      stream_id: 'stream-1',
      attempt: 1,
      max_retries: 3,
      retry_in: 5000,
    }))

    expect(useChatStore.getState().retryBySession['s1']).toMatchObject({
      streamId: 'stream-1',
      attempt: 1,
      maxRetries: 3,
    })
    // Ровно этот `streamId` и нужен UI, чтобы показать «повтор» у реплики.
    expect(turn()?.streamId).toBe('stream-1')
  })

  it('turn.started без открытого хода — создаёт ход без контента', () => {
    dispatch(event('turn.started', { turnId: 'turn-9', messageId: 'u-9' }))

    expect(turn()).toMatchObject({
      turnId: 'turn-9',
      status: 'streaming',
      contentStarted: false,
    })
    expect(turn()?.messageId).toBeUndefined()
  })

  it('первая часть ответа помечает ход как начавшийся', () => {
    dispatch(event('stream.start', { stream_id: 'stream-1' }))
    dispatch(event('turn.started', { turnId: 'turn-1' }))
    dispatch(event('step.started', { turnId: 'turn-1', messageId: 'a-1', stepIndex: 0 }))
    expect(turn()?.contentStarted).toBe(false)

    dispatch(event('part.delta', {
      turnId: 'turn-1',
      messageId: 'a-1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Привет',
    }))

    expect(turn()?.contentStarted).toBe(true)
  })

  it('part.updated тоже помечает ход как начавшийся', () => {
    dispatch(event('stream.start', { stream_id: 'stream-1' }))
    dispatch(event('turn.started', { turnId: 'turn-1' }))
    dispatch(event('step.started', { turnId: 'turn-1', messageId: 'a-1', stepIndex: 0 }))

    dispatch(event('part.updated', {
      turnId: 'turn-1',
      messageId: 'a-1',
      partId: 'msg:text:0',
      part: { id: 'msg:text:0', type: 'text', data: 'Привет' },
    }))

    expect(turn()?.contentStarted).toBe(true)
  })
})
