export interface WSEvent {
  type: string
  session_id?: string
  sessionId?: string
  data?: Record<string, unknown>
}

export type TransportKind = 'ws' | 'sse' | 'disconnected'

export interface ChatConnectionCallbacks {
  onEvent: (event: WSEvent) => void
  onConnect?: () => void
  onDisconnect?: (reason: string) => void
  onTransportSwitch?: (transport: TransportKind) => void
}

const HEARTBEAT_INTERVAL = 25_000
const INITIAL_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 30_000
const SEND_TIMEOUT = 10_000
const MAX_SSE_FAILURES = 3

export class ChatConnection {
  private sessionId: string | null = null
  private ws: WebSocket | null = null
  private sseSource: EventSource | null = null
  private transport: TransportKind = 'disconnected'
  private callbacks: ChatConnectionCallbacks
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private sseFailCount = 0
  private forceSSE = false
  private manualSSE = false
  private intentionalClose = false
  private pendingSends: Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map()
  private streamIdCounter = 0
  private globalMode = false
  private eventsWanted = true

  constructor(callbacks: ChatConnectionCallbacks) {
    this.callbacks = callbacks
  }

  connect(sessionId: string, opts?: { events?: boolean }): void {
    this.sessionId = sessionId
    this.globalMode = false
    this.eventsWanted = opts?.events !== false
    this.intentionalClose = false
    this.connectWS()
  }

  setSessionId(id: string): void {
    this.sessionId = id
  }

  connectGlobal(): void {
    this.globalMode = true
    this.eventsWanted = true
    this.sessionId = null
    this.intentionalClose = false
    this.connectWS()
  }

  disconnect(): void {
    this.intentionalClose = true
    this.cleanup()
    this.transport = 'disconnected'
    this.callbacks.onDisconnect?.('manual')
  }

  getTransport(): TransportKind {
    return this.transport
  }

  setForceSSE(force: boolean): void {
    this.forceSSE = force
    if (force) {
      this.manualSSE = true
      this.callbacks.onTransportSwitch?.('sse')
      this.cleanupTransport()
      this.transport = 'disconnected'
      this.fallbackToSSE()
    } else {
      this.manualSSE = false
      this.cleanupTransport()
      this.transport = 'disconnected'
      this.connectWS()
    }
  }

  async sendMessage(
    content: string,
    agentRole?: string,
    provider?: string,
    model?: string,
  ): Promise<string> {
    const streamId = `stream-${++this.streamIdCounter}-${Date.now()}`
    const message: Record<string, unknown> = {
      type: 'send_message',
      content,
      stream_id: streamId,
      stream: true,
      agent_role: agentRole,
      provider,
      model,
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingSends.delete(streamId)
          reject(new Error('Send timeout'))
        }, SEND_TIMEOUT)
        this.pendingSends.set(streamId, { resolve: () => resolve(streamId), reject, timer })
        this.ws!.send(JSON.stringify(message))
      })
    }

    return streamId
  }

  cancel(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel' }))
    }
  }

  sendSubscribe(sessionId: string): void {
    if (this.globalMode && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', session_id: sessionId }))
    }
  }

  sendUnsubscribe(sessionId: string): void {
    if (this.globalMode && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', session_id: sessionId }))
    }
  }

  private getWSURL(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = location.host

    if (this.globalMode) {
      return `${protocol}//${host}/ws/user`
    }

    const params = new URLSearchParams({ session_id: this.sessionId! })
    if (!this.eventsWanted) {
      params.set('events', 'false')
    }
    return `${protocol}//${host}/ws/chat?${params.toString()}`
  }

  private connectWS(): void {
    this.cleanupTransport()

    if (this.forceSSE) {
      this.fallbackToSSE()
      return
    }

    if (this.globalMode) {
      // Глобальный режим — нет sessionId для SSE фоллбека
    } else if (!this.sessionId) {
      return
    }

    const url = this.getWSURL()
    console.debug('[WS] Connecting:', url)

    try {
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        console.debug('[WS] Connected', this.globalMode ? '(global)' : '')
        this.reconnectAttempts = 0
        this.sseFailCount = 0
        this.transport = 'ws'
        this.startHeartbeat()
        this.callbacks.onTransportSwitch?.('ws')
        this.callbacks.onConnect?.()
      }

      this.ws.onclose = (e) => {
        console.debug('[WS] Closed:', e.code, e.reason)
        this.stopHeartbeat()
        this.rejectPendingSends(new Error('WebSocket closed'))
        if (!this.intentionalClose) {
          this.callbacks.onDisconnect?.(`WS closed: ${e.code}`)
          if (!this.globalMode) {
            if (this.eventsWanted) {
              this.fallbackToSSE()
            } else {
              this.scheduleReconnect()
            }
          } else {
            this.scheduleReconnect()
          }
        }
      }

      this.ws.onerror = () => {
        console.debug('[WS] Error')
      }

      this.ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.type === 'pong') return

          if (data.type === 'message_queued' || data.type === 'queued') {
            const streamId = data.data?.stream_id || data.stream_id
            if (streamId) {
              const pending = this.pendingSends.get(streamId as string)
              if (pending) {
                clearTimeout(pending.timer)
                pending.resolve()
                this.pendingSends.delete(streamId as string)
              }
            }
          }

          this.callbacks.onEvent(data as WSEvent)
        } catch {
          // ignore parse errors
        }
      }
    } catch {
      if (!this.globalMode && this.eventsWanted) {
        this.fallbackToSSE()
      } else {
        this.scheduleReconnect()
      }
    }
  }

  private fallbackToSSE(): void {
    if (this.globalMode) {
      // Глобальный режим не поддерживает SSE фоллбек
      this.scheduleReconnect()
      return
    }

    if (this.transport === 'sse') return
    this.cleanupTransport()

    if (!this.sessionId) return

    const url = `/api/v2/sessions/${encodeURIComponent(this.sessionId)}/events`
    if (this.manualSSE) {
      console.debug('[SSE] Manually activated:', url)
    } else {
      console.debug('[SSE] Falling back to:', url)
    }

    try {
      this.sseSource = new EventSource(url)

      this.sseSource.onopen = () => {
        console.debug('[SSE] Connected')
        this.reconnectAttempts = 0
        this.sseFailCount = 0
        this.transport = 'sse'
        this.callbacks.onTransportSwitch?.('sse')
        this.callbacks.onConnect?.()
      }

      this.sseSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          this.callbacks.onEvent(data as WSEvent)
        } catch {
          // ignore
        }
      }

      this.sseSource.onerror = () => {
        console.debug('[SSE] Error, failCount:', this.sseFailCount + 1)
        if (!this.intentionalClose) {
          this.sseFailCount++
          if (this.sseFailCount >= MAX_SSE_FAILURES) {
            console.debug('[SSE] Max failures reached, giving up')
            this.transport = 'disconnected'
            this.callbacks.onTransportSwitch?.('disconnected')
            this.callbacks.onDisconnect?.('SSE failed repeatedly')
            return
          }
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
    if (this.forceSSE) {
      this.fallbackToSSE()
      return
    }
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY)
    this.reconnectAttempts++
    console.debug('[WS] Reconnect in', delay, 'ms (attempt', this.reconnectAttempts, ')')
    this.reconnectTimer = setTimeout(() => {
      this.connectWS()
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

  private rejectPendingSends(error: Error): void {
    for (const [, pending] of this.pendingSends) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingSends.clear()
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
  }

  private cleanup(): void {
    this.intentionalClose = true
    this.rejectPendingSends(new Error('Connection closed'))
    this.cleanupTransport()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
