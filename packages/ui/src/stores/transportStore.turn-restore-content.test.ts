/**
 * ADR-118 §5: восстановление живого хода после перезагрузки.
 *
 * Флаг `contentStarted` живого хода в сторе не сохраняется — он считается по
 * истории. `stream_id` из `current_stream` нужен, чтобы после перезагрузки
 * сопоставлялся статус автоповтора (`stream.retry`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { restoreLiveTurnFromHistory, restoreLiveTurnFromSession } from './transportStore'
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

describe('восстановление хода: контент хода и stream_id', () => {
  it('restoreLiveTurnFromSession: stream_id из current_stream и контент по истории', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming',
        content: 'Запускаю команду.',
        parts: [{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }],
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: { turn_id: 'turn-1', stream_id: 'stream-1', agent_role: 'leader' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      streamId: 'stream-1',
      agentRole: 'leader',
      status: 'streaming',
      // Контент хода уже был — индикатор «идёт» не у реплики.
      contentStarted: true,
    })
  })

  it('restoreLiveTurnFromSession: пустой шаг — контента хода ещё нет', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming',
        content: '', parts: [],
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: { turn_id: 'turn-1', stream_id: 'stream-1' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      streamId: 'stream-1',
      contentStarted: false,
    })
  })

  it('restoreLiveTurnFromHistory: контент хода считается по истории', () => {
    restoreLiveTurnFromHistory(SESSION, [
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming',
        content: 'Ответ',
      }),
    ])

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      contentStarted: true,
    })
  })

  it('restoreLiveTurnFromHistory: пустое живое сообщение — контента нет', () => {
    restoreLiveTurnFromHistory(SESSION, [
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming',
        content: '', parts: [],
      }),
    ])

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      contentStarted: false,
    })
  })
})
