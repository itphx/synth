import { describe, it, expect, beforeEach, vi } from 'vitest'

// Инцидент на test (SSE-фоллбек): ответ на `permission.asked` отправлялся только
// WS-кадром, поэтому при SSE «Запретить» терялся — запрос висел до ask-таймаута.
// Ответ должен уходить HTTP-путём (`sessionsApi.permissionReply`), а не молча
// теряться.
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
    stopGeneration: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/lib/api/sessions', () => ({
  sessionsApi: { permissionReply: vi.fn().mockResolvedValue({ status: 'ok', action: 'deny' }) },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { sessionsApi } from '@/lib/api/sessions'
import { useTransportStore } from './transportStore'
import { usePermissionStore } from './permissionStore'

const permissionReply = vi.mocked(sessionsApi.permissionReply)

/** Подключить SSE и дождаться готовности транспорта. */
function connectSse(): InstanceType<typeof mocks.MockClient> {
  useTransportStore.getState().connect('sse')
  const client = mocks.instances[mocks.instances.length - 1]!
  client.callbacks.onConnect?.()
  return client
}

beforeEach(() => {
  useTransportStore.getState().disconnect()
  mocks.instances.length = 0
  vi.clearAllMocks()
  permissionReply.mockResolvedValue({ status: 'ok', action: 'deny' })
})

describe('transportStore.sendPermissionReply: HTTP-путь без WS', () => {
  it('на SSE ответ уходит POST /sessions/:id/permissions/:approvalId и возвращает true', async () => {
    const client = connectSse()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', false)

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_1', { action: 'deny' })
    // WS-кадр не отправлялся — транспорта WS нет.
    expect(client.sendPermissionReply).not.toHaveBeenCalled()
  })

  it('allow с once уходит с полем once', async () => {
    connectSse()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', true, true)

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_1', { action: 'allow', once: true })
  })

  it('ошибка HTTP — false (запрос остаётся открытым, полосу не убираем)', async () => {
    connectSse()
    permissionReply.mockRejectedValueOnce(new Error('HTTP 500'))

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', false)

    expect(sent).toBe(false)
  })

  it('403 already_consumed — это успех (запрос уже отвечен)', async () => {
    connectSse()
    permissionReply.mockRejectedValueOnce(
      Object.assign(new Error('already'), { status: 403, details: { reason: 'already_consumed' } }),
    )

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', true, true)

    expect(sent).toBe(true)
  })

  it('на WS ответ уходит кадром, HTTP не вызывается', async () => {
    useTransportStore.getState().connect('ws')
    const client = mocks.instances[mocks.instances.length - 1]!
    client.callbacks.onBackendReady?.()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', true, false)

    expect(sent).toBe(true)
    expect(client.sendPermissionReply).toHaveBeenCalledWith('s1', 'approval_1', true, false)
    expect(permissionReply).not.toHaveBeenCalled()
  })

  it('«Остановить таймер» на SSE уходит action=hold', async () => {
    connectSse()

    const sent = await useTransportStore.getState().sendPermissionHold('s1', 'approval_1')

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_1', { action: 'hold' })
  })

  it('«Стоп» убирает висящий запрос подтверждения из стора', () => {
    connectSse()
    usePermissionStore.getState().addRequest('s1', {
      approvalId: 'approval_1',
      toolName: 'list_directory',
      params: { path: '/var/synth/data' },
      reason: 'external_directory',
      askedAt: new Date().toISOString(),
      timeoutMs: 30_000,
    })

    useTransportStore.getState().cancel('s1')

    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
  })
})
