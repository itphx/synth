// ADR-118 §3: отправка сообщения идёт через HTTP (`POST /sessions/:id/prompt`),
// поэтому тип `SteerMode` в транспортном слое больше не нужен.
import { MESSAGE_MODEL_QUERY_PARAM, MESSAGE_MODEL_VERSION } from '@itphx/synth-shared/types'

export interface WSEvent {
  type: string
  session_id?: string
  sessionId?: string
  data?: Record<string, unknown>
  /** ADR-118 §6: номер события в пределах сессии — основа догона (`since`). */
  eventSeq?: number
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
 * ADR-118 §3: отправка сообщения **не** ждёт подтверждения по транспорту.
 * Контракт приёма — `202 {messageId, mode, position}` из
 * `POST /sessions/:id/prompt`; подтверждение приходит адресным событием
 * `message.accepted`. Поэтому ack-ожидания и таймаута «Send timeout» здесь нет.
 */

export class TransportClient {
  private ws: WebSocket | null = null
  private sseSource: EventSource | null = null
  private transport: TransportKind = 'disconnected'
  private callbacks: TransportClientCallbacks
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private intentionalClose = false
  private backendReady = false
  /** ADR-118 §6: номер последнего виденного события — точка догона (`since`). */
  private since: number | undefined

  constructor(callbacks: TransportClientCallbacks) {
    this.callbacks = callbacks
  }

  /**
   * Подключение к транспорту событий.
   *
   * ADR-118 §8: клиент **обязан** заявить свою модель сообщений
   * (`messageModel=2`) — иначе сервер откажет в соединении (fail-closed).
   * ADR-118 §6: `since` — номер последнего применённого события: сервер
   * сначала отдаёт журнал строго после него (догон без разрыва и дублей).
   */
  connect(mode: 'ws' | 'sse', opts?: { since?: number }): void {
    this.intentionalClose = false
    // `since` — максимум из известного: точка догона не должна откатываться
    // назад, если клиент переподключается после нескольких событий.
    if (typeof opts?.since === 'number') {
      this.since = typeof this.since === 'number' ? Math.max(this.since, opts.since) : opts.since
    } else if (typeof this.since !== 'number') {
      this.since = undefined
    }
    if (mode === 'sse') {
      this.connectSSE()
    } else {
      this.connectWS()
    }
  }

  disconnect(): void {
    this.intentionalClose = true
    this.cleanupTransport()
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
   * ADR-118 §3: отправка сообщения по WS-кадру `send_message` **удалена** —
   * приём идёт через `POST /sessions/:id/prompt` (`202 {messageId, mode,
   * position}`), без SSE-ожидания и без таймаута подтверждения.
   */
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

  /**
   * ADR-118 §6: точка догона обновляется по каждому полученному событию — при
   * переподключении в `?since=` уходит именно она (журнал отдаётся строго
   * после этого номера).
   */
  private noteEventSeq(seq: unknown): void {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return
    if (typeof this.since !== 'number' || seq > this.since) this.since = seq
  }

  /** Номер события из `id:` SSE-кадра (`Last-Event-ID`). */
  private parseEventId(raw: unknown): number | undefined {
    if (typeof raw !== 'string' || raw === '') return undefined
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : undefined
  }

  /**
   * Query-параметры подключения: версия модели сообщений (ADR-118 §8,
   * fail-closed) и точка догона (ADR-118 §6).
   */
  private transportQuery(): string {
    const params = new URLSearchParams()
    params.set(MESSAGE_MODEL_QUERY_PARAM, String(MESSAGE_MODEL_VERSION))
    if (typeof this.since === 'number' && this.since > 0) {
      params.set('since', String(this.since))
    }
    return `?${params.toString()}`
  }

  private connectWS(): void {
    this.cleanupTransport()
    this.transport = 'ws'

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws/events${this.transportQuery()}`
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

          // ADR-118 §3: ack-кадра `queued` больше нет — подтверждение приёма
          // приходит адресным событием `message.accepted` (его разбирает
          // диспетчер стора). Серверный отказ (`error`) — обычное событие
          // транспорта, его обработает диспетчер.

          // ADR-118 §6: номер события — точка догона для переподключения.
          this.noteEventSeq((data as WSEvent).eventSeq)

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

    const url = `/api/v2/events${this.transportQuery()}`
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
          const data = JSON.parse(e.data) as WSEvent
          // ADR-118 §6: SSE-кадр несёт `id:` — номер события в пределах сессии
          // (`EventSource.lastEventId`). Он и есть точка догона: `eventSeq` из
          // тела приоритетнее, `id:` — фоллбек (и он же отдаётся диспетчеру).
          const idSeq = this.parseEventId(e.lastEventId)
          const seq = typeof data.eventSeq === 'number' ? data.eventSeq : idSeq
          this.noteEventSeq(seq)
          this.callbacks.onEvent(
            typeof data.eventSeq === 'number' || seq === undefined ? data : { ...data, eventSeq: seq },
          )
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
