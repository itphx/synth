import { create } from 'zustand'
import {
  ChatConnection,
  type WSEvent,
} from '@/lib/api/ws'
import { useChatStore } from './chatStore'
import type { TransportMode } from './useUIStore'
import type { StreamDoneMetadata, MessageData } from './chatStore'

type EventDispatcher = (event: WSEvent) => void

interface ConnectionState {
  transportMode: TransportMode
  userConnection: ChatConnection | null
  userConnected: boolean
  sessionConnections: Map<string, ChatConnection>

  setTransportMode: (mode: TransportMode) => void
  connectUserWS: (mode: TransportMode) => void
  disconnectAll: () => void

  ensureSessionConnection: (sessionId: string, mode: TransportMode) => ChatConnection
  releaseSessionConnection: (sessionId: string) => void
  getSessionConnection: (sessionId: string) => ChatConnection | undefined

  subscribeSession: (sessionId: string) => void
  unsubscribeSession: (sessionId: string) => void
}

function createDispatcher(): EventDispatcher {
  return (event: WSEvent) => {
    const type = event.type
    const payload = (event.data || event) as Record<string, unknown>
    const sid = (event.sessionId as string)
      || (event.session_id as string)
      || (payload.session_id as string)
    if (!sid) return

    const {
      addMessage,
      startStream,
      updateStreamChunk,
      finishStream,
      cancelStream,
      addStreamError,
      setQueueStalled,
    } = useChatStore.getState()

    switch (type) {
      case 'message_added':
      case 'message.added': {
        const msg: MessageData = {
          index: payload.message_index as number,
          role: (payload.role as string) || 'assistant',
          content: (payload.content as string) || '',
          agent_role: payload.agent_role as string | undefined,
          author: payload.author as string | undefined,
          model: payload.model as string | undefined,
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }
        addMessage(sid, msg)
        break
      }

      case 'stream_start':
      case 'stream.start': {
        startStream(sid, payload.stream_id as string, (payload.agent_role as string) || null)
        break
      }

      case 'stream_chunk':
      case 'stream.chunk': {
        updateStreamChunk(
          sid,
          payload.stream_id as string,
          (payload.content as string) || '',
          (payload.reasoning as string) || '',
        )
        break
      }

      case 'stream_done':
      case 'stream.done': {
        const metadata: StreamDoneMetadata = {
          model: payload.model as string | undefined,
          content: payload.content as string | undefined,
          usage: payload.usage as StreamDoneMetadata['usage'],
          debug_info: payload.debug_info as Record<string, unknown> | undefined,
          message_index: payload.message_index as number | undefined,
          cancelled: payload.cancelled as boolean | undefined,
          pending_count: payload.pending_count as number | undefined,
        }
        finishStream(sid, payload.stream_id as string, metadata)
        if ((payload.pending_count as number) && (payload.pending_count as number) > 0) {
          setQueueStalled(sid, payload.pending_count as number)
        }
        break
      }

      case 'stream_cancelled':
      case 'stream.cancelled': {
        cancelStream(sid, payload.stream_id as string)
        break
      }

      case 'stream_error':
      case 'stream.error': {
        addStreamError(sid, {
          streamId: payload.stream_id as string,
          error: (payload.error as string) || 'Unknown error',
          errorType: (payload.error_type as string) || 'unknown',
          retryIn: payload.retry_in as number | undefined,
          retryCount: (payload.retry_count as number) || 0,
          maxRetries: (payload.max_retries as number) || 3,
          canRetry: (payload.can_retry as boolean) || false,
          userCanRetry: payload.user_can_retry as boolean | undefined,
        })
        break
      }

      case 'queue_stalled':
      case 'queue.stalled': {
        setQueueStalled(sid, (payload.pending_count as number) || 0)
        break
      }

      case 'question.asked':
      case 'permission.asked': {
        const pendingCount = (payload.pending_count as number) || 0
        if (pendingCount > 0) {
          setQueueStalled(sid, pendingCount)
        }
        break
      }
    }
  }
}

/**
 * Создаёт per-session соединение в зависимости от глобального transportMode.
 * sse:     EventSource для получения событий (onEvent активен).
 * auto/ws: только placeholder — отправка через HTTP POST, события через глобальный WS.
 */
