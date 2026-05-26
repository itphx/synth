import { create } from 'zustand'
import { TransportClient, type WSEvent, type TransportKind } from '@/lib/api/transport'
import { useChatStore } from './chatStore'
import type { TransportMode } from './useUIStore'
import type { StreamDoneMetadata, MessageData } from './chatStore'
import { synthApi } from '@/lib/api/synthApi'

type EventDispatcher = (event: WSEvent) => void

interface TransportState {
  transportMode: TransportMode
  activeTransport: TransportKind
  connected: boolean
  openSessions: Set<string>

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => void
  disconnect: () => void
  setTransportMode: (mode: TransportMode) => void
  sendMessage: (sessionId: string, text: string, agentRole?: string, provider?: string, model?: string) => Promise<void>
  cancel: (sessionId: string) => void
  markSessionOpen: (sid: string) => void
  markSessionClosed: (sid: string) => void
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

let transport: TransportClient | null = null
let transportReady = false

export const useTransportStore = create<TransportState>()((set, get) => ({
  transportMode: 'auto',
  activeTransport: 'disconnected',
  connected: false,
  openSessions: new Set(),

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => {
    transport?.disconnect()
    transport = null
    transportReady = false

    const actualMode = override || (mode === 'sse' ? 'sse' as const : 'ws' as const)
    console.debug('[TransportStore] Connecting:', actualMode, '(mode=', mode, ')')
    const dispatcher = createDispatcher()

    const client = new TransportClient({
      onEvent: dispatcher,
      onConnect: () => {
        if (actualMode === 'sse') {
          transportReady = true
          set({ connected: true, activeTransport: 'sse' })
          console.debug('[TransportStore] Connected (SSE):', client.getTransport())
        } else {
          // WS: сокет открыт, но backend ещё не зарегистрировал клиента
          set({ connected: true })
          console.debug('[TransportStore] WS socket open, waiting for backend ready...')
        }
      },
      onBackendReady: () => {
        transportReady = true
        set({ connected: true, activeTransport: 'ws' })
        console.debug('[TransportStore] Backend ready:', client.getTransport())
      },
      onDisconnect: (reason) => {
        transportReady = false
        transport = null
        set({ connected: false })
        console.debug('[TransportStore] Disconnected:', reason)
        if (get().transportMode === 'auto' && reason !== 'manual') {
          console.debug('[TransportStore] Auto-fallback: switching to SSE')
          get().connect('auto', 'sse')
        }
      },
      onTransportSwitch: () => {},
    })

    client.connect(actualMode)
    transport = client
  },

  disconnect: () => {
    transport?.disconnect()
    transport = null
    transportReady = false
    set({ connected: false, activeTransport: 'disconnected' })
  },

  setTransportMode: (mode: TransportMode) => {
    const state = get()

    console.debug('[TransportStore] Switching mode:', state.transportMode, '→', mode)
    set({ transportMode: mode })
    get().connect(mode)
  },

  sendMessage: async (sessionId, text, agentRole, provider, model) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendMessage via WS:', sessionId)
      await transport.sendMessage(sessionId, text, agentRole, provider, model)
    } else {
      console.debug('[TransportStore] sendMessage via HTTP POST:', sessionId, `(ready=${transportReady}, transport=${transport?.getTransport()})`)
      await synthApi.enqueueMessage(sessionId, text, { agentRole, model, provider })
    }
  },

  cancel: (sessionId) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] cancel via WS:', sessionId)
      transport.cancel(sessionId)
    } else {
      console.debug('[TransportStore] cancel via HTTP POST:', sessionId)
      synthApi.stopGeneration(sessionId).catch(() => {})
    }
  },

  markSessionOpen: (sid) => {
    const next = new Set(get().openSessions)
    next.add(sid)
    set({ openSessions: next })
  },

  markSessionClosed: (sid) => {
    const next = new Set(get().openSessions)
    next.delete(sid)
    set({ openSessions: next })
  },
}))
