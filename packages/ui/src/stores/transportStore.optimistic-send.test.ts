/**
 * ADR-118 §3: приём сообщения — `POST /sessions/:id/prompt` → `202
 * {messageId, mode, position}`.
 *
 * Ни SSE-ожидания, ни ack-кадра `queued`, ни таймаута «Send timeout» больше нет:
 * реплика показывается оптимистично по `messageId` из ответа, а статус
 * доставки (`accepted`/`queued`/`steering`) и очередь уточняются адресным
 * событием `message.accepted` и `queue.state`.
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
    connect = vi.fn((mode: 'ws' | 'sse') => {
      this.kind = mode
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
      instances.push(this)
    }
  }

  const instances: MockClient[] = []
  /** HTTP-слой: приём сообщения и сверка очереди с сервером. */
  const api = {
    enqueueMessage: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getInstanceCapabilities: vi.fn().mockResolvedValue({
      messageModel: 2, eventSeq: true, replay: true, version: '0.13.0',
    }),
  }
  return { instances, MockClient, api }
})

vi.mock('@/lib/api/transport', () => ({ TransportClient: mocks.MockClient }))
vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks.api }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { useTransportStore, createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Ход идёт: обычная отправка встанет в очередь. */
function startTurn(sessionId = 's1'): void {
  dispatch(makeEvent('turn.started', sessionId, { turnId: 't1', messageId: 'm-user' }))
}

beforeEach(() => {
  useTransportStore.getState().disconnect()
  mocks.instances.length = 0
  vi.clearAllMocks()
  mocks.api.getSession.mockResolvedValue({ id: 's1', messages: [] })
  resetChatStore()
})

describe('transportStore.sendMessage: контракт 202 (ADR-118 §3)', () => {
  it('вне хода → реплика сразу в ленте по messageId ответа, статус «принято»', async () => {
    mocks.api.enqueueMessage.mockResolvedValue({ messageId: 'm-new', mode: 'queue', position: null })

    const accepted = await useTransportStore.getState().sendMessage('s1', 'привет')

    expect(accepted).toEqual({ messageId: 'm-new', mode: 'queue', position: null })
    expect(mocks.api.enqueueMessage).toHaveBeenCalledTimes(1)
    // Никакого ожидания SSE/ack: единственный вызов — HTTP-приём.
    expect(mocks.instances).toHaveLength(0)

    const msgs = useChatStore.getState().messagesBySession['s1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      id: 'm-new',
      role: 'user',
      content: 'привет',
      delivery: 'accepted',
    })
    expect(useChatStore.getState().pendingBySession['s1']).toBeUndefined()
  })

  it('во время хода с позицией > 1 → «в очереди» и строка очереди', async () => {
    startTurn()
    mocks.api.enqueueMessage.mockResolvedValue({ messageId: 'm-new', mode: 'queue', position: 2 })

    await useTransportStore.getState().sendMessage('s1', 'следующее')

    expect(useChatStore.getState().messagesBySession['s1']!.at(-1)).toMatchObject({
      id: 'm-new',
      delivery: 'queued',
    })
    const pending = useChatStore.getState().pendingBySession['s1']!
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'm-new', content: 'следующее' })
  })

  it('режим steer → маркер вмешательства, строки очереди нет', async () => {
    startTurn()
    mocks.api.enqueueMessage.mockResolvedValue({ messageId: 'm-steer', mode: 'steer', position: null })

    await useTransportStore.getState().sendMessage('s1', 'в ход', undefined, undefined, undefined, 'steer')

    expect(useChatStore.getState().messagesBySession['s1']!.at(-1)).toMatchObject({
      id: 'm-steer',
      delivery: 'steering',
    })
    expect(useChatStore.getState().pendingBySession['s1']).toBeUndefined()
  })

  it('режим queue в тело запроса не уходит (дефолт сервера)', async () => {
    mocks.api.enqueueMessage.mockResolvedValue({ messageId: 'm1', mode: 'queue', position: null })

    await useTransportStore.getState().sendMessage('s1', 'привет', 'fixer', 'itphx', 'gpt', 'queue')

    const [, text, options] = mocks.api.enqueueMessage.mock.calls[0]!
    expect(text).toBe('привет')
    expect(options.mode).toBe('queue')
    expect(options.agentRole).toBe('fixer')
    // messageId отправки уходит в тело — сервер вернёт его же в `202`.
    expect(options.streamId).toMatch(/^stream-/)
  })

  it('ошибка приёма (сеть/401/валидация) бросается, лента не меняется', async () => {
    mocks.api.enqueueMessage.mockRejectedValue(new Error('Session not found'))

    await expect(
      useTransportStore.getState().sendMessage('s1', 'привет'),
    ).rejects.toThrow('Session not found')

    expect(useChatStore.getState().messagesBySession['s1']).toBeUndefined()
    expect(useChatStore.getState().pendingBySession['s1']).toBeUndefined()
  })
})

describe('transportStore: message.accepted подтверждает отправку (ADR-118 §4)', () => {
  it('адресное подтверждение снимает «отправляется» с оптимистичной строки', async () => {
    startTurn()
    mocks.api.enqueueMessage.mockResolvedValue({ messageId: 'm-new', mode: 'queue', position: 2 })

    await useTransportStore.getState().sendMessage('s1', 'привет')
    expect(useChatStore.getState().pendingBySession['s1']![0]!.sending).not.toBe(true)

    dispatch(makeEvent('message.accepted', 's1', { messageId: 'm-new', mode: 'queue', position: 2 }))

    const pending = useChatStore.getState().pendingBySession['s1']!
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'm-new', content: 'привет' })
    expect(pending[0]!.sending).toBe(false)
  })

  it('повторное message.accepted не создаёт вторую строку (дедуп по id)', () => {
    startTurn()
    useChatStore.getState().upsertPendingMessage('s1', { id: 'm1', content: 'привет' })

    dispatch(makeEvent('message.accepted', 's1', { messageId: 'm1', mode: 'queue', position: 2 }))
    dispatch(makeEvent('message.accepted', 's1', { messageId: 'm1', mode: 'queue', position: 2 }))

    expect(useChatStore.getState().pendingBySession['s1']).toHaveLength(1)
  })
})
