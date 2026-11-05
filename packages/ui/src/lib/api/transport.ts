// ADR-118 §3: отправка сообщения идёт через HTTP (`POST /sessions/:id/prompt`),
// поэтому тип `SteerMode` в транспортном слое больше не нужен.
import { MESSAGE_MODEL_QUERY_PARAM, MESSAGE_MODEL_VERSION } from '@itphx/synth-shared/types'

export interface WSEvent {
  type: string
  session_id?: string
  sessionId?: string
  data?: Record<string, unknown>
  /** ADR-118 §6: глобальный номер события (в пределах инстанса) — основа догона (`since`). */
  eventSeq?: number
}

export type TransportKind = 'ws' | 'sse' | 'disconnected'

/**
 * Причина обрыва соединения. `network` — сокет закрылся/ошибка, `heartbeat` —
 * не пришло ни одного кадра за watchdog-окно, `restart` — принудительный
 * перезапуск из UI, `manual` — штатное закрытие (выход из аккаунта),
 * `auth` — сервер отклонил соединение (например, `1008`).
 */
export type TransportDisconnectReason = 'network' | 'heartbeat' | 'restart' | 'manual' | 'auth'

export interface TransportClientCallbacks {
  onEvent: (event: WSEvent) => void
  onConnect?: () => void
  /** Причина — известные значения `TransportDisconnectReason` (тип `string` для совместимости). */
  onDisconnect?: (reason: string) => void
  onTransportSwitch?: (transport: TransportKind) => void
  onBackendReady?: () => void
}

const HEARTBEAT_INTERVAL = 25_000
/** Сколько сокет может висеть в CONNECTING: дольше — рукопожатие считаем сбойным. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Сколько соединение может молчать (ни одного кадра, включая `pong`), прежде чем считаться мёртвым. */
const PONG_TIMEOUT_MS = 30_000
/** Период проверки watchdog'а (и отправки `ping`, когда пора). */
const PONG_CHECK_INTERVAL = 5_000
const INITIAL_RECONNECT_DELAY = 1_000
/** Потолок backoff, когда приложение на экране и сеть есть — переподключение быстрое. */
const MAX_RECONNECT_DELAY_VISIBLE = 5_000
/** Потолок backoff в фоне/без сети — редкие попытки, чтобы не будить устройство. */
const MAX_RECONNECT_DELAY_HIDDEN = 60_000
/**
 * Простой, после которого соединение считается «зомби» (PWA вернулась из фона,
 * сеть давно ушла): `resume()` пересоздаёт транспорт, не дожидаясь backoff.
 */
