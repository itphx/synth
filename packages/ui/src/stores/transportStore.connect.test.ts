import { describe, it, expect, beforeEach, vi } from 'vitest'

// Мок TransportClient: реальную сеть (WebSocket/EventSource) не поднимаем.
// Каждый экземпляр складывается в instances — по нему проверяем, пересоздавался
// ли клиент при идемпотентном connect().
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
      this.kind = 'disconnected'
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
    getSession: vi.fn().mockResolvedValue({ id: 'parent', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
    enqueueMessage: vi.fn().mockResolvedValue(undefined),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { useTransportStore } from './transportStore'

beforeEach(() => {
  // Сброс модульного состояния стора (transport/activeKind) между тестами.
  useTransportStore.getState().disconnect()
  useTransportStore.setState({ transportMode: 'auto', connected: false, activeTransport: 'disconnected' })
  mocks.instances.length = 0
  vi.clearAllMocks()
})

describe('transportStore.connect: идемпотентность (ADR-024, двойной старт)', () => {
  it('connect(auto) → connect(ws): эффективный транспорт один и тот же — клиент не пересоздаётся', () => {
    const store = useTransportStore.getState()
    store.connect('auto')
    expect(mocks.instances).toHaveLength(1)
    const first = mocks.instances[0]!
    expect(first.getTransport()).toBe('ws')

    store.connect('ws')

    expect(mocks.instances).toHaveLength(1)
    expect(first.disconnect).not.toHaveBeenCalled()
    expect(first.connect).toHaveBeenCalledTimes(1)
  })

  it('BackendConnection-сценарий: setTransportMode(auto) → setTransportMode(ws) не пересоздаёт клиент', () => {
    const store = useTransportStore.getState()
    store.setTransportMode('auto')
    expect(mocks.instances).toHaveLength(1)

    store.setTransportMode('ws')

    expect(mocks.instances).toHaveLength(1)
    expect(mocks.instances[0]!.disconnect).not.toHaveBeenCalled()
    expect(useTransportStore.getState().transportMode).toBe('ws')
  })

  it('повторный connect(sse) не пересоздаёт SSE-клиент', () => {
    const store = useTransportStore.getState()
    store.connect('sse')
    const first = mocks.instances[0]!
    expect(first.getTransport()).toBe('sse')

    store.connect('sse')

    expect(mocks.instances).toHaveLength(1)
    expect(first.disconnect).not.toHaveBeenCalled()
  })

  it('смена эффективного транспорта ws→sse пересоздаёт клиент', () => {
    const store = useTransportStore.getState()
    store.connect('ws')
    const first = mocks.instances[0]!

    store.connect('sse')

    expect(mocks.instances).toHaveLength(2)
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.instances[1]!.getTransport()).toBe('sse')
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('sse')
  })
})

describe('transportStore.connect: восстановление и fallback не блокируются', () => {
  it('после onDisconnect форс-connect(ws) снова подключает (guard не мешает)', () => {
    const store = useTransportStore.getState()
    store.setTransportMode('ws')
    const first = mocks.instances[0]!

    first.callbacks.onDisconnect?.('WS closed: 1006')
    expect(useTransportStore.getState().connected).toBe(false)
    expect(mocks.instances).toHaveLength(1)

    store.connect('ws')

    expect(mocks.instances).toHaveLength(2)
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('ws')
  })

  it('auto-fallback WS→SSE после обрыва проходит и переключает транспорт', () => {
    const store = useTransportStore.getState()
    store.setTransportMode('auto')
    const first = mocks.instances[0]!
    expect(first.getTransport()).toBe('ws')

    first.callbacks.onDisconnect?.('WS closed: 1006')

    expect(mocks.instances).toHaveLength(2)
    expect(mocks.instances[1]!.getTransport()).toBe('sse')
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('sse')
  })
})
