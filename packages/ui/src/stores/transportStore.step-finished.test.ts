/**
 * ADR-118 §5: финализация шага — «финал» = смена статуса.
 *
 * На финале шага live-части сообщения больше не нужны: источник истины —
 * части/контент из истории (`GET /sessions/:id/messages`). Пока live-части
 * лежали в сторе, `buildPartsView` мержил их с частями DTO по `id`, и в
 * склеенном блоке хода текст шага дублировался.
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
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const getSessionMessages = vi.mocked(synthApi.getSessionMessages)

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Запись сервера: шаг сохранён с частями и контентом. */
function serverMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    index: 1,
    id: 'm1',
    ord: 2,
    turn_id: 't1',
    step_index: 0,
    status: 'completed',
    role: 'assistant',
    content: 'Запускаю команду.',
    parts: [{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }],
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:01Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })
  resetChatStore()
})

describe('transportStore dispatcher: финализация шага (ADR-118 §5)', () => {
  it('step.finished снимает live-части сообщения и подтягивает историю', async () => {
    getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [serverMessage()] })

    // Шаг начался: сообщение создано, live-части накапливаются.
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))

    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()

    // Шаг финализирован.
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    await vi.waitFor(() => {
      expect(getSessionMessages).toHaveBeenCalledWith('s1')
      expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeUndefined()
    })

    // Сообщение в стере — по серверу: части/контент из истории.
    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.status).toBe('completed')
    expect(messages[0]!.parts).toEqual([{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }])
    expect(messages[0]!.content).toBe('Запускаю команду.')
  })

  it('при сетевой ошибке истории live-части сохраняются — текст шага не теряется', async () => {
    getSessionMessages.mockRejectedValue(new Error('network down'))

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    await vi.waitFor(() => {
      expect(getSessionMessages).toHaveBeenCalled()
    })
    // Живые части на месте — текст шага остался виден.
    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()
  })
})
