/**
 * Оптимистичная строка очереди при отправке во время хода.
 *
 * Сообщение во время выполнения тулов должно быть видно сразу, не дожидаясь
 * серверного `message.queued` (ack идёт за backlog'ом live-кадров). Строка
 * добавляется оптимистично (id = stream_id отправки) и подтверждается
 * серверным событием с тем же `message_id` — без дубля.
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
    /** Отправка: промисом управляет тест (ack/ошибка/таймаут). */
    sendMessage = vi.fn()
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
  /** HTTP-слой: постановка в очередь и сверка очереди с сервером. */
  const api = {
    enqueueMessage: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [], pending_messages: [] }),
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

function connectWs(): InstanceType<typeof mocks.MockClient> {
  useTransportStore.getState().connect('ws')
  const client = mocks.instances[mocks.instances.length - 1]!
  client.callbacks.onBackendReady?.()
  return client
}

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Ход идёт: есть живой стрим (в него и попадёт новое сообщение). */
function startTurn(sessionId = 's1'): void {
  useChatStore.getState().startStream(sessionId, 'turn-1', 'assistant')
}

beforeEach(() => {
  useTransportStore.getState().disconnect()
  mocks.instances.length = 0
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore.sendMessage: оптимистичная строка очереди', () => {
  it('во время хода строка появляется сразу, а message.queued её подтверждает без дубля', async () => {
    const client = connectWs()
    startTurn()

    let resolveSend: (v: { confirmed: boolean }) => void = () => {}
    client.sendMessage.mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))

    const pendingSend = useTransportStore.getState().sendMessage('s1', 'привет')
    const streamId = client.sendMessage.mock.calls[0]![6] as string

    let pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: streamId, content: 'привет', sending: true })

    // Серверное подтверждение несёт тот же id (stream_id = message_id).
    dispatch(makeEvent('message.queued', 's1', {
      message_id: streamId,
      message: 'привет',
      pending_count: 1,
    }))
    resolveSend({ confirmed: true })
    await expect(pendingSend).resolves.toEqual({ confirmed: true })

    pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: streamId, content: 'привет' })
    expect(pending[0]!.sending).toBe(false)
  })

  it('настоящая ошибка отправки убирает оптимистичную строку и бросает', async () => {
    const client = connectWs()
    startTurn()
    client.sendMessage.mockRejectedValue(new Error('Session not found'))

    await expect(useTransportStore.getState().sendMessage('s1', 'привет')).rejects.toThrow('Session not found')
    expect(useChatStore.getState().pendingBySession['s1'] ?? []).toHaveLength(0)
  })

  it('вне хода оптимистичной строки нет (сообщение сразу станет ходом)', async () => {
    const client = connectWs()
    client.sendMessage.mockResolvedValue({ confirmed: true })

    await useTransportStore.getState().sendMessage('s1', 'привет')
    expect(useChatStore.getState().pendingBySession['s1'] ?? []).toHaveLength(0)
  })

  it('неподтверждённая отправка ({confirmed:false}) оставляет строку и сверяет очередь', async () => {
    const client = connectWs()
    startTurn()
    client.sendMessage.mockResolvedValue({ confirmed: false })

    const pendingSend = useTransportStore.getState().sendMessage('s1', 'привет')
    const streamId = client.sendMessage.mock.calls[0]![6] as string

    // Серверное состояние на момент сверки: сообщение уже в очереди, а его
    // `message_id` совпадает с id оптимистичной строки (`stream_id` отправки).
    // Первый pending-элемент при живом ходе — сообщение текущего хода, поэтому
    // в отображаемую очередь идёт `pending_messages.slice(1)`.
    mocks.api.getSession.mockResolvedValueOnce({
      id: 's1',
      messages: [],
      current_stream: { stream_id: 'turn-1' },
      pending_messages: [
        { id: 'turn-1', content: 'сообщение текущего хода' },
        { id: streamId, content: 'привет' },
      ],
    })

    await expect(pendingSend).resolves.toEqual({ confirmed: false })

    // Строка не потеряна; серверная сверка очереди выполняется (GET /sessions/:id).
    expect(useChatStore.getState().pendingBySession['s1'] ?? []).toHaveLength(1)

    // Сверка завершилась — строка осталась той же (id/content), признак
    // «отправляется» снят серверными данными (это делает только reconcile).
    await vi.waitFor(() => {
      expect(mocks.api.getSession).toHaveBeenCalledWith('s1')
      expect(useChatStore.getState().pendingBySession['s1']?.[0]?.sending).not.toBe(true)
    })
    const pending = useChatStore.getState().pendingBySession['s1'] ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: streamId, content: 'привет' })
  })
})

describe('chatStore.updateToolCallSubagentProgress: накопление дельт', () => {
  it('дельты content/reasoning дописываются в live-блок task', () => {
    const chat = useChatStore.getState()
    chat.startStream('s1', 'turn-1', 'assistant')
    chat.addToolCall('s1', 'turn-1', {
      callId: 'call-1',
      name: 'task',
      args: {},
      status: 'running',
      startedAt: new Date().toISOString(),
      iteration: 0,
    })

    chat.updateToolCallSubagentProgress('s1', 'turn-1', 'call-1', {
      reasoningDelta: 'дум', contentDelta: 'Hel', iteration: 0,
    })
    chat.updateToolCallSubagentProgress('s1', 'turn-1', 'call-1', {
      reasoningDelta: 'аю', contentDelta: 'lo', iteration: 0,
    })
    chat.updateToolCallSubagentProgress('s1', 'turn-1', 'call-1', {
      reasoningDelta: 'дальше', contentDelta: 'второй шаг', iteration: 1,
    })

    const call = useChatStore.getState().streamingBySession['s1']!['turn-1']!.toolCalls[0]!
    expect(call.subagentReasoningBlocks).toEqual([
      { text: 'думаю', iteration: 0 },
      { text: 'дальше', iteration: 1 },
    ])
    expect(call.subagentIntermediateTextBlocks).toEqual([
      { text: 'Hello', iteration: 0 },
      { text: 'второй шаг', iteration: 1 },
    ])
  })
})
