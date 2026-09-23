import { cn } from '@/lib/utils'
import { memo } from 'react'
import { MarkdownContent } from './MarkdownContent'
import { SecretMarkdown, SecretPlainText } from './SecretPlaceholder'
import { MessageHeader } from './MessageHeader'
import { MessageActions } from './MessageActions'
import { MessageStats, hasMessageStats } from './MessageStats'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import { SubagentPart, type SubagentPartData } from './SubagentPart'
import { RetryStatus } from './RetryStatus'
import { CommandMessage } from './CommandMessage'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import { useResolveI18n } from '@/lib/i18n'
import type { MessageData, LiveToolCall, ReasoningBlockData, IntermediateTextBlockData, StreamRetry } from '@/stores/chatStore'
import { synthApi } from '@/lib/api/synthApi'
import { useCallback, useMemo } from 'react'
import { Icon } from '@/components/icon/Icon'

function useToolCallData(toolCalls: MessageData['tool_calls']) {
  return useMemo(() => {
    if (!toolCalls || toolCalls.length === 0) return []
    return toolCalls.map((tc) => ({
      callId: tc.id || `tc_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.name,
      args: tc.args,
      status: 'done' as const,
      result: tc.result,
      startedAt: tc.started_at || '',
      completedAt: tc.completed_at,
      iteration: tc.iteration || 0,
      parentCallId: undefined,
    }))
  }, [toolCalls])
}

function getReasoningBlocks(message: MessageData): ReasoningBlockData[] {
  if (message.reasoning_blocks && message.reasoning_blocks.length > 0) {
    return message.reasoning_blocks
  }
  if (message.reasoning) {
    return message.reasoning.split('\n\n---\n\n').map((text, i) => ({ text, iteration: i }))
  }
  return []
}

function getIntermediateTextBlocks(message: MessageData): IntermediateTextBlockData[] {
  if (message.intermediate_text_blocks && message.intermediate_text_blocks.length > 0) {
    return message.intermediate_text_blocks
  }
  const fromMetadata = message.metadata?.intermediate_text_blocks as IntermediateTextBlockData[] | undefined
  if (fromMetadata && fromMetadata.length > 0) {
    return fromMetadata
  }
  return []
}

interface ChatMessageProps {
  message: MessageData
  // Колбэки принимают сообщение/индекс: MessageList передаёт стабильные ссылки,
  // а ChatMessage связывает их с конкретным сообщением внутри (см. useCallback ниже).
  // Это нужно, чтобы React.memo(ChatMessage) сравнивал пропсы по ссылке.
  onCopy: (msg: MessageData) => void
  onToggle: (msg: MessageData) => void
  onPin: (msg: MessageData) => void
  onDelete: (msg: MessageData) => void
  onRetry: (msg: MessageData) => void
  onDebug: (msg: MessageData) => void
  onFork: (msg: MessageData) => void
  readOnly?: boolean
  /** true если сессия — дочерняя (сабагент) */
  isSubagent?: boolean
  selectionMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (index: number, shiftKey: boolean) => void
  /**
   * Статус активного стрима, связанного с этим user-сообщением (по metadata.stream_id),
   * пока провайдер ещё не вернул ни одного чанка. null — статус не показываем.
   */
  pending?: PendingStreamStatus | null
}

export interface PendingStreamStatus {
  status: 'processing' | 'retrying'
  retry?: StreamRetry | null
  onRetryNow?: () => void
  onCancelRetry?: () => void
}

function ChatMessageInner({
  message,
  onCopy,
  onToggle,
  onPin,
  onDelete,
  onRetry,
  onDebug,
  onFork,
  readOnly,
  isSubagent,
  selectionMode,
  isSelected,
  onToggleSelect,
  pending,
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isError = message.role === 'error'
  const isInfo = message.role === 'info'
  const isSummary = message.role === 'summary'
  const isDebug = message.role === 'debug'
  const canRetry = isUser
  const hasDebug = !!message.debug_data && Object.keys(message.debug_data).length > 0

  // LLM Gateway (AD-036): реальные значения секретов для плейсхолдеров ⟦SYNTH_SECRET_N⟧.
  const secrets = (message.metadata?.secrets as Record<string, string> | undefined) ?? undefined
  // i18n ядра: metadata.i18n → перевод по ключу (fallback — content).
  const resolveI18nText = useResolveI18n()
  const i18nMeta = message.metadata?.i18n
  const activeTab = useUIStore((s) => s.centerTabs.find((t) => t.id === s.activeCenterTabId))
  const sessionId = (activeTab?.data?.sessionId as string) || undefined
  // Отладка открыта глобально (chatStore) — подсветить кнопку только у того
  // сообщения и сессии, для которых вызвано окно.
  const debugModalSessionId = useChatStore((s) => s.debugModalSessionId)
  const debugModalMessageIndex = useChatStore((s) => s.debugModalMessageIndex)
  const debugActive =
    !!sessionId && debugModalSessionId === sessionId && debugModalMessageIndex === message.index

  const containerClass = cn(
    'flex px-4 py-3 group',
    selectionMode ? 'flex-row items-start' : 'flex-col',
    isUser && 'items-end',
    isAssistant && 'items-start',
    isSummary && 'items-center',
    isDebug && 'items-center',
    (isError || isInfo) && 'items-center'
  )

  const bubbleClass = cn(
    'max-w-[85%] rounded-lg px-4 py-3',
    isUser && 'bg-primary/10 text-foreground rounded-br-sm',
    isAssistant && 'bg-card border border-border/50 text-foreground rounded-bl-sm',
    isSummary && 'bg-yellow-500/5 border border-yellow-500/20 text-foreground',
    isDebug && 'bg-amber-500/5 border border-amber-500/30 text-amber-600 dark:text-amber-400 rounded-lg',
    isError && 'bg-destructive/10 border border-destructive/30 text-destructive rounded-lg',
    isInfo && 'bg-muted/30 border border-border/30 text-muted-foreground rounded-lg text-xs',
    message.disabled && 'opacity-50 line-through',
    message.pinned && 'ring-1 ring-primary/30',
  )

  const showActions = isUser || isAssistant || isSummary || isDebug

  // AD-070 §2.6: строка статистики — только для ответов ассистента с данными.
  // Скрытые/выключенные и служебные tool-chain сообщения исключаем.
  const showStats =
    isAssistant &&
    !message.disabled &&
    !message.hidden &&
    message.metadata?.tool_chain !== true &&
    hasMessageStats(message)

  // Локальные стабильные обработчики: зависят только от ссылки на колбэк и
  // самого сообщения, поэтому пропсы дочерних компонентов не «дрожат» зря.
  const handleCopy = useCallback(() => onCopy(message), [onCopy, message])
  const handleToggle = useCallback(() => onToggle(message), [onToggle, message])
  const handlePin = useCallback(() => onPin(message), [onPin, message])
  const handleDelete = useCallback(() => onDelete(message), [onDelete, message])
  const handleRetry = useCallback(() => onRetry(message), [onRetry, message])
  const handleDebug = useCallback(() => onDebug(message), [onDebug, message])
  const handleFork = useCallback(() => onFork(message), [onFork, message])
  const handleToggleSelect = useCallback(
    (shiftKey: boolean) => onToggleSelect?.(message.index, shiftKey),
    [onToggleSelect, message.index]
  )

  const handleOriginClick = () => {
    const parentSessionId = (message.metadata as Record<string, unknown>)?.source_session_id as string | undefined
    if (parentSessionId) {
      useUIStore.getState().openTab({
        id: `chat-${parentSessionId}`,
        type: 'chat',
        title: 'Родительская сессия',
        data: { sessionId: parentSessionId },
      })
    }
  }

  const toolCalls = message.tool_calls || []
  const liveToolCalls = useToolCallData(toolCalls)
  const reasoningBlocks = getReasoningBlocks(message)
  const intermediateTextBlocks = getIntermediateTextBlocks(message)
  const intermediateTextMode = useUIStore((s) => s.intermediateTextDisplay)
  const isInline = intermediateTextMode !== 'bottom'

  // AD-046 §7.1: локальный ответ системной (builtin) команды — нейтральный
  // system-блок без шапки агента/статистики; команда и вывод объединены
  // (`metadata.command === true` на assistant-сообщении). Шаблонные/skill/bundle
  // команды сюда не попадают: у них `metadata.command` — объект, а не `true`.
  if (isAssistant && message.metadata?.command === true) {
    return <CommandMessage message={message} onCopy={handleCopy} sessionId={sessionId} />
  }

  const getSubagentData = (tc: LiveToolCall) => {
    const meta = tc.result?.metadata as Record<string, unknown> | undefined
    if (!meta) return null
    const sessionId = meta.child_session_id as string | undefined
    return {
      name: (meta.subagent_type as string) || 'task',
      prompt: tc.args?.prompt as string | undefined,
      response: (meta.final_content as string) || (meta.description as string) || '',
      sessionId,
      callId: tc.callId,
      errorInfo: {
        isError: tc.result?.isError === true || meta.error === true,
        attempts: meta.attempts as number | undefined,
        maxRetries: meta.max_retries as number | undefined,
        errorType: meta.error_type as string | undefined,
        error: meta.error as string | undefined,
      },
      reasoning_blocks: meta.reasoning_blocks as Array<{ text: string; iteration: number }> | undefined,
      intermediate_text_blocks: meta.intermediate_text_blocks as Array<{ text: string; iteration: number }> | undefined,
      tool_calls: meta.tool_calls as Array<{
        name: string; args: Record<string, unknown>; id?: string;
        result?: { content: string; isError?: boolean };
        started_at?: string; completed_at?: string; iteration: number;
      }> | undefined,
      steps: meta.steps as number | undefined,
      description: meta.description as string | undefined,
    }
  }

  const bottomContent = !isInline && intermediateTextBlocks.length > 0
    ? [...intermediateTextBlocks.map((it) => it.text), message.content].filter(Boolean).join('\n\n')
    : null
  const displayContent = bottomContent ?? message.content
  // AD-070 §2.6: пустой отменённый ответ (отмена до первого токена) всё равно
  // показываем — статус «Остановлено» и статистика идут через metadata.
  if (
    !displayContent &&
    !message.reasoning &&
    liveToolCalls.length === 0 &&
    reasoningBlocks.length === 0 &&
    intermediateTextBlocks.length === 0 &&
    !showStats
  ) return null

  return (
    <div className={containerClass}>
      {selectionMode && (
        <div className="flex items-center self-stretch pr-1">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => {
              const ev = e.nativeEvent as MouseEvent
              handleToggleSelect(ev.shiftKey ?? false)
            }}
            className="size-4 rounded border-border cursor-pointer accent-primary"
          />
        </div>
      )}
      <div className={bubbleClass}>
        {isAssistant && (
          <MessageHeader message={message} isSubagent={isSubagent} onOriginClick={handleOriginClick} />
        )}

        {isSummary && (
          <MessageHeader message={message} isSubagent={isSubagent} onOriginClick={handleOriginClick} />
        )}

        {isDebug && (
          <MessageHeader message={message} isSubagent={isSubagent} onOriginClick={handleOriginClick} />
        )}

        {(isAssistant || isSummary || isDebug) && (
          (() => {
            const items: Array<
              | { type: 'reasoning'; data: ReasoningBlockData }
              | { type: 'intermediate_text'; data: IntermediateTextBlockData }
              | { type: 'subagent'; data: SubagentPartData }
              | { type: 'tool_calls'; calls: LiveToolCall[] }
            > = []

            const maxIter = Math.max(
              0,
              ...reasoningBlocks.map((r) => r.iteration),
              ...intermediateTextBlocks.map((it) => it.iteration),
              ...liveToolCalls.map((tc) => tc.iteration),
            )

            for (let iter = 0; iter <= maxIter; iter++) {
              for (const r of reasoningBlocks) {
                if (r.iteration === iter) items.push({ type: 'reasoning', data: r })
              }
              if (isInline) {
                for (const it of intermediateTextBlocks) {
                  if (it.iteration === iter) items.push({ type: 'intermediate_text', data: it })
                }
              }
              const iterCalls = liveToolCalls.filter((tc) => tc.iteration === iter)
              const regularCalls: LiveToolCall[] = []
              for (const tc of iterCalls) {
                if (tc.name === 'task') {
                  const sa = getSubagentData(tc)
                  if (sa) {
                    items.push({ type: 'subagent', data: sa })
                    continue
                  }
                }
                if (tc.parentCallId) continue
                regularCalls.push(tc)
              }
              if (regularCalls.length > 0) {
                items.push({ type: 'tool_calls', calls: regularCalls })
              }
            }

            return items.map((item, i) => {
              if (item.type === 'reasoning') {
                return <ReasoningBlock key={`r${i}`} reasoning={item.data.text} />
              }
              if (item.type === 'intermediate_text') {
                return (
                  <div key={`it${i}`} className="my-2 text-sm">
                    <SecretMarkdown content={item.data.text} secrets={secrets} sessionId={sessionId} />
                  </div>
                )
              }
              if (item.type === 'subagent') {
                return <SubagentPart key={`sa${i}`} subagent={item.data} />
              }
              if (item.type === 'tool_calls') {
                return item.calls.map((tc, j) => (
                  <ToolCallPart key={tc.callId || j} toolCall={tc} secrets={secrets} sessionId={sessionId} />
                ))
              }
              return null
            })
          })()
        )}

        {isUser && (
          <MessageHeader
            message={message}
            isSubagent={isSubagent}
            onOriginClick={handleOriginClick}
            processing={pending?.status === 'processing'}
          />
        )}

        {displayContent && (
          isUser ? (
            <SecretPlainText content={displayContent} secrets={secrets} sessionId={sessionId} />
          ) : isInfo && (message.metadata as Record<string, unknown>)?.type === 'session_reference' ? (
            <SessionReferenceCard
              sessionId={String((message.metadata as Record<string, unknown>)?.session_id || '')}
              content={displayContent}
              metadata={message.metadata as Record<string, unknown> | undefined}
            />
          ) : (
            <SecretMarkdown
              content={resolveI18nText(i18nMeta, displayContent)}
              secrets={secrets}
              sessionId={sessionId}
            />
          )
        )}

        {isUser && pending && pending.status === 'retrying' && pending.retry && (
          <RetryStatus
            retry={pending.retry}
            onRetryNow={pending.onRetryNow}
            onCancelRetry={pending.onCancelRetry}
          />
        )}

        {showActions && (
          <MessageActions
            messageIndex={message.index}
            role={message.role}
            disabled={message.disabled}
            pinned={message.pinned}
            canRetry={canRetry}
            hasDebug={hasDebug}
            debugActive={debugActive}
            readOnly={readOnly}
            hasStats={showStats}
            // AD-070 §2.6: статистика ответа — в поповере по кнопке (единый путь).
            statsContent={<MessageStats message={message} />}
            onCopy={handleCopy}
            onToggle={handleToggle}
            onPin={handlePin}
            onDelete={handleDelete}
            onRetry={handleRetry}
            onDebug={handleDebug}
            onFork={handleFork}
          />
        )}
      </div>
    </div>
  )
}

function SessionReferenceCard({
  sessionId,
  content,
  metadata,
}: {
  sessionId: string
  content: string
  metadata?: Record<string, unknown>
}) {
  const activeTab = useUIStore((s) => {
    const tab = s.centerTabs.find((t) => t.id === s.activeCenterTabId)
    return tab
  })
  const currentSessionId = (activeTab?.data?.sessionId as string) || ''
  const openTab = useUIStore((s) => s.openTab)
  const setMessages = useChatStore((s) => s.setMessages)

  const label = (metadata?.label as string) || undefined
  const sourceSessionName = (metadata?.sourceSessionName as string) || undefined
  const messageRange =
    (metadata?.messageRange as [number, number]) ||
    (metadata?.range as [number, number]) ||
    undefined
  const autoSummary =
    (metadata?.autoSummary as string) ||
    (metadata?.auto_summary as string) ||
    undefined

  const displayName = label || sourceSessionName || sessionId.slice(0, 8)
  const shortId = sessionId.slice(0, 8)

  const handleOpen = () => {
    if (!sessionId) return
    openTab({
      id: `chat-${sessionId}`,
      type: 'chat' as const,
      title: displayName,
      data: { sessionId },
    })
  }

  const handleRemove = async () => {
    if (!currentSessionId || !sessionId) return
    try {
      await synthApi.removeSessionReference(currentSessionId, sessionId)
      const result = await synthApi.getSessionMessages(currentSessionId)
      setMessages(currentSessionId, result.messages)
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/15 text-xs">
      {/* Заголовок с иконкой и названием */}
      <div className="flex items-center gap-2">
        <Icon name="link" className="h-4 w-4 text-blue-500 shrink-0" />
        <span className="font-medium text-blue-600 dark:text-blue-400 truncate">
          {displayName}
        </span>
        {displayName !== shortId && (
          <span className="text-muted-foreground font-mono text-[0.625rem] shrink-0">{shortId}</span>
        )}
      </div>

      {/* Мета-информация: диапазон, авто-саммари */}
      {(messageRange || autoSummary) && (
        <div className="text-muted-foreground space-y-0.5">
          {messageRange && (
            <div>Сообщения {messageRange[0]}–{messageRange[1]}</div>
          )}
          {autoSummary && <p className="line-clamp-3">{autoSummary}</p>}
        </div>
      )}

      {/* Контент (если передан) */}
      {content && <MarkdownContent content={content} />}

      {/* Кнопки действий */}
      <div className="flex gap-2">
        <button
          onClick={handleOpen}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] font-medium text-blue-600 hover:bg-blue-500/10 transition-colors"
        >
          <Icon name="external-link" className="h-3 w-3" />
          Открыть сессию
        </button>
        {currentSessionId && (
          <button
            onClick={handleRemove}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Icon name="close" className="h-3 w-3" />
            Удалить
          </button>
        )}
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageInner);
