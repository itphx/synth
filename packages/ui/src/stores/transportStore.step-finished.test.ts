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

  it('статус шага не меняется до завершения сверки с историей (нет пустого окна RTT)', async () => {
    let resolveFetch: (value: unknown) => void = () => {}
    getSessionMessages.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve }) as never,
    )

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    // Запрос истории ещё в полёте: статус не финальный, live-части на месте.
    const pending = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
    expect(pending.status).toBe('streaming')
    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()

    resolveFetch({ session_id: 's1', messages: [serverMessage()] })
    await vi.waitFor(() => {
      const done = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
      expect(done.status).toBe('completed')
      expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeUndefined()
    })
  })

  it('история вернулась без шага — live-части остаются (текст не пропадает насовсем)', async () => {
    // Сервер сохраняет шаг асинхронно: запрос истории успешен, но записи ещё нет.
    getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })

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
      const message = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
      expect(message.status).toBe('completed')
    })
    // Live-части не сняты: только из них сейчас берётся текст шага.
    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()
  })

  it('пачка step.finished схлопывается в ≤ 2 загрузки истории, данные применяются', async () => {
    let calls = 0
    const resolvers: Array<(value: unknown) => void> = []
    getSessionMessages.mockImplementation(() => {
      calls += 1
      return new Promise((resolve) => { resolvers.push(resolve) }) as never
    })

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    // Tool-loop: финал шага приходит на каждый шаг хода.
    for (let i = 0; i < 5; i += 1) {
      dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: i, messageId: 'm1', status: 'completed' }))
    }

    // Запрос уже идёт — второй не запускается (single-flight).
    expect(calls).toBe(1)

    // Завершение текущего прогона запускает ровно один trailing-прогон.
    await vi.waitFor(() => expect(resolvers.length).toBe(1))
    resolvers[0]!({ session_id: 's1', messages: [] })
    await vi.waitFor(() => expect(calls).toBe(2))
    resolvers[1]!({ session_id: 's1', messages: [serverMessage()] })

    await vi.waitFor(() => {
      const message = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
      expect(message.status).toBe('completed')
      expect(message.parts).toEqual([{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }])
    })
    expect(calls).toBeLessThanOrEqual(2)
  })
})
