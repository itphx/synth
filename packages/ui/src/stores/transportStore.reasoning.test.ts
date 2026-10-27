import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
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

describe('transportStore dispatcher: reasoning и stream.retry', () => {
  it('stream.retry сбрасывает content/reasoning/toolCalls: после повтора один блок и только новый текст', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1' }))
    dispatch(makeEvent('stream.chunk', 's1', { stream_id: 'st1', content: 'частичный ', reasoning: 'Дума' }))
    dispatch(makeEvent('stream.chunk', 's1', { stream_id: 'st1', content: '', reasoning: 'Думаю' }))
    dispatch(makeEvent('tool_call.started', 's1', {
      stream_id: 'st1',
      call_id: 'call-1',
      name: 'read_file',
      arguments: { path: 'a.ts' },
      iteration: 0,
    }))

    let st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.content).toBe('частичный ')
    expect(st.reasoningBlocks).toHaveLength(1)
    expect(st.toolCalls).toHaveLength(1)

    // Неудачная попытка: бэкенд объявляет повтор.
    dispatch(makeEvent('stream.retry', 's1', {
      stream_id: 'st1',
      attempt: 2,
      retry_in: 1000,
      max_retries: 3,
    }))

    st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.content).toBe('')
    expect(st.reasoningBlocks).toEqual([])
    expect(st.intermediateTextBlocks).toEqual([])
    expect(st.toolCalls).toEqual([])
    expect(st.hasContent).toBe(false)
    expect(st.isStreaming).toBe(true)
    expect(useChatStore.getState().retryBySession['s1']).toMatchObject({ streamId: 'st1', attempt: 2 })

    // Новая попытка присылает свой (кумулятивный) reasoning и текст.
    dispatch(makeEvent('stream.chunk', 's1', { stream_id: 'st1', content: 'новый ', reasoning: 'Думаю заново' }))
    dispatch(makeEvent('stream.chunk', 's1', { stream_id: 'st1', content: '', reasoning: 'Думаю заново и дальше' }))

    st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.content).toBe('новый ')
    expect(st.reasoningBlocks).toHaveLength(1)
    expect(st.reasoningBlocks[0]).toEqual({ text: 'Думаю заново и дальше', iteration: 0 })
    expect(st.toolCalls).toEqual([])
    // Надпись о повторе снимается первым же чанком.
    expect(useChatStore.getState().retryBySession['s1']).toBeNull()
  })

  it('регресс: набор кумулятивных чанков reasoning даёт один блок (как в финале)', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1' }))
    for (const [index, reasoning] of ['Дума', 'Думаю', 'Думаю дальше'].entries()) {
      dispatch(makeEvent('stream.chunk', 's1', { stream_id: 'st1', content: '', reasoning, iteration: index }))
    }

    const st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.reasoningBlocks).toHaveLength(1)
    expect(st.reasoningBlocks[0]!.text).toBe('Думаю дальше')
  })
})
