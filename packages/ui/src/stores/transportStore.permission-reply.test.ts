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
    // ADR-118 §8: перед подключением стор спрашивает возможности инстанса.
    getInstanceCapabilities: vi.fn().mockResolvedValue({
      messageModel: 2, eventSeq: true, replay: true, version: 'test',
    }),
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
async function connectSse(): Promise<InstanceType<typeof mocks.MockClient>> {
  useTransportStore.getState().connect('sse')
  const client = mocks.instances[mocks.instances.length - 1]!
  // ADR-118 §8: подключение идёт после сверки возможностей инстанса — ждём,
  // пока клиент реально откроет транспорт (`getTransport()` станет `sse`).
  await vi.waitFor(() => expect(client.getTransport()).toBe('sse'))
  client.callbacks.onConnect?.()
  return client
}

/** Подключить WS и дождаться готовности backend (transportReady). */
async function connectWs(): Promise<InstanceType<typeof mocks.MockClient>> {
  useTransportStore.getState().connect('ws')
  const client = mocks.instances[mocks.instances.length - 1]!
  await vi.waitFor(() => expect(client.getTransport()).toBe('ws'))
  client.callbacks.onBackendReady?.()
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
    const client = await connectSse()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', false)

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_1', { action: 'deny' })
    // WS-кадр не отправлялся — транспорта WS нет.
    expect(client.sendPermissionReply).not.toHaveBeenCalled()
  })

  it('allow с once уходит с полем once', async () => {
    await connectSse()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', true, true)

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_1', { action: 'allow', once: true })
  })

  it('ошибка HTTP — false (запрос остаётся открытым, полосу не убираем)', async () => {
    await connectSse()
    permissionReply.mockRejectedValueOnce(new Error('HTTP 500'))

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', false)

    expect(sent).toBe(false)
  })

  it('403 already_consumed — это успех (запрос уже отвечен)', async () => {
    await connectSse()
    permissionReply.mockRejectedValueOnce(
      Object.assign(new Error('already'), { status: 403, details: { reason: 'already_consumed' } }),
    )

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', true, true)

    expect(sent).toBe(true)
  })

  it('на WS ответ уходит кадром, HTTP не вызывается', async () => {
    const client = await connectWs()

    const sent = await useTransportStore
      .getState()
      .sendPermissionReply('s1', 'approval_1', true, false)

    expect(sent).toBe(true)
    expect(client.sendPermissionReply).toHaveBeenCalledWith('s1', 'approval_1', true, false)
    expect(permissionReply).not.toHaveBeenCalled()
  })

  it('«Остановить таймер» на SSE уходит action=hold', async () => {
    await connectSse()

    const sent = await useTransportStore.getState().sendPermissionHold('s1', 'approval_1')

    expect(sent).toBe(true)
    expect(permissionReply).toHaveBeenCalledWith('s1', 'approval_1', { action: 'hold' })
  })

  it('«Стоп» убирает висящий запрос подтверждения из стора', async () => {
    await connectSse()
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
