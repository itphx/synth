/**
 * ADR-118 §4/§7: событие `message.deleted` (из `DELETE /messages/...` и batch
 * `action: 'delete'`) убирает сообщение из ленты другого клиента вместе с его
 * live-частями.
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
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

const SID = 's1'

function message(id: string, index: number): MessageData {
  return {
    index,
    id,
    role: 'user',
    content: id,
    ord: index + 1,
    turn_id: 't1',
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2024-01-01T00:00:00.000Z',
  }
}

function event(data: Record<string, unknown>): WSEvent {
  return { type: 'message.deleted', session_id: SID, data }
}

beforeEach(() => {
  resetChatStore()
  useChatStore.getState().setMessages(SID, [message('m-1', 0), message('m-2', 1)])
  useChatStore.getState().upsertPart(SID, 'm-1', 'msg:text:0', {
    id: 'msg:text:0',
    type: 'text',
    text: 'удаляемый ответ',
  })
  useChatStore.getState().upsertPart(SID, 'm-2', 'msg:text:0', {
    id: 'msg:text:0',
    type: 'text',
    text: 'остаётся',
  })
})

describe('transportStore dispatcher: message.deleted', () => {
  it('убирает сообщение из ленты и его live-части', () => {
    dispatch(event({ message_id: 'm-1' }))

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages.map((m) => m.id)).toEqual(['m-2'])
    expect(useChatStore.getState().partsBySession[SID]?.['m-1']).toBeUndefined()
    // Части другого сообщения не тронуты.
    expect(useChatStore.getState().partsBySession[SID]?.['m-2']?.['msg:text:0']?.text).toBe('остаётся')
  })

  it('неизвестный id — no-op', () => {
    const before = useChatStore.getState().messagesBySession[SID]
    const partsBefore = useChatStore.getState().partsBySession[SID]

    dispatch(event({ message_id: 'm-unknown' }))

    expect(useChatStore.getState().messagesBySession[SID]).toBe(before)
    expect(useChatStore.getState().partsBySession[SID]).toBe(partsBefore)
  })

  it('пустой/отсутствующий message_id ничего не ломает', () => {
    const before = useChatStore.getState().messagesBySession[SID]

    dispatch(event({}))
    dispatch(event({ message_id: '' }))

    expect(useChatStore.getState().messagesBySession[SID]).toBe(before)
    expect(useChatStore.getState().partsBySession[SID]?.['m-1']?.['msg:text:0']?.text).toBe('удаляемый ответ')
  })
})