function createSessionConnection(sessionId: string, mode: TransportMode): ChatConnection {
  if (mode === 'sse') {
    const conn = new ChatConnection({
      onEvent: createDispatcher(),
      onConnect: () => {
        console.debug('[ConnectionStore] SSE connected:', sessionId)
      },
      onDisconnect: () => {
        console.debug('[ConnectionStore] SSE disconnected:', sessionId)
      },
      onTransportSwitch: () => {},
    })
    conn.setSessionId(sessionId)
    conn.setForceSSE(true)
    return conn
  }

  // WS/auto: без сетевого соединения, только для трекинга сессий.
  // События приходят через глобальный WS /ws/user (подписка через subscribe).
  // Отправка сообщений — через HTTP POST /prompt.
  const conn = new ChatConnection({
    onEvent: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    onTransportSwitch: () => {},
  })
  conn.setSessionId(sessionId)
  return conn
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  transportMode: 'auto',
  userConnection: null,
  userConnected: false,
  sessionConnections: new Map(),

  setTransportMode: (mode: TransportMode) => {
    const state = get()

    console.debug('[ConnectionStore] Switching transport mode:', state.transportMode, '→', mode)
    set({ transportMode: mode })

    // Закрываем старые соединения
    state.userConnection?.disconnect()
    for (const conn of state.sessionConnections.values()) {
      conn.disconnect()
    }

    if (mode === 'sse') {
      // SSE-режим: per-session SSE с активным onEvent
      const next = new Map<string, ChatConnection>()
      for (const [sid] of state.sessionConnections) {
        const conn = createSessionConnection(sid, mode)
        next.set(sid, conn)
      }
      set({ userConnection: null, userConnected: false, sessionConnections: next })
    } else {
      // auto/ws: глобальный WS для событий + placeholder'ы для трекинга сессий
      const next = new Map<string, ChatConnection>()
      for (const [sid] of state.sessionConnections) {
        const conn = createSessionConnection(sid, mode)
        next.set(sid, conn)
      }
      set({ sessionConnections: next })
      get().connectUserWS(mode)
    }
  },

  connectUserWS: (mode: TransportMode) => {
    if (mode === 'sse') return
    const state = get()
    if (state.userConnection) {
      state.userConnection.disconnect()
    }

    const dispatcher = createDispatcher()

    const conn = new ChatConnection({
      onEvent: dispatcher,
      onConnect: () => {
        set({ userConnected: true })
        console.debug('[ConnectionStore] Global WS connected')
        // Подписываем глобальный WS на все уже открытые сессии
        const sids = get().sessionConnections.keys()
        for (const sid of sids) {
          conn.sendSubscribe(sid)
        }
      },
      onDisconnect: (reason) => {
        set({ userConnected: false })
        console.debug('[ConnectionStore] Global WS disconnected:', reason)
        if (get().transportMode === 'auto') {
          console.debug('[ConnectionStore] Auto-fallback: switching to SSE')
          get().setTransportMode('sse')
        }
      },
      onTransportSwitch: () => {},
    })

    conn.connectGlobal()
    set({ userConnection: conn })
  },

  disconnectAll: () => {
    const state = get()
    state.userConnection?.disconnect()
    for (const conn of state.sessionConnections.values()) {
      conn.disconnect()
    }
    set({
      userConnection: null,
      userConnected: false,
      sessionConnections: new Map(),
    })
  },

  ensureSessionConnection: (sessionId: string, mode: TransportMode): ChatConnection => {
    const state = get()
    const existing = state.sessionConnections.get(sessionId)
    if (existing) return existing

    console.debug('[ConnectionStore] New session connection:', sessionId, mode)
    const conn = createSessionConnection(sessionId, mode)

    const next = new Map(state.sessionConnections)
    next.set(sessionId, conn)
    set({ sessionConnections: next })

    // Подписываем глобальный WS на события этой сессии
    if (mode !== 'sse') {
      state.userConnection?.sendSubscribe(sessionId)
    }

    return conn
  },

  releaseSessionConnection: (sessionId: string): void => {
    const state = get()
    const conn = state.sessionConnections.get(sessionId)
    if (!conn) return

    console.debug('[ConnectionStore] Release session connection:', sessionId)
    conn.disconnect()
    const next = new Map(state.sessionConnections)
    next.delete(sessionId)
    set({ sessionConnections: next })

    // Отписываем глобальный WS от событий этой сессии
    state.userConnection?.sendUnsubscribe(sessionId)
  },

  getSessionConnection: (sessionId: string): ChatConnection | undefined => {
    return get().sessionConnections.get(sessionId)
  },

  subscribeSession: (sessionId: string): void => {
    get().userConnection?.sendSubscribe(sessionId)
  },

  unsubscribeSession: (sessionId: string): void => {
    get().userConnection?.sendUnsubscribe(sessionId)
  },
}))
