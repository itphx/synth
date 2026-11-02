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
    // ADR-118 §8: перед подключением стор спрашивает возможности инстанса.
    getInstanceCapabilities: vi.fn().mockResolvedValue({
      messageModel: 2, eventSeq: true, replay: true, version: 'test',
    }),
    getSession: vi.fn().mockResolvedValue({ id: 'parent', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getSessions: vi.fn().mockResolvedValue([]),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
    enqueueMessage: vi.fn().mockResolvedValue(undefined),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { useTransportStore, __resetTransportResyncForTests } from './transportStore'
import { useChatStore } from './chatStore'
import { synthApi } from '@/lib/api/synthApi'

beforeEach(() => {
  // Сброс модульного состояния стора (transport/activeKind) между тестами.
  useTransportStore.getState().disconnect()
  useTransportStore.setState({ transportMode: 'auto', connected: false, activeTransport: 'disconnected' })
  __resetTransportResyncForTests()
  mocks.instances.length = 0
  vi.clearAllMocks()
})

/**
 * ADR-118 §8: подключение стало **асинхронным** — сначала `GET /api/v2/meta`
 * и сверка модели сообщений, и только затем `client.connect()`. Поэтому
 * «эффективный транспорт установлен» проверяем после фактического подключения
 * клиента, иначе guard идемпотентности видит ещё `disconnected`.
 */
async function waitConnected(client: InstanceType<typeof mocks.MockClient>, mode?: 'ws' | 'sse') {
  await vi.waitFor(() => expect(client.getTransport()).not.toBe('disconnected'))
  if (mode) expect(client.getTransport()).toBe(mode)
}

describe('transportStore.connect: идемпотентность (ADR-024, двойной старт)', () => {
  it('connect(auto) → connect(ws): эффективный транспорт один и тот же — клиент не пересоздаётся', async () => {
    const store = useTransportStore.getState()
    store.connect('auto')
    expect(mocks.instances).toHaveLength(1)
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')

    store.connect('ws')

    expect(mocks.instances).toHaveLength(1)
    expect(first.disconnect).not.toHaveBeenCalled()
    expect(first.connect).toHaveBeenCalledTimes(1)
  })

  it('BackendConnection-сценарий: setTransportMode(auto) → setTransportMode(ws) не пересоздаёт клиент', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('auto')
    expect(mocks.instances).toHaveLength(1)
    await waitConnected(mocks.instances[0]!, 'ws')

    store.setTransportMode('ws')

    expect(mocks.instances).toHaveLength(1)
    expect(mocks.instances[0]!.disconnect).not.toHaveBeenCalled()
    expect(useTransportStore.getState().transportMode).toBe('ws')
  })

  it('повторный connect(sse) не пересоздаёт SSE-клиент', async () => {
    const store = useTransportStore.getState()
    store.connect('sse')
    const first = mocks.instances[0]!
    await waitConnected(first, 'sse')

    store.connect('sse')

    expect(mocks.instances).toHaveLength(1)
    expect(first.disconnect).not.toHaveBeenCalled()
  })

  it('смена эффективного транспорта ws→sse пересоздаёт клиент', async () => {
    const store = useTransportStore.getState()
    store.connect('ws')
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')

    store.connect('sse')

    expect(mocks.instances).toHaveLength(2)
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    await waitConnected(mocks.instances[1]!, 'sse')
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('sse')
  })
})

describe('transportStore.connect: восстановление и fallback не блокируются', () => {
  it('после onDisconnect форс-connect(ws) снова подключает (guard не мешает)', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('ws')
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')

    first.callbacks.onDisconnect?.('WS closed: 1006')
    expect(useTransportStore.getState().connected).toBe(false)
    expect(mocks.instances).toHaveLength(1)

    store.connect('ws')

    expect(mocks.instances).toHaveLength(2)
    await waitConnected(mocks.instances[1]!, 'ws')
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('ws')
  })

  it('auto-fallback WS→SSE после обрыва проходит и переключает транспорт', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('auto')
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')

    first.callbacks.onDisconnect?.('WS closed: 1006')

    expect(mocks.instances).toHaveLength(2)
    await waitConnected(mocks.instances[1]!, 'sse')
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('sse')
  })
})