const RESUME_IDLE_TIMEOUT_MS = 90_000
/** `readyState === OPEN` у WebSocket и EventSource (по спецификации = 1). */
const SOCKET_OPEN = 1

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
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private intentionalClose = false
  private backendReady = false
  /** ADR-118 §6: номер последнего виденного события — точка догона (`since`). */
  private since: number | undefined
  /** Время последней активности соединения (открытие/кадр) — детект «зомби». */
  private lastActivityAt = 0
  /** Слушатели жизненного цикла (снимаются в `disconnect`, не в cleanup). */
  private lifecycleAttached = false
  private readonly onOnline = () => this.resume()
  private readonly onPageShow = () => this.resume()
  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.resume()
  }

  constructor(callbacks: TransportClientCallbacks) {
    this.callbacks = callbacks
    this.attachLifecycle()
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

  disconnect(reason: TransportDisconnectReason = 'manual'): void {
    this.intentionalClose = true
    this.detachLifecycle()
    this.cleanupTransport()
    this.transport = 'disconnected'
    this.backendReady = false
    this.callbacks.onDisconnect?.(reason)
  }

  getTransport(): TransportKind {
    return this.transport
  }

  isBackendReady(): boolean {
    return this.backendReady
  }

  /**
   * Разбудить транспорт после возврата приложения из фона (`online`,
   * `pageshow`, `visibilitychange`).
   *
   * EventSource может выглядеть открытым, но быть «зомби» (соединение давно
   * мертво, браузер ещё не увидел ошибку) — поэтому одного `readyState`
   * недостаточно: соединение без активности дольше `RESUME_IDLE_TIMEOUT_MS`
   * пересоздаётся принудительно, в обход накопленного backoff.
   */
  resume(): void {
    if (this.intentionalClose) return
    // Между попытками стоит backoff-таймер — повод (online/visibility/pageshow)
    // важнее расписания: переподключаемся сразу, не выжидая задержку.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.reconnectAttempts = 0
      if (this.transport === 'sse') this.connectSSE()
      else this.connectWS()
      return
    }
    const idle = Date.now() - this.lastActivityAt > RESUME_IDLE_TIMEOUT_MS
    if (this.transport === 'sse') {
      if (!this.sseSource || this.sseSource.readyState !== SOCKET_OPEN || idle) {
        this.reconnectAttempts = 0
        this.connectSSE()
      }
      return
    }
    if (this.transport === 'ws') {
      if (!this.ws || this.ws.readyState !== SOCKET_OPEN || idle) {
        this.reconnectAttempts = 0
        this.connectWS()
      }
    }
  }

  /**
   * Слушатели жизненного цикла вешаются один раз в конструкторе и снимаются
   * только в `disconnect()`. `cleanupTransport()` (вызывается при каждом
   * реконнекте) их не трогает — иначе после первого же переподключения
   * приложение перестало бы замечать возврат из фона.
   */
  private attachLifecycle(): void {
    if (this.lifecycleAttached) return
    if (typeof window === 'undefined') return
    window.addEventListener('online', this.onOnline)
    window.addEventListener('pageshow', this.onPageShow)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.lifecycleAttached = true
  }

  private detachLifecycle(): void {
    if (!this.lifecycleAttached) return
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('pageshow', this.onPageShow)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.lifecycleAttached = false
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
      const socket = this.ws

      // Зависший CONNECTING раньше жил до браузерного таймаута (минуты).
      // 10 с без OPEN — считаем сетевой ошибкой и переподключаемся по backoff.
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null
        if (this.intentionalClose || this.ws !== socket) return
        if (socket.readyState === SOCKET_OPEN) return
        console.debug('[WS] Handshake timeout')
        this.cleanupTransport()
        this.backendReady = false
        this.callbacks.onDisconnect?.('network')
        this.scheduleReconnect()
      }, HANDSHAKE_TIMEOUT_MS)

      this.ws.onopen = () => {
        console.debug('[WS] Connected')
        this.clearHandshakeTimer()
        this.lastActivityAt = Date.now()
        this.reconnectAttempts = 0
        this.transport = 'ws'
        this.startHeartbeat()
        this.backendReady = false
        this.callbacks.onTransportSwitch?.('ws')
        this.callbacks.onConnect?.()
      }

      this.ws.onclose = (e) => {
        console.debug('[WS] Closed: code=', e.code, 'reason=', e.reason, 'wasClean=', e.wasClean)
        this.clearHandshakeTimer()
        this.stopHeartbeat()
        if (!this.intentionalClose) {
          // 1008 (policy violation) — сервер отклонил клиент (в т.ч. версия
          // модели сообщений/аутентификация): отдельная причина, чтобы UI не
          // считал это обычной сетевой потерей.
          this.callbacks.onDisconnect?.(e.code === 1008 ? 'auth' : 'network')
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (e) => {
        console.debug('[WS] Error:', e)
      }

      this.ws.onmessage = (e) => {
        try {
          // Любой кадр (включая `pong`) — признак живой связи.
          this.lastActivityAt = Date.now()
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
        this.lastActivityAt = Date.now()
        this.reconnectAttempts = 0
        this.transport = 'sse'
        this.callbacks.onTransportSwitch?.('sse')
        this.callbacks.onConnect?.()
      }

      this.sseSource.onmessage = (e) => {
        try {
          // Любой кадр — признак живой связи (детект «зомби» на возврате из фона).
          this.lastActivityAt = Date.now()
          const data = JSON.parse(e.data) as WSEvent
          // ADR-118 §6: SSE-кадр несёт `id:` — глобальный номер события
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
          this.callbacks.onDisconnect?.('network')
          this.scheduleReconnect()
        }
      }
    } catch {
      console.debug('[SSE] Failed to create EventSource')
      this.scheduleReconnect()
    }
  }

  /**
   * Потолок backoff: на экране и с сетью — 5 с (переподключение почти
   * незаметно), в фоне/без сети — 60 с (не будим устройство зря).
   */
  private reconnectDelay(attempt: number): number {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    const online = typeof navigator === 'undefined' || navigator.onLine !== false
    const cap = visible && online ? MAX_RECONNECT_DELAY_VISIBLE : MAX_RECONNECT_DELAY_HIDDEN
    return Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, attempt), cap)
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return
    const kind = this.transport
    const delay = this.reconnectDelay(this.reconnectAttempts)
    this.reconnectAttempts++
    console.debug('[Transport] Reconnect in', delay, 'ms (attempt', this.reconnectAttempts, ')')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (kind === 'sse') {
        this.connectSSE()
      } else {
        this.connectWS()
      }
    }, delay)
  }

  /**
   * Watchdog: за `PONG_TIMEOUT_MS` не пришло **ни одного** кадра (включая
   * `pong`) — соединение мёртвое. Закрываем сокет и переподключаемся сразу,
   * не дожидаясь, пока браузер заметит обрыв.
   */
  private handleHeartbeatTimeout(): void {
    if (this.intentionalClose || this.transport !== 'ws') return
    console.debug('[WS] No frames for', PONG_TIMEOUT_MS, 'ms — reconnecting')
    // Снимаем обработчики сокета ДО close(), иначе onclose даст второй обрыв.
    this.cleanupTransport()
    this.backendReady = false
    this.callbacks.onDisconnect?.('heartbeat')
    // Стор мог переключить транспорт (auto-fallback WS→SSE) — тогда этот клиент
    // больше не нужен и второй сокет поднимать нельзя.
    if (this.intentionalClose) return
    this.reconnectAttempts = 0
    this.connectWS()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const idle = Date.now() - this.lastActivityAt
      if (idle > PONG_TIMEOUT_MS) {
        this.handleHeartbeatTimeout()
        return
      }
      // Пинг шлём, только если давно не было активности (pong обновляет её).
      if (idle >= HEARTBEAT_INTERVAL) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, PONG_CHECK_INTERVAL)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private cleanupTransport(): void {
    this.stopHeartbeat()
    this.clearHandshakeTimer()
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
