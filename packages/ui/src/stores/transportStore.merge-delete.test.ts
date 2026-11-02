/**
 * Регрессия синхронизации между клиентами: снимок истории — источник истины по
 * **составу** ленты. Сообщение, удалённое на сервере, должно исчезнуть после
 * `mergeServerMessages`, а локальные/живые/вклинивающиеся записи — сохраниться.
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

import { mergeServerMessages } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'

const SID = 's1'

function message(overrides: Partial<MessageData> & { index: number; content: string }): MessageData {
  return {
    role: 'assistant',
    ord: null,
    turn_id: null,
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function ids(messages: MessageData[]): string[] {
  return messages.map((m) => m.id ?? `index:${m.index}`)
}

beforeEach(() => {
  resetChatStore()
})

describe('mergeServerMessages: удаление сообщений по снимку сервера', () => {
  it('сообщение с ord, которого нет в снимке, исчезает из ленты', () => {
    const kept = message({ index: 0, id: 'm-keep', content: 'осталось', ord: 1 })
    const deleted = message({ index: 1, id: 'm-deleted', content: 'удалено', ord: 2 })
    useChatStore.getState().setMessages(SID, [kept, deleted])

    mergeServerMessages(SID, [kept])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-keep'])
  })

  it('оптимистичное сообщение (ord == null) сохраняется', () => {
    const optimistic = message({ index: 0, id: 'm-optimistic', content: 'ещё не записано', ord: null })
    useChatStore.getState().setMessages(SID, [optimistic])

    mergeServerMessages(SID, [])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-optimistic'])
  })

  it('вклинивание (steerPending) сохраняется, даже если сервер его ещё не знает', () => {
    const steer = message({
      index: 0,
      id: 'm-steer',
      content: 'вклинивание',
      ord: 3,
      steerPending: true,
    })
    useChatStore.getState().setMessages(SID, [steer])

    mergeServerMessages(SID, [])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-steer'])
  })

  it('живое сообщение (status: streaming) сохраняется', () => {
    const live = message({
      index: 0,
      id: 'm-live',
      content: 'печатается',
      ord: 4,
      status: 'streaming',
    })
    useChatStore.getState().setMessages(SID, [live])

    mergeServerMessages(SID, [])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-live'])
  })

  it('сообщение без id сохраняется (мержить не по чему)', () => {
    const local = message({ index: 0, content: 'локальное', ord: null })
    useChatStore.getState().setMessages(SID, [local])

    mergeServerMessages(SID, [])

    expect(useChatStore.getState().messagesBySession[SID]).toHaveLength(1)
    expect(useChatStore.getState().messagesBySession[SID]?.[0]?.content).toBe('локальное')
  })

  it('известное сообщение обновляется данными сервера, а не теряется', () => {
    const known = message({ index: 0, id: 'm-1', content: 'старый текст', ord: 1 })
    useChatStore.getState().setMessages(SID, [known])

    mergeServerMessages(SID, [
      message({ index: 0, id: 'm-1', content: 'новый текст', ord: 1 }),
    ])

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('новый текст')
  })
})
