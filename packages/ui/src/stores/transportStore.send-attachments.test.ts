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
    sendMessage = vi.fn().mockResolvedValue(undefined)
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
    enqueueMessage: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { synthApi } from '@/lib/api/synthApi'
import { useTransportStore } from './transportStore'

const enqueueMessage = vi.mocked(synthApi.enqueueMessage)

/** Подключить WS и дождаться готовности backend (transportReady). */
function connectWs(): InstanceType<typeof mocks.MockClient> {
  useTransportStore.getState().connect('ws')
  const client = mocks.instances[mocks.instances.length - 1]!
  client.callbacks.onBackendReady?.()
  return client
}

beforeEach(() => {
  useTransportStore.getState().disconnect()
  mocks.instances.length = 0
  vi.clearAllMocks()
})

describe('transportStore.sendMessage: вложения (ADR-115)', () => {
  it('без вложений при живом WS сообщение уходит кадром send_message', async () => {
    const client = connectWs()

    await useTransportStore.getState().sendMessage('s1', 'привет')

    expect(client.sendMessage).toHaveBeenCalledWith('s1', 'привет', undefined, undefined, undefined, undefined)
    expect(enqueueMessage).not.toHaveBeenCalled()
  })

  it('с вложениями сообщение уходит HTTP-путём и несёт attachments', async () => {
    const client = connectWs()

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
