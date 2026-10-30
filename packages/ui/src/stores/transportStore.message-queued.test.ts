/**
 * ADR-118 §4: live-подтверждение приёма — адресное `message.accepted`
 * (`messageId`/`mode`/`position`, **без текста и автора**), состояние очереди —
 * `queue.state` (только счётчики). UI адресует строку очереди по `id`
 * (`messageId`), а не по индексу.
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

describe('transportStore: message.accepted → id строки очереди (ADR-118 §4)', () => {
  it('строка заводится по messageId; текста в событии нет (утечка снята)', () => {
    // Содержания в адресном подтверждении нет — у неизвестной строки текст
    // пустой и заполнится из истории при доставке.
    dispatch(makeEvent('message.accepted', 's1', {
      messageId: 'msg-1',
      mode: 'queue',
      position: 2,
    }))

    const pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'msg-1', content: '' })
  })

  it('текст и автор берутся из своей оптимистичной строки по тому же id (дедуп)', () => {
    // Оптимистичную строку создаёт `sendMessage` по ответу `202`.
    useChatStore.getState().upsertPendingMessage('s1', {
      id: 'msg-1',
      content: 'привет',
      agentRole: 'fixer',
    })

    dispatch(makeEvent('message.accepted', 's1', {
      messageId: 'msg-1',
      mode: 'queue',
      position: 2,
    }))

    const pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'msg-1', content: 'привет', agentRole: 'fixer' })
  })

  it('без messageId строка не заводится (обработчики не уйдут по индексу)', () => {
    dispatch(makeEvent('message.accepted', 's1', { mode: 'queue', position: 1 }))

    const pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(0)
  })
})

describe('transportStore: queue.state → счётчики очереди (ADR-118 §4)', () => {
  it('кладёт pendingCount/steerCount без текста и автора', () => {
    dispatch(makeEvent('queue.state', 's1', { pendingCount: 2, steerCount: 1 }))

    expect(useChatStore.getState().queueBySession['s1']).toMatchObject({
      pendingCount: 2,
      steerCount: 1,
    })
  })
})
