import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTransportStore } from '@/stores/transportStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { useNotification } from '@/hooks/useNotification'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'
import { confirm } from '@/lib/confirm'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { DebugModal } from './DebugModal'
import { QueuePanel } from './QueuePanel'
import { PermissionRequestBar } from './PermissionRequestBar'
import { StickyNotesPanel } from './StickyNotesPanel'
import { StreamErrorPanel } from './StreamErrorPanel'
import { SubagentResumeBar, type SubagentSessionError } from './SubagentResumeBar'
import type { CenterTab } from '@/stores/useUIStore'
import { useUIStore } from '@/stores/useUIStore'

interface ChatTabProps {
  tab: CenterTab
}

export function ChatTab({ tab }: ChatTabProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  // Фаза 4: на touch подписка на visualViewport → --kb-inset → отступ композера.
  // На десктопе/без visualViewport — no-op (переменная 0).
  useKeyboardInset()
  const {
    messagesBySession,
    streamingBySession,
    queueBySession,
    pendingBySession,
    retryBySession,
    finalErrorBySession,
    stickyNotesBySession,
    summarizationPendingBySession,
    debugModalSessionId,
    debugModalMessageIndex,
    setMessages,
    updateMessage,
    clearQueueState,
    resetQueueStalled,
    updateQueueCount,
    setPendingMessages,
    setStickyNotes,
    setSummarizationPending,
    openDebugModal,
    closeDebugModal,
    setRetryInput,
    setStreamRetry,
    setStreamRetrying,
  } = useChatStore()

  const sessionId = tab.data.sessionId || tab.id
  const messages = messagesBySession[sessionId] || []
  const streams = streamingBySession[sessionId] || {}
  const queue = queueBySession[sessionId]
  const pending = pendingBySession[sessionId] || []
  const stickyNotes = stickyNotesBySession[sessionId] || []
  const streamRetry = retryBySession[sessionId]
  const summarizationPending = summarizationPendingBySession[sessionId] || false
  const finalError = finalErrorBySession[sessionId] || null
  const isStreaming = Object.values(streams).some((s) => s.isStreaming)
  const hasActiveStream = Object.values(streams).some((s) => s.isStreaming)
  const isEmpty = messages.length === 0 && !hasActiveStream && pending.length === 0 && !summarizationPending
  const debugMessage = debugModalSessionId && debugModalMessageIndex != null
    ? messages.find((m) => m.index === debugModalMessageIndex) ?? null
    : null

  // B8: последнее сообщение дочерней сессии — ошибка провайдера → плашка «Продолжить»
  const lastSessionError = useMemo<SubagentSessionError | null>(() => {
    const last = messages[messages.length - 1]
    if (!last || !(last.role === 'error' || last.metadata?.error === true)) return null
    return {
      attempts: last.metadata?.attempts as number | undefined,
      maxRetries: last.metadata?.max_retries as number | undefined,
      errorType: last.metadata?.error_type as string | undefined,
      error: (last.metadata?.error as string) || last.content,
    }
  }, [messages])

  const selectionState = useChatStore(s => s.selectionBySession[sessionId])
  const selectionMode = selectionState?.mode ?? false
  const selectedIndices = selectionState?.indices ?? new Set<number>()

  const [sessionOrigin, setSessionOrigin] = useState<string | null>(null)
  const isSubagent = sessionOrigin === 'subagent'
  const isReadOnly = isSubagent
  const [inputExpanded, setInputExpanded] = useState(false)

  const agentsRef = useRef<AgentInfo[]>([])
  const forkingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // Загружаем сообщения — нужно первым
        const result = await synthApi.getSessionMessages(sessionId)
        if (cancelled) return
        setMessages(sessionId, result.messages)

        // Агенты и данные сессии параллельно (независимы друг от друга)
        const [agentsResp, session] = await Promise.all([
          synthApi.getAgents(sessionId),
          synthApi.getSession(sessionId).catch(() => null),
        ])
        if (cancelled) return

        if (agentsResp) agentsRef.current = agentsResp.agents

        if (session) {
          // Кладём актуальные данные сессии (включая mode) в стор —
          // иначе PlanActModeToggle не увидит mode и покажет дефолт 'act'.
          useSessionsStore.getState().upsertSession(session)
          const s = session?.settings as Record<string, unknown> | undefined
          if (s) {
            const { setSelectedProvider, setSelectedModel } = useProvidersStore.getState()
            const { setActiveAgentId } = useAgentsStore.getState()
            if (typeof s.provider === 'string') setSelectedProvider(s.provider)
            if (typeof s.model === 'string') setSelectedModel(s.model)
            if (typeof s.agent_role === 'string') setActiveAgentId(s.agent_role)
          }
          const sessData = session as unknown as Record<string, unknown>
          setSessionOrigin((sessData.session_origin as string) || null)
          const pendingMsgs = sessData.pending_messages as MessageData[] | undefined
          if (pendingMsgs && pendingMsgs.length > 0) {
            const hasActiveStream = sessData.current_stream != null
              || Object.values(streamingBySession[sessionId] || {}).some((s) => s.isStreaming)
            const displayMsgs = hasActiveStream ? pendingMsgs.slice(1) : pendingMsgs
            if (displayMsgs.length > 0) {
              setPendingMessages(sessionId, displayMsgs.map((pm) => ({
                content: pm.content,
                agentRole: pm.agent_role || null,
              })))
              updateQueueCount(sessionId, displayMsgs.length)
            }
          }
          if (session.sticky_notes) {
            setStickyNotes(sessionId, session.sticky_notes)
          }
          resetQueueStalled(sessionId)
        }
      } catch {
        if (!cancelled) {
          notify({ text: t('chat.error.loadSession'), type: 'error', category: 'error', sessionId })
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [sessionId])

  const handleFork = useCallback(
    async (msg: MessageData) => {
      if (forkingRef.current) return
      forkingRef.current = true
      try {
        const fork = await useSessionsStore.getState().forkSession(sessionId, {
          message_id: msg.id || undefined,
          message_index: msg.index,
        })
        if (fork) {
          notify({ text: t('chat.message.forked'), type: 'info', category: 'message', sessionId })
          useUIStore.getState().openTab({
            id: `chat-${fork.id}`,
            type: 'chat' as const,
            title: fork.name || fork.id,
            data: { sessionId: fork.id, projectId: fork.project_id || undefined },
          })
          if (msg.role === 'user' && msg.content) {
            useChatStore.getState().setRetryInput(fork.id, msg.content)
          }
        }
      } catch (e) {
        notify({ text: `${t('chat.error.forkFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
      } finally {
        forkingRef.current = false
      }
    },
    [sessionId, notify, t]
  )

  const handleSend = useCallback(
    async (text: string, agentRole?: string) => {
      const { activeAgentId, defaultAgentId } = useAgentsStore.getState()
      const effectiveAgentRole = agentRole || activeAgentId || defaultAgentId || undefined

      // Сообщение пользователя появляется в чате только когда сервер
      // начинает его обработку (event message.added из QueueProcessor)

      try {
        const { debugSystemMessages } = useUIStore.getState()
        if (debugSystemMessages) {
          await synthApi.sendDebugSystemMessage(sessionId)
        }

        const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
        useChatStore.getState().clearStreamError(sessionId)
        useChatStore.getState().setStreamRetry(sessionId, null)
        await useTransportStore.getState().sendMessage(sessionId, text, effectiveAgentRole, selectedProviderName || undefined, selectedModelName || undefined)
        notify({ text: t('chat.message.sent'), type: 'info', category: 'message', sessionId })
      } catch (e) {
        notify({ text: `${t('chat.error.sendFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, notify, t]
  )

  const handleStop = useCallback(async () => {
    // Во время ретрая «Стоп» = отмена повторных попыток (иначе abort оставит
    // pending-сообщение и сессия зависнет до queue.stalled).
    const retry = useChatStore.getState().retryBySession[sessionId]
    if (retry) {
      try {
        await synthApi.cancelQueueRetry(sessionId)
        setStreamRetry(sessionId, null)
      } catch {
        // ignore
      }
      return
    }
    try {
      useTransportStore.getState().cancel(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId, setStreamRetry])

  const handleRetryNow = useCallback(async () => {
    try {
      await synthApi.retryQueueNow(sessionId)
      // Стрим снова «работает»: статус ретрая снимем по следующему
      // stream.retry (если снова упадёт) или stream.done (если получится).
      setStreamRetrying(sessionId, streamRetry?.streamId || '', false)
    } catch {
      notify({ text: t('chat.error.retryNow'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, streamRetry, setStreamRetrying, notify, t])

  const handleCancelRetry = useCallback(async () => {
    try {
      await synthApi.cancelQueueRetry(sessionId)
      setStreamRetry(sessionId, null)
    } catch {
      notify({ text: t('chat.error.cancelRetry'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStreamRetry, notify, t])

  // B6: повторная отправка последнего user-сообщения, упавшего с финальной ошибкой.
  // Существующий POST /messages/:sid/:idx/retry не re-enqueue (он отключает сообщения
  // и возвращает текст в input), поэтому композиция из существующих эндпоинтов:
  // disable «упавшего» сообщения (не дублируем его в контексте) → повторная отправка
  // его текста через prompt (сообщение встаёт в очередь заново).
  const handleRetryLastFailed = useCallback(async () => {
    const msgs = useChatStore.getState().messagesBySession[sessionId] || []
    const lastFailed = [...msgs].reverse().find(
      (m) => m.role === 'user' && m.metadata?.last_error,
    )
    if (!lastFailed) {
      useChatStore.getState().setFinalStreamError(sessionId, null)
      return
    }
    try {
      if (lastFailed.disabled === false) {
        await synthApi.toggleMessage(sessionId, lastFailed.index)
      }
      const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
      await synthApi.enqueueMessage(sessionId, lastFailed.content, {
        agentRole: lastFailed.agent_role || undefined,
        provider: selectedProviderName || lastFailed.provider || undefined,
        model: selectedModelName || lastFailed.model || undefined,
      })
      useChatStore.getState().setFinalStreamError(sessionId, null)
      notify({ text: t('chat.streamError.retrySent'), type: 'info', category: 'message', sessionId })
    } catch (e) {
      notify({ text: `${t('chat.error.retryLast')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  // B8: возобновление дочерней сессии (плашка в дочерней сессии)
  const handleResumeSubagent = useCallback(async () => {
    try {
      await synthApi.resumeSubagent(sessionId)
      // Состояние «Возобновление…» придёт событием subagent.resume.started
    } catch (e) {
      notify({ text: `${t('chat.subagent.resumeFailed')}: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  const handleStopSubagentResume = useCallback(async () => {
    try {
      await synthApi.stopGeneration(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleStopAll = useCallback(async () => {
    try {
      useTransportStore.getState().cancel(sessionId)
      await synthApi.clearQueue(sessionId)
      clearQueueState(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId, clearQueueState])

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
      const ok = await confirm({ title: t('chat.actions.deleteConfirm'), variant: 'danger' })
      if (!ok) return
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
      const ok = await confirm({ title: t('chat.actions.retryConfirm'), variant: 'warning' })
      if (!ok) return
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
        setRetryInput(sessionId, data.texts.join('\n\n'))
        setPendingMessages(sessionId, [])
        clearQueueState(sessionId)
        notify({ text: t('chat.queue.returned'), type: 'success', category: 'queue', sessionId })
      } else {
        notify({ text: t('chat.queue.empty'), type: 'info', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, setPendingMessages, clearQueueState, setRetryInput, notify, t])

  const handleReturnMsg = useCallback(async (uiIndex: number) => {
    try {
      const resp = await synthApi.returnQueue(sessionId, uiIndex)
      const data = resp as { texts?: string[] }
      if (data?.texts && data.texts.length > 0) {
        setRetryInput(sessionId, data.texts[0])
        const cur = useChatStore.getState().pendingBySession[sessionId] || []
        setPendingMessages(sessionId, cur.filter((_, i) => i !== uiIndex))
        const qs = useChatStore.getState().queueBySession[sessionId]
        if (qs && qs.pendingCount > 0) {
          if (qs.pendingCount <= 1) {
            useChatStore.getState().clearQueueState(sessionId)
          } else {
            useChatStore.getState().updateQueueCount(sessionId, qs.pendingCount - 1)
          }
        }
        notify({ text: t('chat.queue.returned'), type: 'success', category: 'queue', sessionId })
      } else {
        notify({ text: t('chat.queue.empty'), type: 'info', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, setPendingMessages, setRetryInput, notify, t])

  // --- Selection mode handlers ---

  const handleToggleSelect = useCallback((index: number) => {
    useChatStore.getState().toggleMessageSelection(sessionId, index)
  }, [sessionId])

  const handleSelectRange = useCallback((from: number, to: number) => {
    useChatStore.getState().selectMessageRange(sessionId, from, to)
  }, [sessionId])

  // --- Forward confirm ---

  const handleForwardConfirm = useCallback(async (targetSessionId: string, position: 'after' | 'before', summarize: boolean) => {
    const fm = useUIStore.getState().forwardMode
    if (!fm.active || !fm.sourceSessionId) return

    try {
      if (fm.mode === 'forward') {
        const sorted = [...fm.sourceIndices].sort((a, b) => a - b)
        const msgs = messagesBySession[sessionId] || []
        const selectedMsgs = sorted.map(i => msgs[i]).filter(Boolean)
        if (selectedMsgs.length === 0) return
        const lastSelected = selectedMsgs[selectedMsgs.length - 1]
        // Use seq numbers, not indices
        const fromSeq = selectedMsgs[0].seq ?? sorted[0] + 1
        const toSeq = lastSelected.role === 'user' && selectedMsgs.length > 1
          ? selectedMsgs[selectedMsgs.length - 2].seq ?? sorted[sorted.length - 2] + 1
          : lastSelected.seq ?? sorted[sorted.length - 1] + 1

        await synthApi.mergeMessages(targetSessionId, sessionId, {
          sourceRange: [fromSeq, toSeq],
          position,
        })

        if (lastSelected.role === 'user') {
          useChatStore.getState().setRetryInput(targetSessionId, lastSelected.content)
        }

        notify({ text: `Сообщения скопированы в сессию`, type: 'success', category: 'message', sessionId })
      } else {
        await synthApi.addSessionReference(targetSessionId, sessionId, {
          messageRange: [1, messages.length || 9999],
          position,
          autoSummarize: summarize,
        })
        notify({ text: `Ссылка на сессию добавлена`, type: 'success', category: 'message', sessionId })
      }

      useUIStore.getState().cancelForwardMode()
    } catch (e) {
      notify({ text: `Ошибка: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, messagesBySession, messages.length, notify])

  // Register forward confirm handler in UIStore
  useEffect(() => {
    useUIStore.getState().forwardConfirmAction = handleForwardConfirm
    return () => {
      const state = useUIStore.getState()
      if (state.forwardConfirmAction === handleForwardConfirm) {
        state.forwardConfirmAction = null
      }
    }
  }, [handleForwardConfirm])

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
      {summarizationPending && !isSubagent && (
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

      {stickyNotes.length > 0 && (
        <StickyNotesPanel
          notes={stickyNotes}
          onUpdate={handleUpdateNote}
          onToggle={handleToggleNote}
          onDelete={handleDeleteNote}
        />
      )}

      {isEmpty && !isSubagent ? (
        <div className="flex flex-1 items-center justify-center">
          <ChatInput
            sessionId={sessionId}
            agents={agentsRef.current}
            isStreaming={isStreaming}
            onSend={handleSend}
            onStop={handleStop}
            onStopQueue={handleStopAll}
            onCreateNote={handleCreateNote}
            expanded={false}
            onToggleExpand={() => setInputExpanded((v) => !v)}
          />
        </div>
      ) : (
        <>
          {!inputExpanded && (
            <MessageList
              messages={messages}
              streams={streams}
              onCopy={handleCopy}
              onToggle={handleToggle}
              onPin={handlePin}
              onDelete={handleDelete}
              onRetry={handleRetry}
              onDebug={handleDebug}
              onFork={handleFork}
              readOnly={isReadOnly}
              onStop={handleStop}
              isSubagent={isSubagent}
              selectionMode={selectionMode}
              selectedIndices={selectedIndices}
              onToggleSelect={handleToggleSelect}
              onSelectRange={handleSelectRange}
              retry={streamRetry}
              onRetryNow={handleRetryNow}
              onCancelRetry={handleCancelRetry}
            />
          )}

          {!inputExpanded && !isSubagent && finalError && (
            <StreamErrorPanel
              error={finalError.error}
              errorType={finalError.errorType}
              onRetry={handleRetryLastFailed}
            />
          )}

          {!inputExpanded && !isSubagent && (
            <QueuePanel
              pending={pending}
              isStalled={queue?.isStalled ?? false}
              pendingCount={queue?.pendingCount ?? 0}
              onResume={handleResumeQueue}
              onClear={handleClearQueue}
              onReturnAll={handleReturnQueue}
              onReturnMsg={handleReturnMsg}
            />
          )}

          {!inputExpanded && !isSubagent && (
            <PermissionRequestBar sessionId={sessionId} />
          )}

          {isSubagent ? (
            <>
              <SubagentResumeBar
                sessionId={sessionId}
                lastError={lastSessionError}
                onResume={handleResumeSubagent}
                onStop={handleStopSubagentResume}
              />
              <div className="shrink-0 mx-auto mt-2 mb-2 w-4/5 rounded-xl border border-border/60 bg-surface-subtle px-4 py-3 text-center">
                <p className="text-xs text-muted-foreground">{t('chat.input.readOnly')}</p>
              </div>
            </>
          ) : (
            <ChatInput
              sessionId={sessionId}
              agents={agentsRef.current}
              isStreaming={isStreaming}
              onSend={handleSend}
              onStop={handleStop}
              onStopQueue={handleStopAll}
              onCreateNote={handleCreateNote}
              expanded={inputExpanded}
              onToggleExpand={() => setInputExpanded((v) => !v)}
            />
          )}
        </>
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
