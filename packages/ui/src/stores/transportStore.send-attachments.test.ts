import { describe, it, expect, beforeEach, vi } from 'vitest'

// ADR-115: вложения не влезают в WS-кадр `send_message`, поэтому сообщение
// с вложениями обязано уходить HTTP-путём даже при живом WS.
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
    sendMessage = vi.fn().mockResolvedValue({ confirmed: true })
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
  return { instances, MockClient }
})

vi.mock('@/lib/api/transport', () => ({ TransportClient: mocks.MockClient }))
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    // ADR-118 §8: перед подключением стор спрашивает возможности инстанса.
    getInstanceCapabilities: vi.fn().mockResolvedValue({
      messageModel: 2, eventSeq: true, replay: true, version: 'test',
    }),
    // ADR-118 §3: приём — `POST /sessions/:id/prompt` → `202 {messageId, mode, position}`.
    enqueueMessage: vi.fn().mockResolvedValue({
      messageId: 'stream-test', mode: 'queue', position: null,
    }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { synthApi } from '@/lib/api/synthApi'
import { useTransportStore } from './transportStore'

const enqueueMessage = vi.mocked(synthApi.enqueueMessage)

/** Подключить WS и дождаться готовности backend (transportReady). */
async function connectWs(): Promise<InstanceType<typeof mocks.MockClient>> {
  useTransportStore.getState().connect('ws')
  const client = mocks.instances[mocks.instances.length - 1]!
  // ADR-118 §8: подключение идёт после сверки возможностей инстанса.
  await vi.waitFor(() => expect(client.getTransport()).toBe('ws'))
  client.callbacks.onBackendReady?.()
  return client
}

beforeEach(() => {
  useTransportStore.getState().disconnect()
  mocks.instances.length = 0
  vi.clearAllMocks()
  enqueueMessage.mockResolvedValue({ messageId: 'stream-test', mode: 'queue', position: null })
})

describe('transportStore.sendMessage: вложения (ADR-115)', () => {
  it('без вложений сообщение всё равно уходит HTTP-путём (кадр send_message удалён)', async () => {
    const client = await connectWs()

    await useTransportStore.getState().sendMessage('s1', 'привет')

    // ADR-118 §3: WS-кадра отправки больше нет — единственный путь приёма.
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(enqueueMessage).toHaveBeenCalledTimes(1)
    const [sessionId, text, options] = enqueueMessage.mock.calls[0]!
    expect(sessionId).toBe('s1')
    expect(text).toBe('привет')
    expect(options!.attachments).toBeUndefined()
    expect(options!.streamId).toMatch(/^stream-/)
  })

  it('с вложениями сообщение уходит HTTP-путём и несёт attachments', async () => {
    const client = await connectWs()

    await useTransportStore
      .getState()
      .sendMessage('s1', 'привет', 'assistant', 'itphx', 'm1', 'steer', ['part-1', 'part-2'])

    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(enqueueMessage).toHaveBeenCalledWith(
      's1',
      'привет',
      expect.objectContaining({
        agentRole: 'assistant',
        provider: 'itphx',
        model: 'm1',
        mode: 'steer',
        attachments: ['part-1', 'part-2'],
      }),
    )
  })
})
