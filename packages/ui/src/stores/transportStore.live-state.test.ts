/**
 * ADR-118 §1/§5: гонки live-состояния ленты.
 *
 * События хода могут прийти **с опозданием** (догон по журналу, реконнект,
 * задержка транспорта). Такое событие прошлого хода не должно:
 * - гасить индикатор текущего хода (`step.started`/`turn.finished`);
 * - создавать фантомное сообщение в ленте (`part.delta`/`part.updated`);
 * - «воскрешать» финальное сообщение (дельта к `completed` — мусор).
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

function messages(sessionId = 's1') {
  return useChatStore.getState().messagesBySession[sessionId] ?? []
}

function statusOf(messageId: string, sessionId = 's1'): string | null | undefined {
  return messages(sessionId).find((m) => m.id === messageId)?.status
}

function streamingIds(sessionId = 's1'): string[] {
  return messages(sessionId).filter((m) => m.status === 'streaming').map((m) => m.id ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.api.getSession.mockResolvedValue({ id: 's1', messages: [] })
  mocks.api.getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })
  resetChatStore()
})

describe('transportStore: опоздавшие события не ломают живое состояние (ADR-118 §1/§5)', () => {
  it('step.started старого хода не закрывает живой сегмент текущего', () => {
    dispatch(makeEvent('turn.started', { turnId: 't0', messageId: 'm-user-0' }))
    dispatch(makeEvent('step.started', { turnId: 't0', messageId: 'm0', stepIndex: 0 }))
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm-user-1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))

    // Опоздавшее событие **старого** хода (догон/реконнект/задержка).
    dispatch(makeEvent('step.started', { turnId: 't0', messageId: 'm0-late', stepIndex: 1 }))

    // Индикатор текущего хода жив.
    expect(statusOf('m1')).toBe('streaming')
    expect(streamingIds()).toEqual(['m1'])
    // Границы хода не переписаны опоздавшим событием.
    expect(useChatStore.getState().turnBySession['s1']!.turnId).toBe('t1')
    // И фантомного сообщения старого хода в ленте нет.
    expect(messages().some((m) => m.id === 'm0-late')).toBe(false)
  })

  it('опоздавшее turn.finished старого хода не закрывает живой сегмент текущего', () => {
    dispatch(makeEvent('turn.started', { turnId: 't0', messageId: 'm-user-0' }))
    dispatch(makeEvent('step.started', { turnId: 't0', messageId: 'm0', stepIndex: 0 }))
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm-user-1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))

    dispatch(makeEvent('turn.finished', { turnId: 't0', status: 'completed' }))

    expect(statusOf('m1')).toBe('streaming')
    expect(streamingIds()).toEqual(['m1'])
  })

  it('опоздавший step.finished старого хода не создаёт фантомное сообщение', () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm-user-1' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))

    // Финал шага **прошлого** хода пришёл, когда идёт текущий.
    dispatch(makeEvent('step.finished', {
      turnId: 't0',
      messageId: 'm0-late',
      status: 'completed',
    }))

    expect(messages().some((m) => m.id === 'm0-late')).toBe(false)
    expect(statusOf('m1')).toBe('streaming')
  })

  it('part.delta при отсутствии активного хода не создаёт сообщение', () => {
    // Активного хода нет — дельта опоздавшая: сообщение не создаётся.
    dispatch(makeEvent('part.delta', {
      messageId: 'm-late',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'опоздавшая дельта',
    }))

    expect(messages().some((m) => m.id === 'm-late')).toBe(false)
    expect(useChatStore.getState().partsBySession['s1']?.['m-late']).toBeUndefined()
  })

  it('part.delta к сообщению со статусом completed игнорируется', async () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm-user' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))
    dispatch(makeEvent('step.finished', { turnId: 't1', messageId: 'm1', status: 'completed' }))

    // Финал шага: живые части сняты (после сверки с историей).
    await vi.waitFor(() => {
      expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeUndefined()
    })
    expect(statusOf('m1')).toBe('completed')

    // Поздняя дельта к финальному сообщению — мусор: игнорируем.
    dispatch(makeEvent('part.delta', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: ' мусор',
    }))

    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeUndefined()
    expect(statusOf('m1')).toBe('completed')
  })

  it('part.updated к сообщению со статусом completed игнорируется', () => {
    dispatch(makeEvent('turn.started', { turnId: 't1', messageId: 'm-user' }))
    dispatch(makeEvent('step.started', { turnId: 't1', messageId: 'm1', stepIndex: 0 }))
    dispatch(makeEvent('step.finished', { turnId: 't1', messageId: 'm1', status: 'completed' }))

    dispatch(makeEvent('part.updated', {
      messageId: 'm1',
      partId: 'msg:text:0',
      part: { id: 'msg:text:0', type: 'text', data: 'мусор' },
    }))

    expect(useChatStore.getState().partsBySession['s1']?.['m1']?.['msg:text:0']).toBeUndefined()
  })
})
