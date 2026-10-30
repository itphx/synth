import type { SteerMode } from '@itphx/synth-shared/types'

export interface WSEvent {
  type: string
  session_id?: string
  sessionId?: string
  data?: Record<string, unknown>
}

export type TransportKind = 'ws' | 'sse' | 'disconnected'

export interface TransportClientCallbacks {
  onEvent: (event: WSEvent) => void
  onConnect?: () => void
  onDisconnect?: (reason: string) => void
  onTransportSwitch?: (transport: TransportKind) => void
  onBackendReady?: () => void
}

const HEARTBEAT_INTERVAL = 25_000
const INITIAL_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 60_000
/**
 * Ожидание подтверждения отправки. 30 с: ack (`queued`/`message.queued`) идёт
 * тем же упорядоченным WS-каналом, что и поток live-событий (прогресс
 * саб-агентов и т.п.), поэтому при всплеске событий он может прийти заметно
 * позже постановки в очередь. По истечении срока сообщение **не считается
 * потерянным**: отправка возвращает `{confirmed: false}`, а UI сверяет очередь
 * с сервером (`GET /sessions/:id`), а не показывает ошибку.
 */
const SEND_TIMEOUT = 30_000

/** Итог отправки: подтверждена ли постановка в очередь сервером. */
export interface SendResult {
  confirmed: boolean
  streamId: string
}