/**
 * Регрессия (2026-10-30, dev): двойное подключение транспорта.
 *
 * ADR-118 §8 сделал старт асинхронным (`GET /api/v2/meta` → `client.connect`).
 * До фикса повторный `connect()` **в этом окне** создавал второй клиент, а
 * первый оставался жить: каждое событие доставлялось дважды, и дельты текста
 * применялись по два раза («okok, Б Босссосс…»). Отдельно защищаем применение
 * `part.delta`: одно событие — одна дельта (иначе дубль возникает и без второго
 * соединения).
 */
describe('transportStore.connect: окно асинхронного старта (двойная доставка)', () => {
  it('connect(auto) → connect(ws) до ответа /meta: второй клиент не создаётся', async () => {
    const store = useTransportStore.getState()
    store.connect('auto')
    expect(mocks.instances).toHaveLength(1)

    // Повторный вызов до того, как проверка возможностей инстанса завершилась.
    store.connect('ws')

    expect(mocks.instances).toHaveLength(1)
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')
    expect(first.connect).toHaveBeenCalledTimes(1)
    expect(first.disconnect).not.toHaveBeenCalled()
  })

  it('setTransportMode(auto) → setTransportMode(ws) до ответа /meta: одно соединение', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('auto')
    store.setTransportMode('ws')

    expect(mocks.instances).toHaveLength(1)
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')
    expect(first.connect).toHaveBeenCalledTimes(1)
    expect(useTransportStore.getState().transportMode).toBe('ws')
  })

  it('одно событие `part.delta` применяется ровно один раз', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('ws')
    const client = mocks.instances[0]!
    await waitConnected(client, 'ws')

    store.connect('ws') // повторный вызов — второго клиента быть не должно
    expect(mocks.instances).toHaveLength(1)

    // Дельта приходит по ходу (ADR-118 §5): без активного хода она
    // опоздавшая и игнорируется — гонки тут не проверяем.
    client.callbacks.onEvent?.({
      type: 'turn.started',
      session_id: 'sess-dup',
      data: { turnId: 't-dup', messageId: 'm-user' },
    })

    client.callbacks.onEvent?.({
      type: 'part.delta',
      session_id: 'sess-dup',
      data: { messageId: 'msg-dup', partId: 'msg:text:0', delta: 'ok' },
    })

    const parts = useChatStore.getState().partsBySession['sess-dup']?.['msg-dup']
    expect(parts?.['msg:text:0']?.text).toBe('ok')
  })
})

/**
 * Регрессия (PWA вернулась из фона): соединение выглядит открытым, но мертво.
 * `connect()` блокируется guard'ом идемпотентности — нужен `restart()`.
 */
describe('transportStore.restart: принудительный перезапуск транспорта', () => {
  it('пересоздаёт клиент того же транспорта в обход guard`а', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('ws')
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')

    store.restart()

    expect(first.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.instances).toHaveLength(2)
    await waitConnected(mocks.instances[1]!, 'ws')
    expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('ws')
  })

  it('в режиме auto перезапускает фактический транспорт после fallback WS→SSE', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('auto')
    const first = mocks.instances[0]!
    await waitConnected(first, 'ws')

    first.callbacks.onDisconnect?.('WS closed: 1006')
    await waitConnected(mocks.instances[1]!, 'sse')
    expect(mocks.instances).toHaveLength(2)

    store.restart()

    expect(mocks.instances).toHaveLength(3)
    await waitConnected(mocks.instances[2]!, 'sse')
    expect(mocks.instances[2]!.connect).toHaveBeenCalledWith('sse')
  })

  it('после реконнекта перечитывает список сессий (ресинк)', async () => {
    const store = useTransportStore.getState()
    store.setTransportMode('sse')
    const client = mocks.instances[0]!
    await waitConnected(client, 'sse')
    // Первое успешное подключение — ресинк не нужен.
    client.callbacks.onConnect?.()
    expect(synthApi.getSessions).not.toHaveBeenCalled()

    // Обрыв и восстановление в рамках того же клиента (TransportClient сам
    // переподключается через backoff — здесь эмулируем успешный onConnect).
    client.callbacks.onDisconnect?.('SSE error')
    client.callbacks.onConnect?.()

    await vi.waitFor(() => expect(synthApi.getSessions).toHaveBeenCalled())
  })
})
