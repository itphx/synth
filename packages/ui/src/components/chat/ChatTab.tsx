import { useEffect, useRef, useCallback } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useTransportStore } from '@/stores/transportStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { useNotification } from '@/hooks/useNotification'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { QueueBanner } from './QueueBanner'
import { DebugModal } from './DebugModal'
import { QueueChips } from './QueueChips'
import type { CenterTab } from '@/stores/useUIStore'

interface ChatTabProps {
  tab: CenterTab
}

export function ChatTab({ tab }: ChatTabProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const {
    messagesBySession,
    streamingBySession,
    queueBySession,
    pendingBySession,
    errorBySession,
    debugModalSessionId,
    debugModalMessageIndex,
    setMessages,
    addMessage,
    clearQueueState,
    setPendingMessages,
    openDebugModal,
    closeDebugModal,
  } = useChatStore()

  const sessionId = tab.data.sessionId || tab.id
  const messages = messagesBySession[sessionId] || []
  const streams = streamingBySession[sessionId] || {}
  const queue = queueBySession[sessionId]
  const pending = pendingBySession[sessionId] || []
  const streamError = errorBySession[sessionId]
  const isStreaming = Object.values(streams).some((s) => s.isStreaming)
  const debugMessage = debugModalSessionId && debugModalMessageIndex != null
    ? messages.find((m) => m.index === debugModalMessageIndex) ?? null
    : null

  const agentsRef = useRef<AgentInfo[]>([])

  useEffect(() => {
    const load = async () => {
      try {
        const result = await synthApi.getSessionMessages(sessionId)
        setMessages(sessionId, result.messages)

        const agentsResp = await synthApi.getAgents(sessionId)
        agentsRef.current = agentsResp.agents

        try {
          const session = await synthApi.getSession(sessionId)
          const s = session?.settings as Record<string, unknown> | undefined
          if (s) {
            const { setSelectedProvider, setSelectedModel } = useProvidersStore.getState()
            const { setActiveAgentId } = useAgentsStore.getState()
            if (typeof s.provider === 'string') setSelectedProvider(s.provider)
            if (typeof s.model === 'string') setSelectedModel(s.model)
            if (typeof s.agent_role === 'string') setActiveAgentId(s.agent_role)
          }
          const sessData = session as unknown as Record<string, unknown>
          const pendingMsgs = sessData.pending_messages as MessageData[] | undefined
          if (pendingMsgs && pendingMsgs.length > 0) {
            setPendingMessages(sessionId, pendingMsgs.map((pm) => ({
              content: pm.content,
              agentRole: pm.agent_role || null,
            })))
          }
        } catch {
          // session not found or not accessible — use defaults
        }
      } catch {
        notify({ text: t('chat.error.loadSession'), type: 'error', category: 'error', sessionId })
      }
    }
    load()
  }, [sessionId])

  const handleSend = useCallback(
    async (text: string, agentRole?: string) => {
      addMessage(sessionId, {
        index: messages.length + Object.values(streams).length,
        role: 'user',
        content: text,
        agent_role: agentRole || null,
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: new Date().toISOString(),
      });

      try {
        const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
        await useTransportStore.getState().sendMessage(sessionId, text, agentRole, selectedProviderName || undefined, selectedModelName || undefined)
        notify({ text: t('chat.message.sent'), type: 'info', category: 'message', sessionId })
      } catch (e) {
        notify({ text: `${t('chat.error.sendFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, notify, t, addMessage, messages.length, streams]
  )

  const handleStop = useCallback(async () => {
    try {
      useTransportStore.getState().cancel(sessionId)
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
    async (_msg: MessageData) => {
      try {
        const resp = await synthApi.returnQueue(sessionId)
        const texts = resp as { texts?: string[] } | undefined
        if (texts?.texts && texts.texts.length > 0) {
          setPendingMessages(sessionId, [])
          notify({ text: texts.texts.join('\n'), type: 'info', category: 'queue', sessionId })
        }
      } catch {
        notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
      }
    },
    [sessionId, setPendingMessages, notify, t]
  )

  const handleDebug = useCallback(
    (msg: MessageData) => {
      if (msg.debug_data && Object.keys(msg.debug_data as object).length > 0) {
        openDebugModal(sessionId, msg.index)
      } else {
        notify({ text: t('chat.debug.noData'), type: 'info', category: 'system', sessionId })
      }
    },
    [openDebugModal, notify, t, sessionId]
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
      const resp = await synthApi.returnQueue(sessionId)
      const data = resp as { texts?: string[] }
      if (data?.texts && data.texts.length > 0) {
        setPendingMessages(sessionId, [])
        clearQueueState(sessionId)
        notify({ text: t('chat.queue.returned'), type: 'success', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, setPendingMessages, clearQueueState, notify, t])

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

      {pending.length > 0 && (
        <QueueChips
          pending={pending}
          onClear={handleClearQueue}
          onReturn={handleReturnQueue}
        />
      )}

      {debugMessage?.debug_data && Object.keys(debugMessage.debug_data).length > 0 && (
        <DebugModal
          debug={debugMessage.debug_data as import('@/stores/chatStore').DebugData}
          onClose={closeDebugModal}
        />
      )}
    </div>
  )
}