export class TransportClient {
  private ws: WebSocket | null = null
  private sseSource: EventSource | null = null
  private transport: TransportKind = 'disconnected'
  private callbacks: TransportClientCallbacks
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private intentionalClose = false
  private counter = 0
  private backendReady = false
  private pending = new Map<string, {
    sessionId: string
    resolve: (confirmed: boolean) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(callbacks: TransportClientCallbacks) {
    this.callbacks = callbacks
  }

  connect(mode: 'ws' | 'sse'): void {
    this.intentionalClose = false
    if (mode === 'sse') {
      this.connectSSE()
    } else {
      this.connectWS()
    }
  }

  disconnect(): void {
    this.intentionalClose = true
    this.cleanupTransport()
    this.rejectPending(new Error('Disconnected'))
    this.transport = 'disconnected'
    this.callbacks.onDisconnect?.('manual')
  }

  getTransport(): TransportKind {
    return this.transport
  }

  isBackendReady(): boolean {
    return this.backendReady
  }

  /**
   * Отправка сообщения по WS-кадру `send_message`.
   *
   * `streamId` можно передать заранее (его генерирует вызывающий слой): по нему
   * клиент сопоставляет оптимистичную строку очереди с серверным `message_id`
   * (сервер использует `stream_id` кадра как id сообщения).
   *
   * Ack приходит кадром `queued` (сразу при приёме) либо событием
   * `message.queued` из шины (тот же `stream_id`). Таймаут — не ошибка:
   * возвращаем `{confirmed: false}`, сообщение остаётся в очереди сервера и
   * сверяется с ним отдельно.
   */
  async sendMessage(
    sessionId: string,
    text: string,
    agentRole?: string,
    provider?: string,
    model?: string,
    mode?: SteerMode,
    streamId?: string,
  ): Promise<SendResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }
    const id = streamId || `stream-${++this.counter}-${Date.now()}`
    return new Promise<SendResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ confirmed: false, streamId: id })
      }, SEND_TIMEOUT)
      this.pending.set(id, {
        sessionId,
        resolve: (confirmed) => resolve({ confirmed, streamId: id }),
        reject,
        timer,
      })
      this.ws!.send(JSON.stringify({
        type: 'send_message',
        session_id: sessionId,
        content: text,
        stream_id: id,
        agent_role: agentRole,
        provider,
        model,
        // ADR-104: режим отправки (`queue` по умолчанию, `steer` — вмешательство
        // в активный ход, `interrupt` — прерывание генерации с продолжением
        // хода). Не задан — сервер трактует как `queue`.
        ...(mode && mode !== 'queue' ? { mode } : {}),
      }))
    })
  }

  cancel(sessionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'cancel', session_id: sessionId }))
  }

  /**
   * Ответ на запрос подтверждения (permission.asked).
   * `approved` — поле, которое понимает текущий backend (permission.replied).
   * `action`/`once` — расширенный формат для W4 (allow once / allow session);
   * старый backend просто проигнорирует неизвестные поля.
   */
  sendPermissionReply(sessionId: string, approvalId: string, approved: boolean, once?: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'permission_reply',
      session_id: sessionId,
      approval_id: approvalId,
      approved,
      action: approved ? 'allow' : 'deny',
      ...(approved && once !== undefined ? { once } : {}),
    }))
  }

  /**
   * «Остановить таймер» (permission_hold): снимает авто-отклонение ask по таймауту
   * на бэкенде — запрос подтверждения остаётся на панели и ждёт ответа пользователя.
   */
  sendPermissionHold(sessionId: string, approvalId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'permission_hold',
      session_id: sessionId,
      approval_id: approvalId,
    }))
  }

  private connectWS(): void {
    this.cleanupTransport()
    this.transport = 'ws'

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws/events`
    console.debug('[WS] Connecting:', url)

    try {
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        console.debug('[WS] Connected')
        this.reconnectAttempts = 0
        this.transport = 'ws'
        this.startHeartbeat()
        this.backendReady = false
        this.callbacks.onTransportSwitch?.('ws')
        this.callbacks.onConnect?.()
      }

      this.ws.onclose = (e) => {
        console.debug('[WS] Closed: code=', e.code, 'reason=', e.reason, 'wasClean=', e.wasClean)
        this.stopHeartbeat()
        this.rejectPending(new Error('WebSocket closed'))
        if (!this.intentionalClose) {
          this.callbacks.onDisconnect?.(`WS closed: ${e.code}`)
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (e) => {
        console.debug('[WS] Error:', e)
      }

      this.ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.type === 'pong') return

          if (data.type === 'connected') {
            this.backendReady = true
            this.callbacks.onBackendReady?.()
            return
          }

          // Ack отправки: кадр `queued` (сервер принял `send_message`) или
          // событие `message.queued` из шины (тот же `stream_id` — сервер
          // публикует его после фактической постановки в очередь).
          if (
            data.type === 'queued'
            || data.type === 'message_queued'
            || data.type === 'message.queued'
          ) {
            const streamId = (data.stream_id as string)
              || (data.data?.stream_id as string)
              || ''
            if (streamId) {
              const pending = this.pending.get(streamId)
              if (pending) {
                clearTimeout(pending.timer)
                pending.resolve(true)
                this.pending.delete(streamId)
              }
            }
          }

          // Server-side отказ (нет сессии, нет прав, лимит вмешательств) —
          // это настоящая ошибка отправки, а не «ещё не подтверждено»:
          // снимаем ожидание ближайшего кадра этой сессии.
          if (data.type === 'error') {
            const sid = (data.session_id as string) || (data.sessionId as string)
            const message = (data.data?.error as string) || (data.error as string) || 'Send failed'
            for (const [id, pending] of this.pending) {
              if (sid && pending.sessionId !== sid) continue
              clearTimeout(pending.timer)
              this.pending.delete(id)
              pending.reject(new Error(message))
              break
            }
          }

          this.callbacks.onEvent(data as WSEvent)
        } catch (e) {
          console.error('[TransportClient] WS message error:', e)
        }
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private connectSSE(): void {
    this.cleanupTransport()
    this.transport = 'sse'

    const url = '/api/v2/events'
    console.debug('[SSE] Connecting:', url)

    try {
      this.sseSource = new EventSource(url)

      this.sseSource.onopen = () => {
        console.debug('[SSE] Connected')
        this.reconnectAttempts = 0
        this.transport = 'sse'
        this.callbacks.onTransportSwitch?.('sse')
        this.callbacks.onConnect?.()
      }

      this.sseSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          this.callbacks.onEvent(data as WSEvent)
        } catch (e) {
          console.error('[TransportClient] SSE message error:', e)
        }
      }

      this.sseSource.onerror = (e) => {
        console.debug('[SSE] Error:', e.type)
        if (!this.intentionalClose) {
          this.callbacks.onDisconnect?.('SSE error')
          this.scheduleReconnect()
        }
      }
    } catch {
      console.debug('[SSE] Failed to create EventSource')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY)
    this.reconnectAttempts++
    console.debug('[Transport] Reconnect in', delay, 'ms (attempt', this.reconnectAttempts, ')')
    this.reconnectTimer = setTimeout(() => {
      if (this.sseSource) {
        this.connectSSE()
      } else {
        this.connectWS()
      }
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private cleanupTransport(): void {
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
    if (this.sseSource) {
      this.sseSource.onopen = null
      this.sseSource.onmessage = null
      this.sseSource.onerror = null
      this.sseSource.close()
      this.sseSource = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
