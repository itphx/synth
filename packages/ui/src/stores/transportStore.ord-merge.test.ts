/**
 * ADR-118 §2/§4: `ord` — монотонный порядок записи в истории; мерж истории
 * (`message.delivered` → `GET /sessions/:id/messages`) не должен терять его у
 * уже известного сообщения.
 *
 * Репорт: уведомление о завершении фонового процесса (`ord=138`) в ленте
 * оказалось **ниже** ответа агента (`ord=139`), хотя в БД порядок верный.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  interface Callbacks {
    onEvent?: (event: unknown) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onTransportSwitch?: (transport: string) => void
    onBackendReady?: () => void
  }

  class MockClient {
    kind: 'ws' | 'sse' | 'disconnected' = 'disconnected'
    callbacks: Callbacks
    connect = vi.fn(() => {
      this.kind = 'ws'
    })
    disconnect = vi.fn(() => {
      this.callbacks.onDisconnect?.('manual')
    })
    getTransport = vi.fn(() => this.kind)
    cancel = vi.fn()
    sendPermissionReply = vi.fn()
    sendPermissionHold = vi.fn()
    isBackendReady = vi.fn(() => true)

    constructor(callbacks: Callbacks) {
      this.callbacks = callbacks
    }
  }

  const api = {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
    getInstanceCapabilities: vi.fn().mockResolvedValue({
      messageModel: 2, eventSeq: true, replay: true, version: '0.13.0',
    }),
  }
  return { MockClient, api }
})

vi.mock('@/lib/api/transport', () => ({ TransportClient: mocks.MockClient }))
vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks.api }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { useTransportStore, createDispatcher, mergeHistory } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Серверное сообщение истории (DTO `GET /sessions/:id/messages`). */
function historyMessage(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'user',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T10:00:00Z',
    ...partial,
  }
}

beforeEach(() => {
  useTransportStore.getState().disconnect()
  vi.clearAllMocks()
  mocks.api.getSession.mockResolvedValue({ id: 's1', messages: [] })
  resetChatStore()
})

describe('transportStore: мерж истории не теряет ord (ADR-118 §2)', () => {
  it('известному сообщению дописывается ord из истории', async () => {
    // Живой ответ агента: в сторе есть, но без `ord` (ещё не материализован).
    useChatStore.getState().upsertMessage('s1', {
      index: 138,
      id: 'answer',
      role: 'assistant',
      content: 'ответ',
      ord: null,
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T10:00:05Z',
    })

    mocks.api.getSessionMessages.mockResolvedValue({
      session_id: 's1',
      messages: [
        historyMessage({
          index: 137,
          id: 'notice',
          ord: 138,
          role: 'user',
          content: 'фоновый процесс завершён',
          metadata: { type: 'background_run_result' },
          created_at: '2026-10-30T10:00:00Z',
        }),
        historyMessage({
          index: 138,
          id: 'answer',
          ord: 139,
          role: 'assistant',
          content: 'ответ',
          created_at: '2026-10-30T10:00:05Z',
        }),
      ],
    })

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'notice', ord: 138, role: 'user' }))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession['s1']).toHaveLength(2)
    })

    const msgs = useChatStore.getState().messagesBySession['s1']!
    // `ord` известного сообщения не потерян (было `null` → стало 139).
    expect(msgs.find((m) => m.id === 'answer')!.ord).toBe(139)
    // Порядок — по `ord`: уведомление (138) выше ответа агента (139).
    expect(msgs.map((m) => m.id)).toEqual(['notice', 'answer'])
  })

  it('уведомление о фоновом процессе не уезжает под живой ответ агента', async () => {
    // Живой ответ агента: `ord` ещё нет, `index` — как в серверном массиве.
    useChatStore.getState().upsertMessage('s1', {
      index: 138,
      id: 'answer',
      role: 'assistant',
      content: 'ответ',
      ord: null,
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T10:00:05Z',
    })

    // Уведомление материализовано на сервере раньше ответа агента (ord=138).
    mocks.api.getSessionMessages.mockResolvedValue({
      session_id: 's1',
      messages: [
        historyMessage({
          index: 138,
          id: 'notice',
          ord: 138,
          role: 'user',
          content: 'фоновый процесс завершён',
          metadata: { type: 'background_run_result' },
          created_at: '2026-10-30T10:00:00Z',
        }),
      ],
    })

    dispatch(makeEvent('message.delivered', 's1', { messageId: 'notice', ord: 138, role: 'user' }))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession['s1']).toHaveLength(2)
    })

    const msgs = useChatStore.getState().messagesBySession['s1']!
    expect(msgs.map((m) => m.id)).toEqual(['notice', 'answer'])
    expect(msgs.find((m) => m.id === 'notice')!.ord).toBe(138)
  })

  it('мерж истории не снимает живой статус и не обнуляет turn_id (ADR-118 §5)', async () => {
    // Живой ответ агента: `status: 'streaming'`, `turn_id`/`step_index` — ход.
    useChatStore.getState().upsertMessage('s1', {
      index: 138,
      id: 'answer',
      role: 'assistant',
      content: '',
      status: 'streaming',
      turn_id: 't7',
      step_index: 1,
      ord: null,
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T10:00:05Z',
    })

    // Серверная запись того же сообщения: статуса/хода ещё нет (`null`).
    mocks.api.getSessionMessages.mockResolvedValue({
      session_id: 's1',
      messages: [
        historyMessage({
          index: 138,
          id: 'answer',
          ord: null,
          role: 'assistant',
          content: '',
          status: null,
          turn_id: null,
          step_index: null,
        }),
      ],
    })

    await mergeHistory('s1')

    const answer = useChatStore.getState().messagesBySession['s1']![0]!
    // Индикатор живого хода не снят, границы хода на месте.
    expect(answer.status).toBe('streaming')
    expect(answer.turn_id).toBe('t7')
    expect(answer.step_index).toBe(1)
  })
})
