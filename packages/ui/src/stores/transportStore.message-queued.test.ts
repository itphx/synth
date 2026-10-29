/**
 * D3: live-событие `message.queued` несёт `message_id` — UI кладёт его в
 * `QueuedMessage.id` и дальше адресует строку очереди по id (не по индексу).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore: message.queued → id строки очереди', () => {
  it('кладёт id из message_id', () => {
    dispatch(makeEvent('message.queued', 's1', {
      message: 'привет',
      message_id: 'msg-1',
      agent_role: 'fixer',
      pending_count: 1,
    }))

    const pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'msg-1', content: 'привет', agentRole: 'fixer' })
  })

  it('без message_id id не подставляется (обработчики не уйдут по индексу)', () => {
    dispatch(makeEvent('message.queued', 's1', {
      message: 'без id',
      pending_count: 1,
    }))

    const pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBeUndefined()
  })
})
