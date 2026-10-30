/**
 * ADR-118 §3/§6/§8: транспортный слой.
 *
 * - отправки сообщения по транспорту больше нет (только `POST /prompt` → 202),
 *   поэтому `sendMessage`/ack-ожиданий/«Send timeout» в клиенте нет;
 * - WS/SSE-URL обязаны нести `messageModel=2` (fail-closed на сервере);
 * - догон: `?since=` — номер последнего применённого события, обновляется по
 *   каждому полученному событию (SSE — ещё и из `id:` кадра).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MESSAGE_MODEL_VERSION } from '@itphx/synth-shared/types'
import { TransportClient } from './transport'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeWebSocket | null = null
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.last = this
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  /** Доставить кадр от сервера. */
  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

class FakeEventSource {
  static last: FakeEventSource | null = null
  static instances: FakeEventSource[] = []

  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null
  onerror: ((e: { type: string }) => void) | null = null

  constructor(public url: string) {
    FakeEventSource.last = this
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.readyState = 2
  }

  /** Доставить кадр SSE (`id:` — номер события, если `lastEventId` задан). */
  emit(frame: Record<string, unknown>, lastEventId = ''): void {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId })
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('EventSource', FakeEventSource)
  FakeWebSocket.last = null
  FakeWebSocket.instances = []
  FakeEventSource.last = null
  FakeEventSource.instances = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function connectedWs(): { client: TransportClient; ws: FakeWebSocket } {
  const client = new TransportClient({ onEvent: vi.fn() })
  client.connect('ws')
  const ws = FakeWebSocket.last!
  ws.onopen?.()
  return { client, ws }
}

describe('TransportClient: версия модели сообщений в URL (ADR-118 §8)', () => {
  it('WS-URL несёт messageModel=<версия клиента>', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    client.connect('ws')
    const url = new URL(FakeWebSocket.last!.url)
    expect(url.searchParams.get('messageModel')).toBe(String(MESSAGE_MODEL_VERSION))
  })

  it('SSE-URL несёт messageModel=<версия клиента>', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    client.connect('sse')
    const url = new URL(FakeEventSource.last!.url, 'http://localhost')
    expect(url.pathname).toBe('/api/v2/events')
    expect(url.searchParams.get('messageModel')).toBe(String(MESSAGE_MODEL_VERSION))
  })
})

describe('TransportClient: догон по since (ADR-118 §6)', () => {
  it('connect с since → параметр уходит в URL', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    client.connect('ws', { since: 42 })
    const url = new URL(FakeWebSocket.last!.url)
    expect(url.searchParams.get('since')).toBe('42')
  })

  it('без since параметра в URL нет (первичное подключение)', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    client.connect('ws')
    expect(new URL(FakeWebSocket.last!.url).searchParams.has('since')).toBe(false)
  })

  it('WS: после полученного события переподключение несёт обновлённый since', async () => {
    vi.useFakeTimers()
    const client = new TransportClient({ onEvent: vi.fn() })
    client.connect('ws')
    const first = FakeWebSocket.last!
    first.onopen?.()
    first.emit({ type: 'part.delta', session_id: 's1', eventSeq: 17, data: {} })

    // Обрыв → scheduleReconnect (backoff 1 с) → новое подключение.
    first.onclose?.({ code: 1006, reason: '', wasClean: false })
    await vi.advanceTimersByTimeAsync(1_000)

    const second = FakeWebSocket.last!
    expect(second).not.toBe(first)
    expect(new URL(second.url).searchParams.get('since')).toBe('17')
  })

  it('SSE: номер из `id:` кадра становится eventSeq и точкой догона', async () => {
    vi.useFakeTimers()
    const onEvent = vi.fn()
    const client = new TransportClient({ onEvent })
    client.connect('sse')
    const first = FakeEventSource.last!
    first.onopen?.()
    // Тело кадра без `eventSeq` — номер берём из `id:`.
    first.emit({ type: 'turn.started', session_id: 's1', data: {} }, '9')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn.started', eventSeq: 9 }),
    )

    first.onerror?.({ type: 'error' })
    await vi.advanceTimersByTimeAsync(1_000)

    const second = FakeEventSource.last!
    expect(second).not.toBe(first)
    expect(new URL(second.url, 'http://localhost').searchParams.get('since')).toBe('9')
  })

  it('since не откатывается назад при повторном connect с меньшим значением', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    client.connect('ws', { since: 50 })
    client.connect('ws', { since: 10 })
    expect(new URL(FakeWebSocket.last!.url).searchParams.get('since')).toBe('50')
  })
})

describe('TransportClient: приём сообщений — не через транспорт (ADR-118 §3)', () => {
  it('отправки по WS нет: метода sendMessage у клиента нет', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    expect((client as unknown as Record<string, unknown>).sendMessage).toBeUndefined()
  })

  it('кадр connected — сигнал готовности backend, а не событие сессии', () => {
    const onEvent = vi.fn()
    const onBackendReady = vi.fn()
    const client = new TransportClient({ onEvent, onBackendReady })
    client.connect('ws')
    const ws = FakeWebSocket.last!
    ws.emit({ type: 'connected' })
    expect(onBackendReady).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()
    expect(client.isBackendReady()).toBe(true)
  })

  it('кадр pong не доставляется в диспетчер', () => {
    const onEvent = vi.fn()
    const client = new TransportClient({ onEvent })
    client.connect('ws')
    FakeWebSocket.last!.emit({ type: 'pong' })
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe('TransportClient: WS-кадры управления', () => {
  it('cancel отправляет кадр cancel', () => {
    const { client, ws } = connectedWs()
    client.cancel('s1')
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ type: 'cancel', session_id: 's1' })
  })

  it('sendPermissionReply отправляет allow/deny с once', () => {
    const { client, ws } = connectedWs()

    client.sendPermissionReply('s1', 'ap-1', true, true)
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: 'permission_reply',
      session_id: 's1',
      approval_id: 'ap-1',
      approved: true,
      action: 'allow',
      once: true,
    })

    client.sendPermissionReply('s1', 'ap-2', false)
    const denied = JSON.parse(ws.sent.at(-1)!)
    expect(denied).toMatchObject({ approved: false, action: 'deny' })
    expect('once' in denied).toBe(false)
  })

  it('sendPermissionHold отправляет permission_hold', () => {
    const { client, ws } = connectedWs()
    client.sendPermissionHold('s1', 'ap-1')
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: 'permission_hold',
      session_id: 's1',
      approval_id: 'ap-1',
    })
  })

  it('без открытого сокета кадры не бросают (молча игнорируются)', () => {
    const client = new TransportClient({ onEvent: vi.fn() })
    expect(() => client.cancel('s1')).not.toThrow()
    expect(() => client.sendPermissionReply('s1', 'ap-1', true)).not.toThrow()
  })
})
