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

import { synthApi } from '@/lib/api/synthApi'
import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const getSessionMessages = vi.mocked(synthApi.getSessionMessages)

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

const TEXT_PART = { id: 'p1', type: 'text' as const, data: 'смотри картинку' }
const IMAGE_PART = {
  id: 'p2',
  type: 'image' as const,
  data: { blobPath: 'attachments/ab/abcdef', sha256: 'abcdef', mime: 'image/jpeg', size: 2048, name: 'Yeti 2.jpg' },
}

beforeEach(() => {
  vi.clearAllMocks()
  getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })
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

  it('message.delivered с вложением → догруженная из истории реплика хранит части', async () => {
    // ADR-118 §4: `message.delivered` — материализация в истории, **без
    // содержания**; части (в т.ч. вложение ADR-115) приходят из истории, чтобы
    // вложение было видно в ленте до перезагрузки страницы.
    getSessionMessages.mockResolvedValue({
      session_id: 's1',
      messages: [{
        index: 1,
        id: 'm1',
        ord: 2,
        role: 'user',
        content: '[image: Yeti 2.jpg] смотри картинку',
        parts: [TEXT_PART, IMAGE_PART],
        author: 'user',
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-10-30T00:00:01Z',
      }],
    })

    dispatch(makeEvent('message.delivered', 's1', {
      messageId: 'm1',
      ord: 2,
      role: 'user',
      author: 'user',
    }))

    await vi.waitFor(() => {
      const messages = useChatStore.getState().messagesBySession['s1'] ?? []
      expect(messages).toHaveLength(1)
    })
    const messages = useChatStore.getState().messagesBySession['s1']!
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.parts).toEqual([TEXT_PART, IMAGE_PART])
    expect((messages[0]!.parts ?? []).some((p) => p.type === 'image')).toBe(true)
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
