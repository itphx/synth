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
const MAX_RECONNECT_DELAY = 30_000
const SEND_TIMEOUT = 10_000

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
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

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

  async sendMessage(sessionId: string, text: string, agentRole?: string, provider?: string, model?: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }
    const streamId = `stream-${++this.counter}-${Date.now()}`
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(streamId)
        reject(new Error('Send timeout'))
      }, SEND_TIMEOUT)
      this.pending.set(streamId, { resolve, reject, timer })
      this.ws!.send(JSON.stringify({
        type: 'send_message',
        session_id: sessionId,
        content: text,
        stream_id: streamId,
        agent_role: agentRole,
        provider,
        model,
      }))
    })
  }

  cancel(sessionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'cancel', session_id: sessionId }))
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

          if (data.type === 'queued' || data.type === 'message_queued') {
            const streamId = (data.stream_id as string) || (data.data?.stream_id as string)
            if (streamId) {
              const pending = this.pending.get(streamId)
              if (pending) {
                clearTimeout(pending.timer)
                pending.resolve()
                this.pending.delete(streamId)
              }
            }
          }

          this.callbacks.onEvent(data as WSEvent)
        } catch {
          // ignore parse errors
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
        } catch {
          // ignore
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
