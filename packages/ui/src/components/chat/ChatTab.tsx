import { useEffect, useRef, useCallback } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useTransportStore } from '@/stores/transportStore'
import { useAuthStore } from '@/stores/authStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { useNotification } from '@/hooks/useNotification'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { QueueBanner } from './QueueBanner'
import { DebugModal } from './DebugModal'
import { QueueChips } from './QueueChips'
import { StickyNotesPanel } from './StickyNotesPanel'
import type { CenterTab } from '@/stores/useUIStore'
import { useUIStore } from '@/stores/useUIStore'

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
    stickyNotesBySession,
    summarizationPendingBySession,
    debugModalSessionId,
    debugModalMessageIndex,
    setMessages,
    updateMessage,
    clearQueueState,
    setPendingMessages,
    setStickyNotes,
    setSummarizationPending,
    openDebugModal,
    closeDebugModal,
    setRetryInput,
  } = useChatStore()

  const sessionId = tab.data.sessionId || tab.id
  const messages = messagesBySession[sessionId] || []
  const streams = streamingBySession[sessionId] || {}
  const queue = queueBySession[sessionId]
  const pending = pendingBySession[sessionId] || []
  const stickyNotes = stickyNotesBySession[sessionId] || []
  const streamError = errorBySession[sessionId]
  const summarizationPending = summarizationPendingBySession[sessionId] || false
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
          if (session.sticky_notes) {
            setStickyNotes(sessionId, session.sticky_notes)
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
      const { user, profile } = useAuthStore.getState()
      const author = profile?.display_name || user?.username || ''
      const { activeAgentId } = useAgentsStore.getState()
      const effectiveAgentRole = agentRole || activeAgentId || undefined

      // Сообщение пользователя появляется в чате только когда сервер
      // начинает его обработку (event message.added из QueueProcessor)

      try {
        const { debugSystemMessages } = useUIStore.getState()
        if (debugSystemMessages) {
          await synthApi.sendDebugSystemMessage(sessionId)
        }

        const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
        await useTransportStore.getState().sendMessage(sessionId, text, effectiveAgentRole, selectedProviderName || undefined, selectedModelName || undefined)
        notify({ text: t('chat.message.sent'), type: 'info', category: 'message', sessionId })
      } catch (e) {
        notify({ text: `${t('chat.error.sendFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, notify, t]
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
    async (msg: MessageData) => {
      try {
        const result = await synthApi.toggleMessage(sessionId, msg.index)
        updateMessage(sessionId, msg.index, { disabled: result.disabled })
        notify({
          text: result.disabled ? t('chat.message.disabled') : t('chat.message.enabled'),
          type: 'info',
          category: 'message',
          sessionId,
        })
      } catch {
        notify({ text: t('chat.error.toggleMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, updateMessage, notify, t]
  )

  const handlePin = useCallback(
    async (msg: MessageData) => {
      try {
        const result = await synthApi.pinMessage(sessionId, msg.index)
        updateMessage(sessionId, msg.index, { pinned: result.pinned })
        notify({
          text: result.pinned ? t('chat.message.pinned') : t('chat.message.unpinned'),
          type: 'info',
          category: 'message',
          sessionId,
        })
      } catch {
        notify({ text: t('chat.error.pinMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, updateMessage, notify, t]
  )

  const handleDelete = useCallback(
    async (msg: MessageData) => {
      if (!window.confirm(t('chat.actions.deleteConfirm'))) return
      try {
        await synthApi.deleteMessage(sessionId, msg.index)
        const result = await synthApi.getSessionMessages(sessionId)
        setMessages(sessionId, result.messages)
        notify({ text: t('chat.message.deleted'), type: 'info', category: 'message', sessionId })
      } catch {
        notify({ text: t('chat.error.deleteMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, setMessages, notify, t]
  )

  const handleRetry = useCallback(
    async (msg: MessageData) => {
      if (!window.confirm(t('chat.actions.retryConfirm'))) return
      try {
        const result = await synthApi.retryMessage(sessionId, msg.index)
        const reloadResult = await synthApi.getSessionMessages(sessionId)
        setMessages(sessionId, reloadResult.messages)
        setRetryInput(sessionId, result.content)
        notify({ text: t('chat.message.retrying'), type: 'info', category: 'message', sessionId })
      } catch {
        notify({ text: t('chat.error.retryMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, setMessages, setRetryInput, notify, t]
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

  const handleSummarizeNow = useCallback(async () => {
    try {
      await synthApi.summarizeSession(sessionId)
      setSummarizationPending(sessionId, false)
      notify({ text: t('rightPanel.context.summarizeEnqueued'), type: 'info', category: 'queue', sessionId })
    } catch {
      notify({ text: t('rightPanel.context.summarizeError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setSummarizationPending, notify, t])

  const handleCancelSummarization = useCallback(async () => {
    try {
      await synthApi.cancelSummarization(sessionId)
      setSummarizationPending(sessionId, false)
      notify({ text: t('rightPanel.context.summarizationCancelled'), type: 'info', category: 'system', sessionId })
    } catch {
      // ignore
    }
  }, [sessionId, setSummarizationPending, notify, t])

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

  const handleCreateNote = useCallback(async (text: string) => {
    try {
      const result = await synthApi.addStickyNote(sessionId, text)
      setStickyNotes(sessionId, result.notes)
      notify({ text: t('chat.message.sent'), type: 'info', category: 'message', sessionId })
    } catch {
      notify({ text: t('common.saveError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStickyNotes, notify, t])

  const handleUpdateNote = useCallback(async (noteId: string, content: string) => {
    try {
      const result = await synthApi.updateStickyNote(sessionId, noteId, { content })
      setStickyNotes(sessionId, result.notes)
    } catch {
      notify({ text: t('common.saveError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStickyNotes, notify, t])

  const handleToggleNote = useCallback(async (noteId: string, disabled: boolean) => {
    try {
      const result = await synthApi.updateStickyNote(sessionId, noteId, { disabled })
      setStickyNotes(sessionId, result.notes)
    } catch {
      // ignore
    }
  }, [sessionId, setStickyNotes])

  const handleDeleteNote = useCallback(async (noteId: string) => {
    try {
      const result = await synthApi.deleteStickyNote(sessionId, noteId)
      setStickyNotes(sessionId, result.notes)
    } catch {
      notify({ text: t('common.saveError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStickyNotes, notify, t])

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

      {summarizationPending && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
          <span className="text-xs text-yellow-600 dark:text-yellow-400 flex-1">
            {t('rightPanel.context.summarizationPendingBanner')}
          </span>
          <button
            onClick={handleSummarizeNow}
            className="rounded px-2 py-0.5 text-xs font-medium text-yellow-600 hover:bg-yellow-500/10 transition-colors"
          >
            {t('rightPanel.context.summarizeNow')}
          </button>
          <button
            onClick={handleCancelSummarization}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
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

      {stickyNotes.length > 0 && (
        <StickyNotesPanel
          notes={stickyNotes}
          onUpdate={handleUpdateNote}
          onToggle={handleToggleNote}
          onDelete={handleDeleteNote}
        />
      )}

      <MessageList
        messages={messages}
        streams={streams}
        onCopy={handleCopy}
        onToggle={handleToggle}
        onPin={handlePin}
        onDelete={handleDelete}
        onRetry={handleRetry}
        onDebug={handleDebug}
        onStop={handleStop}
      />

      <ChatInput
        sessionId={sessionId}
        agents={agentsRef.current}
        isStreaming={isStreaming}
        onSend={handleSend}
        onStop={handleStop}
        onCreateNote={handleCreateNote}
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
