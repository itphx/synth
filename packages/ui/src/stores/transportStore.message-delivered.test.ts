/**
 * ADR-118 §4: `message.delivered` для **неизвестного** id — точечная загрузка
 * одного сообщения (`GET /sessions/:id/messages/:messageId`), а не полной
 * истории. Ошибка/404 → прежний фоллбек на `mergeHistory` (дедуп по id/ord).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [], session_id: 's1' }),
    getSessionMessage: vi.fn().mockResolvedValue({ message: null }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { synthApi } from '@/lib/api/synthApi'
import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const getSessionMessage = vi.mocked(synthApi.getSessionMessage)
const getSessionMessages = vi.mocked(synthApi.getSessionMessages)

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Ждём завершения асинхронной догрузки сообщения. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  getSessionMessage.mockResolvedValue({ message: null as never })
  getSessionMessages.mockResolvedValue({ messages: [], session_id: 's1' })
})

describe('message.delivered — точечная загрузка сообщения', () => {
  it('неизвестный id → ровно один GET сообщения, полная история не запрашивается', async () => {
    getSessionMessage.mockResolvedValue({
      message: {
        index: 1,
        id: 'm1',
        ord: 7,
        role: 'user',
        content: 'привет',
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-10-30T00:00:01Z',
      },
      session_id: 's1',
    })

    dispatch(makeEvent('message.delivered', 's1', {
      messageId: 'm1',
      ord: 7,
      role: 'user',
      author: 'локальный',
    }))
    await flush()

    expect(getSessionMessage).toHaveBeenCalledTimes(1)
    expect(getSessionMessage).toHaveBeenCalledWith('s1', 'm1')
    expect(getSessionMessages).not.toHaveBeenCalled()

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'm1', ord: 7, role: 'user', content: 'привет' })
    // Роль/автор из события тоже применены.
    expect(messages[0]!.author).toBe('локальный')
  })

  it('плоский ответ (старое ядро) — сообщение всё равно попадает в стор', async () => {
    getSessionMessage.mockResolvedValue({
      index: 0,
      id: 'm2',
      role: 'assistant',
      content: 'ответ',
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T00:00:02Z',
    } as never)

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm2', ord: 2 }))
    await flush()

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'm2', content: 'ответ', ord: 2 })
  })

  it('ошибка точечной загрузки → фоллбек на полную историю (дедуп по id)', async () => {
    getSessionMessage.mockRejectedValue(Object.assign(new Error('HTTP 404'), { status: 404 }))
    getSessionMessages.mockResolvedValue({
      session_id: 's1',
      messages: [{
        index: 3,
        id: 'm3',
        ord: 5,
        role: 'user',
        content: 'из истории',
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-10-30T00:00:03Z',
      }],
    })

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm3', ord: 5 }))
    await flush()

    expect(getSessionMessage).toHaveBeenCalledTimes(1)
    expect(getSessionMessages).toHaveBeenCalledTimes(1)

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages.filter((m) => m.id === 'm3')).toHaveLength(1)
    expect(messages[0]!.content).toBe('из истории')
  })

  it('ответ без сообщения → фоллбек на историю', async () => {
    getSessionMessage.mockResolvedValue({ message: null as never })

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm4' }))
    await flush()

    expect(getSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('известное сообщение — точечная загрузка не нужна (только ord/роль/автор)', async () => {
    const store = useChatStore.getState()
    store.upsertMessage('s1', {
      index: 0,
      id: 'm5',
      role: 'user',
      content: 'уже в ленте',
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T00:00:04Z',
    })

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm5', ord: 9, role: 'user', author: 'я' }))
    await flush()

    expect(getSessionMessage).not.toHaveBeenCalled()
    expect(getSessionMessages).not.toHaveBeenCalled()
    const msg = (useChatStore.getState().messagesBySession['s1'] ?? []).find((m) => m.id === 'm5')
    expect(msg).toMatchObject({ ord: 9, author: 'я', content: 'уже в ленте' })
  })

  it('два события по разным id — по одному точечному запросу на каждое', async () => {
    getSessionMessage.mockImplementation(async (_sid: string, messageId: string) => ({
      message: {
        index: 0,
        id: messageId,
        ord: 1,
        role: 'user',
        content: messageId,
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-10-30T00:00:05Z',
      },
    }))

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm6', ord: 1 }))
    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm7', ord: 2 }))
    await flush()

    expect(getSessionMessage).toHaveBeenCalledTimes(2)
    expect(getSessionMessages).not.toHaveBeenCalled()
    const ids = (useChatStore.getState().messagesBySession['s1'] ?? []).map((m) => m.id)
    expect(ids).toEqual(['m6', 'm7'])
  })
})
