/**
 * Отправка по WS: подтверждение постановки в очередь и таймаут.
 *
 * ack (`queued`/`message.queued`) идёт тем же упорядоченным каналом, что live-
 * события, поэтому таймаут — не ошибка: отправка возвращает
 * `{confirmed: false}`, а UI сверяет очередь с сервером. Настоящий отказ
 * сервера (`error`) — по-прежнему исключение.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TransportClient } from './transport'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeWebSocket | null = null

  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.last = this
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

function lastFrame(ws: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[ws.sent.length - 1]!) as Record<string, unknown>
}

function connected(): { client: TransportClient; ws: FakeWebSocket } {
  const client = new TransportClient({ onEvent: vi.fn() })
  client.connect('ws')
  const ws = FakeWebSocket.last!
  ws.onopen?.()
  return { client, ws }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.last = null
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TransportClient.sendMessage: ack и таймаут', () => {
  it('резолвит по событию message.queued с тем же stream_id (а не только по кадру queued)', async () => {
    const { client, ws } = connected()

    const pending = client.sendMessage('s1', 'привет')
    const frame = lastFrame(ws)
    const streamId = frame.stream_id as string
    expect(streamId).toMatch(/^stream-/)

    ws.emit({
      type: 'message.queued',
      session_id: 's1',
      data: { stream_id: streamId, message_id: streamId, message: 'привет', pending_count: 1 },
    })

    await expect(pending).resolves.toEqual({ confirmed: true, streamId })
  })

  it('использует переданный streamId (id оптимистичной строки совпадает с message_id)', async () => {
    const { client, ws } = connected()

    const pending = client.sendMessage('s1', 'привет', undefined, undefined, undefined, undefined, 'stream-42-1')
    expect(lastFrame(ws).stream_id).toBe('stream-42-1')
    ws.emit({ type: 'queued', session_id: 's1', stream_id: 'stream-42-1' })

    await expect(pending).resolves.toEqual({ confirmed: true, streamId: 'stream-42-1' })
  })

  it('таймаут (30 с) — не ошибка: {confirmed:false}, сообщение не теряется', async () => {
    vi.useFakeTimers()
    const { client } = connected()

    const pending = client.sendMessage('s1', 'привет')
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(pending).resolves.toMatchObject({ confirmed: false })
  })

  it('кадр error от сервера — настоящая ошибка отправки', async () => {
    const { client, ws } = connected()

    const pending = client.sendMessage('s1', 'привет')
    ws.emit({ type: 'error', session_id: 's1', data: { error: 'Session not found' } })

    await expect(pending).rejects.toThrow('Session not found')
  })
})
