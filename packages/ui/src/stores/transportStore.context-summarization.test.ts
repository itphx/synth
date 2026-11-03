/**
 * `context.summarization_applied` — ядро применило сжатие истории (обычный путь
 * и overflow `_forceCompressForOverflow`). UI обязан снять плашку ожидания и
 * перечитать **последнюю страницу** истории (мержем, а не авторитетной заменой —
 * догруженные старые страницы не теряются).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [], session_id: 's1' }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { synthApi } from '@/lib/api/synthApi'
import type { WSEvent } from '@/lib/api/transport'
import { MESSAGES_PAGE_LIMIT } from '@/lib/api/messages'
import { createDispatcher } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'

const dispatch = createDispatcher()
const getSession = vi.mocked(synthApi.getSession)
const getSessionMessages = vi.mocked(synthApi.getSessionMessages)

const SID = 's1'

function message(id: string, index: number, overrides: Partial<MessageData> = {}): MessageData {
  return {
    index,
    id,
    role: 'assistant',
    content: id,
    ord: index + 1,
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function event(data: Record<string, unknown> = {}): WSEvent {
  return { type: 'context.summarization_applied', session_id: SID, data }
}

/** Ждём завершения асинхронного перечитывания истории. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  getSession.mockResolvedValue({ id: SID } as never)
  getSessionMessages.mockResolvedValue({ messages: [], session_id: SID })
  useChatStore.getState().setSummarizationPending(SID, true)
})

describe('context.summarization_applied', () => {
  it('снимает плашку, перечитывает последнюю страницу истории и обновляет сессию', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [message('m-new', 5, { ord: 6 })],
      session_id: SID,
      has_more: true,
      next_before: 2,
    })

    expect(useChatStore.getState().summarizationPendingBySession[SID]).toBe(true)

    dispatch(event({
      reason: 'threshold',
      mode: 'summarization',
      covered_indices: [1, 2],
      keep_from: 5,
    }))
    await flush()

    expect(useChatStore.getState().summarizationPendingBySession[SID]).toBe(false)
    expect(getSessionMessages).toHaveBeenCalledTimes(1)
    expect(getSessionMessages).toHaveBeenCalledWith(SID, { limit: MESSAGES_PAGE_LIMIT })
    expect(getSession).toHaveBeenCalledWith(SID)

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages.map((m) => m.id)).toContain('m-new')
  })

  it('страница мержится: догруженные старые сообщения не теряются', async () => {
    // Пользователь уже догрузил старую страницу (ord 1) и поднял курсор.
    useChatStore.setState({
      messagesBySession: { [SID]: [message('m-old', 0, { ord: 1, seq: 1 })] },
      historyPageBySession: {
        [SID]: { hasMore: true, nextBefore: 1 },
      },
    } as never)

    getSessionMessages.mockResolvedValue({
      messages: [message('m-new', 5, { ord: 6, seq: 10 })],
      session_id: SID,
      has_more: true,
      next_before: 2,
    })

    dispatch(event({ mode: 'compaction' }))
    await flush()

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages.map((m) => m.id).sort()).toEqual(['m-new', 'm-old'])
    // Курсор пагинации не «омолаживается» снимком последней страницы.
    expect(useChatStore.getState().historyPageBySession[SID]?.nextBefore).toBe(1)
  })

  it('ошибка перечитывания не оставляет плашку включённой', async () => {
    getSessionMessages.mockRejectedValue(new Error('boom'))

    dispatch(event())
    await flush()

    expect(useChatStore.getState().summarizationPendingBySession[SID]).toBe(false)
  })
})
