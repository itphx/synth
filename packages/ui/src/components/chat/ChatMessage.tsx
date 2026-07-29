import { cn } from '@/lib/utils'
import { memo } from 'react'
import { MarkdownContent } from './MarkdownContent'
import { MessageHeader } from './MessageHeader'
import { MessageActions } from './MessageActions'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import { SubagentPart, type SubagentPartData } from './SubagentPart'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import type { MessageData, LiveToolCall, ReasoningBlockData, IntermediateTextBlockData } from '@/stores/chatStore'
import { synthApi } from '@/lib/api/synthApi'
import { useMemo } from 'react'
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
  onCopy: () => void
  onToggle: () => void
  onPin: () => void
  onDelete: () => void
  onRetry: () => void
  onDebug: () => void
  onFork: () => void
  readOnly?: boolean
  /** true если сессия — дочерняя (сабагент) */
  isSubagent?: boolean
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
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isError = message.role === 'error'
  const isInfo = message.role === 'info'
  const isSummary = message.role === 'summary'
  const isDebug = message.role === 'debug'
  const canRetry = isUser
  const hasDebug = !!message.debug_data && Object.keys(message.debug_data).length > 0

  const containerClass = cn(
    'flex flex-col px-4 py-3 group',
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

  const toolCalls = message.tool_calls || []
  const liveToolCalls = useToolCallData(toolCalls)
  const reasoningBlocks = getReasoningBlocks(message)
  const intermediateTextBlocks = getIntermediateTextBlocks(message)
  const intermediateTextMode = useUIStore((s) => s.intermediateTextDisplay)
  const isInline = intermediateTextMode !== 'bottom'

  const getSubagentData = (tc: LiveToolCall) => {
    const meta = tc.result?.metadata as Record<string, unknown> | undefined
    if (!meta) return null
    const sessionId = meta.child_session_id as string | undefined
    return {
      name: (meta.subagent_type as string) || 'task',
      prompt: tc.args?.prompt as string | undefined,
      response: (meta.final_content as string) || (meta.description as string) || '',
      sessionId,
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
  if (!displayContent && !message.reasoning && liveToolCalls.length === 0 && reasoningBlocks.length === 0 && intermediateTextBlocks.length === 0) return null

  return (
    <div className={containerClass}>
      <div className={bubbleClass}>
        {isAssistant && (
          <MessageHeader message={message} isSubagent={isSubagent} />
        )}

        {isSummary && (
          <MessageHeader message={message} isSubagent={isSubagent} />
        )}

        {isDebug && (
          <MessageHeader message={message} isSubagent={isSubagent} />
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
                    <MarkdownContent content={item.data.text} />
                  </div>
                )
              }
              if (item.type === 'subagent') {
                return <SubagentPart key={`sa${i}`} subagent={item.data} />
              }
              if (item.type === 'tool_calls') {
                return item.calls.map((tc, j) => (
                  <ToolCallPart key={tc.callId || j} toolCall={tc} />
                ))
              }
              return null
            })
          })()
        )}

        {isUser && (
          <MessageHeader message={message} isSubagent={isSubagent} />
        )}

        {displayContent && (
          isUser ? (
            <p className="text-sm whitespace-pre-wrap">{displayContent}</p>
          ) : isInfo && (message.metadata as Record<string, unknown>)?.type === 'session_reference' ? (
            <SessionReferenceCard
              sessionId={String((message.metadata as Record<string, unknown>)?.session_id || '')}
              content={displayContent}
              metadata={message.metadata as Record<string, unknown> | undefined}
            />
          ) : (
            <MarkdownContent content={displayContent} />
          )
        )}

        {message.origin && message.origin !== 'local' && (
          <span
            title={message.source_msg_id ? `Из сообщения ${message.source_msg_id.slice(0, 8)}...` : undefined}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] mt-1 ${
              message.origin === 'merged' ? 'bg-purple-500/10 text-purple-600' :
              message.origin === 'inherited' ? 'bg-blue-500/10 text-blue-600' :
              message.origin === 'crosspost' ? 'bg-teal-500/10 text-teal-600' :
              'bg-muted text-muted-foreground'
            }`}
          >
            <Icon
              name={
                message.origin === 'merged' ? 'links-line' :
                message.origin === 'inherited' ? 'git-branch' :
                message.origin === 'crosspost' ? 'link' :
                'git-branch'
              }
              className="h-2.5 w-2.5"
            />
            {message.origin === 'merged' ? '📋 Скопировано' :
             message.origin === 'inherited' ? '↳ Унаследовано' :
             message.origin === 'crosspost' ? '↔ Связано' :
             message.origin}
          </span>
        )}

        {showActions && (
          <MessageActions
            messageIndex={message.index}
            role={message.role}
            disabled={message.disabled}
            pinned={message.pinned}
            canRetry={canRetry}
            hasDebug={hasDebug}
            readOnly={readOnly}
            onCopy={onCopy}
            onToggle={onToggle}
            onPin={onPin}
            onDelete={onDelete}
            onRetry={onRetry}
            onDebug={onDebug}
            onFork={onFork}
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
          <span className="text-muted-foreground font-mono text-[10px] shrink-0">{shortId}</span>
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
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-blue-600 hover:bg-blue-500/10 transition-colors"
        >
          <Icon name="external-link" className="h-3 w-3" />
          Открыть сессию
        </button>
        {currentSessionId && (
          <button
            onClick={handleRemove}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
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
