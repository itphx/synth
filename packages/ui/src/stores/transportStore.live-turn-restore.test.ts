/**
 * ADR-118 §5: восстановление живого хода **по признакам активного хода** из
 * `GET /sessions/:id` (`current_stream`, `status.blocked`).
 *
 * Истории для этого может не хватить: идёт длинный инструмент, шаг с текстом
 * уже `completed`, а следующего assistant-сообщения ещё нет — сообщения со
 * статусом `streaming` в истории нет, `restoreLiveTurnFromHistory` выходит, и
 * без признака из API в UI не было бы ни индикатора, ни «Стоп», ни `ctrl+b`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { restoreLiveTurnFromSession } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'

const SESSION = 's1'

function message(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: 'm1',
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00Z',
    ...partial,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore: живой ход по признакам из GET /sessions/:id (ADR-118 §5)', () => {
  it('current_stream восстанавливает ход, даже если streaming-сообщения в истории нет', () => {
    // История: шаг с текстом уже завершён, следующего сообщения ещё нет.
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'completed',
        content: 'Запускаю команду.',
        parts: [{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }],
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      id: SESSION,
      status: {},
      current_stream: { turn_id: 'turn-1', agent_role: 'leader' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      status: 'streaming',
      agentRole: 'leader',
    })
  })

  it('id хода берётся и из stream_id', () => {
    restoreLiveTurnFromSession(SESSION, {
      current_stream: { stream_id: 'stream-7' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'stream-7',
      status: 'streaming',
    })
  })

  it('status.blocked (ожидание подтверждения) тоже восстанавливает ход — по истории', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-2', step_index: 1, status: 'streaming',
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      status: { blocked: 'permission' },
      current_stream: null,
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-2',
      messageId: 'm-step',
      stepIndex: 1,
      status: 'streaming',
    })
  })

  it('нет ни current_stream, ни blocked — ход не создаётся', () => {
    restoreLiveTurnFromSession(SESSION, { status: {}, current_stream: null })

    expect(useChatStore.getState().turnBySession[SESSION]).toBeUndefined()
  })

  it('уже восстановленный ход не перетирается', () => {
    useChatStore.getState().startTurn(SESSION, {
      turnId: 'turn-live',
      messageId: 'm-live',
      stepIndex: 3,
      status: 'streaming',
    })

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { turn_id: 'turn-stale' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-live',
      messageId: 'm-live',
      stepIndex: 3,
      status: 'streaming',
    })
  })
})
