/**
 * ADR-115: live-события `message.added` / `message.injected` несут части
 * сообщения — иначе в ленте нет вложения до перезагрузки страницы.
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

const TEXT_PART = { id: 'p1', type: 'text', data: 'смотри картинку' }
const IMAGE_PART = {
  id: 'p2',
  type: 'image',
  data: { blobPath: 'attachments/ab/abcdef', sha256: 'abcdef', mime: 'image/jpeg', size: 2048, name: 'Yeti 2.jpg' },
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore dispatcher: части сообщения (ADR-115)', () => {
  it('message.added с parts → части есть у сообщения стора', () => {
    dispatch(makeEvent('message.added', 's1', {
      message_index: 0,
      role: 'user',
      content: '[image: Yeti 2.jpg] смотри картинку',
      parts: [TEXT_PART, IMAGE_PART],
      author: 'user',
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.parts).toEqual([TEXT_PART, IMAGE_PART])
    expect((messages[0]!.parts ?? []).some((p) => p.type === 'image')).toBe(true)
  })

  it('message.injected с parts → части есть у сообщения стора', () => {
    dispatch(makeEvent('message.injected', 's1', {
      message_index: 1,
      message_id: 'm1',
      content: '[image: Yeti 2.jpg] смотри картинку',
      parts: [TEXT_PART, IMAGE_PART],
      author: 'user',
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.parts).toEqual([TEXT_PART, IMAGE_PART])
  })

  it('без parts поле не выставляется (обратная совместимость)', () => {
    dispatch(makeEvent('message.added', 's1', {
      message_index: 0,
      role: 'user',
      content: 'обычный текст',
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.parts).toBeUndefined()
  })
})
