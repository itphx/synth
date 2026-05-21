import { useEffect, useRef, useCallback } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useChatStore, type StreamDoneMetadata, type MessageData } from '@/stores/chatStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { ChatConnection, type WSEvent } from '@/lib/api/ws'
import { useNotification } from '@/hooks/useNotification'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { QueueBanner } from './QueueBanner'
import type { CenterTab } from '@/stores/useUIStore'

interface ChatTabProps {
  tab: CenterTab
}

export function ChatTab({ tab }: ChatTabProps) {
  const { t } = useI18n()
  const { setConnectionStatus, protocolMode } = useUIStore()
  const { notify } = useNotification()
  const {
    messagesBySession,
    streamingBySession,
    queueBySession,
    errorBySession,
    setMessages,
    startStream,
    updateStreamChunk,
    finishStream,
    cancelStream,
    addMessage,
    addStreamError,
    setQueueStalled,
    clearQueueState,
  } = useChatStore()

  const sessionId = tab.data.sessionId || tab.id
  const messages = messagesBySession[sessionId] || []
  const streams = streamingBySession[sessionId] || {}
  const queue = queueBySession[sessionId]
  const streamError = errorBySession[sessionId]
  const isStreaming = Object.values(streams).some((s) => s.isStreaming)

  const connectionRef = useRef<ChatConnection | null>(null)
  const agentsRef = useRef<AgentInfo[]>([])
  const protocolModeRef = useRef(protocolMode[sessionId] || 'ws')
  const initializingRef = useRef(true)
  protocolModeRef.current = protocolMode[sessionId] || 'ws'

  const dispatchEvent = useCallback(
    (event: WSEvent) => {
      const type = event.type
      const payload = (event.data || event) as Record<string, unknown>
      const sid = (payload.session_id as string) || (event.session_id as string) || sessionId

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
          notify({ text: t('chat.stream.cancelled'), type: 'warning', category: 'streaming', sessionId: sid })
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
      }
    },
    [sessionId, addMessage, startStream, updateStreamChunk, finishStream, cancelStream, addStreamError, setQueueStalled, notify, t]
  )

  useEffect(() => {
    const load = async () => {
      try {
        const result = await synthApi.getSessionMessages(sessionId)
        setMessages(sessionId, result.messages)

        const agentsResp = await synthApi.getAgents(sessionId)
        agentsRef.current = agentsResp.agents

        // Загрузить настройки сессии: модель, провайдер, агент, протокол
        try {
          const session = await synthApi.getSession(sessionId)
          const s = session?.settings as Record<string, unknown> | undefined
          if (s) {
            const { setSelectedProvider, setSelectedModel } = useProvidersStore.getState()
            const { setActiveAgentId } = useAgentsStore.getState()
            if (typeof s.provider === 'string') setSelectedProvider(s.provider)
            if (typeof s.model === 'string') setSelectedModel(s.model)
            if (typeof s.agent_role === 'string') setActiveAgentId(s.agent_role)
            if (typeof s.websocket_enabled === 'boolean') {
              useUIStore.setState((prev) => ({
                protocolMode: { ...prev.protocolMode, [sessionId]: s.websocket_enabled ? 'ws' : 'sse' },
              }))
            }
          }
        } catch {
          // session not found or not accessible — use defaults
        }
      } catch {
        notify({ text: t('chat.error.loadSession'), type: 'error', category: 'error', sessionId })
      }
    }
    load()

    // Подавляем тосты первые 3 секунды после монтирования
    initializingRef.current = true
    const initTimer = setTimeout(() => {
      initializingRef.current = false
    }, 3000)

    const conn = new ChatConnection({
      onEvent: dispatchEvent,
      onConnect: () => {
        notify({ text: t('connection.ws'), type: 'success', category: 'connection', sessionId })
      },
      onDisconnect: (reason) => {
        if (!initializingRef.current) {
          notify({ text: `${t('connection.disconnected')}: ${reason}`, type: 'warning', category: 'connection', sessionId })
        }
      },
      onTransportSwitch: (transport) => {
        setConnectionStatus(sessionId, transport)
        if (initializingRef.current) return
        if (transport === 'sse') {
          notify({ text: t('connection.sse'), type: 'warning', category: 'connection', sessionId })
        } else if (transport === 'disconnected') {
          notify({ text: t('connection.disconnected'), type: 'error', category: 'connection', sessionId })
        }
      },
    })
    conn.connect(sessionId)
    connectionRef.current = conn

    return () => {
      clearTimeout(initTimer)
      conn.disconnect()
      connectionRef.current = null
      setConnectionStatus(sessionId, 'disconnected')
    }
  }, [sessionId])

  useEffect(() => {
    const mode = protocolMode[sessionId] || 'ws'
    connectionRef.current?.setForceSSE(mode === 'sse')
  }, [protocolMode[sessionId]])

  const handleSend = useCallback(
    async (text: string, agentRole?: string) => {
      try {
        const conn = connectionRef.current
        const mode = protocolModeRef.current
        const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
        const useSSE = mode === 'sse' || !conn || conn.getTransport() !== 'ws'
        if (!useSSE && conn && conn.getTransport() === 'ws') {
          await conn.sendMessage(text, agentRole, selectedProviderName || undefined, selectedModelName || undefined)
          notify({ text: t('chat.message.sent'), type: 'info', category: 'message', sessionId })
        } else {
          const stream = await synthApi.streamMessage(sessionId, text, {
            agentRole,
            model: selectedModelName || undefined,
            provider: selectedProviderName || undefined,
          })
          if (stream) {
            setConnectionStatus(sessionId, 'sse')
            const reader = stream.getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            const processChunk = async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break

                  buffer += decoder.decode(value, { stream: true })
                  const lines = buffer.split('\n')
                  buffer = lines.pop() || ''

                  for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed || !trimmed.startsWith('data: ')) continue
                    try {
                      const event = JSON.parse(trimmed.slice(6))
                      dispatchEvent(event)
                    } catch {
                      // skip parse errors
                    }
                  }
                }
              } catch {
                // stream ended
              }
            }
            processChunk()
          }
        }
      } catch (e) {
        notify({ text: `${t('chat.error.sendFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, dispatchEvent, notify, setConnectionStatus, t]
  )

  const handleStop = useCallback(async () => {
    try {
      const conn = connectionRef.current
      if (conn) {
        conn.cancel()
      }
      await synthApi.stopGeneration(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleCopy = useCallback(
    (msg: MessageData) => {
      navigator.clipboard.writeText(msg.content).then(() => {
        notify({ text: t('chat.message.copied'), type: 'info', category: 'message', sessionId })
      })
    },
    [notify, t, sessionId]
  )

  const handleToggle = useCallback(
    (_msg: MessageData) => {
      notify({ text: t('common.inDevelopment'), type: 'info', category: 'system', sessionId })
    },
    [notify, t, sessionId]
  )

  const handlePin = useCallback(
    (_msg: MessageData) => {
      notify({ text: t('common.inDevelopment'), type: 'info', category: 'system', sessionId })
    },
    [notify, t, sessionId]
  )

  const handleDelete = useCallback(
    (_msg: MessageData) => {
      notify({ text: t('common.inDevelopment'), type: 'info', category: 'system', sessionId })
    },
    [notify, t, sessionId]
  )

  const handleRetry = useCallback(
    (_msg: MessageData) => {
      notify({ text: t('common.inDevelopment'), type: 'info', category: 'system', sessionId })
    },
    [notify, t, sessionId]
  )

  const handleReturn = useCallback(
    (_msg: MessageData) => {
      notify({ text: t('common.inDevelopment'), type: 'info', category: 'system', sessionId })
    },
    [notify, t, sessionId]
  )

  const handleDebug = useCallback(
    (_msg: MessageData) => {
      notify({ text: t('common.inDevelopment'), type: 'info', category: 'system', sessionId })
    },
    [notify, t, sessionId]
  )

  const handleResumeQueue = useCallback(async () => {
    try {
      await synthApi.resumeQueue(sessionId)
      clearQueueState(sessionId)
      notify({ text: t('chat.queue.resumed'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.resumeQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, clearQueueState, notify, t])

  const handleClearQueue = useCallback(async () => {
    try {
      await synthApi.clearQueue(sessionId)
      clearQueueState(sessionId)
      notify({ text: t('chat.queue.cleared'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.clearQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, clearQueueState, notify, t])

  const handleReturnQueue = useCallback(async () => {
    try {
      notify({ text: t('chat.queue.returnInDev'), type: 'info', category: 'queue', sessionId })
    } catch {
      // ignore
    }
  }, [notify, t, sessionId])

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background w-full">
      {queue && queue.isStalled && queue.pendingCount > 0 && (
        <QueueBanner
          pendingCount={queue.pendingCount}
          onResume={handleResumeQueue}
          onClear={handleClearQueue}
          onReturn={handleReturnQueue}
        />
      )}

      {streamError && streamError.canRetry && streamError.retryIn ? (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
          <span className="text-xs text-yellow-600 dark:text-yellow-400">
            {t('chat.error.rateLimit', { sec: String(streamError.retryIn) })}
            {' '}
            {t('chat.error.retryCount', {
              current: String(streamError.retryCount),
              max: String(streamError.maxRetries),
            })}
          </span>
        </div>
      ) : null}

      <MessageList
        messages={messages}
        streams={streams}
        onCopy={handleCopy}
        onToggle={handleToggle}
        onPin={handlePin}
        onDelete={handleDelete}
        onRetry={handleRetry}
        onReturn={handleReturn}
        onDebug={handleDebug}
      />

      <ChatInput
        sessionId={sessionId}
        agents={agentsRef.current}
        isStreaming={isStreaming}
        onSend={handleSend}
        onStop={handleStop}
      />
    </div>
  )
}
