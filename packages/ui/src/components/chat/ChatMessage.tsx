import { cn } from '@/lib/utils'
import { MarkdownContent } from './MarkdownContent'
import { MessageHeader } from './MessageHeader'
import { MessageActions } from './MessageActions'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import { SubagentPart } from './SubagentPart'
import type { MessageData } from '@/stores/chatStore'

interface ChatMessageProps {
  message: MessageData
  onCopy: () => void
  onToggle: () => void
  onPin: () => void
  onDelete: () => void
  onRetry: () => void
  onDebug: () => void
}

export function ChatMessage({
  message,
  onCopy,
  onToggle,
  onPin,
  onDelete,
  onRetry,
  onDebug,
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isError = message.role === 'error'
  const isInfo = message.role === 'info'
  const isSummary = message.role === 'summary'
  const canRetry = isUser
  const hasDebug = !!message.debug_data && Object.keys(message.debug_data).length > 0

  const containerClass = cn(
    'flex flex-col px-4 py-3 group',
    isUser && 'items-end',
    isAssistant && 'items-start',
    (isError || isInfo) && 'items-center'
  )

  const bubbleClass = cn(
    'max-w-[85%] rounded-lg px-4 py-3',
    isUser && 'bg-primary/10 text-foreground rounded-br-sm',
    isAssistant && 'bg-card border border-border/50 text-foreground rounded-bl-sm',
    isSummary && 'bg-yellow-500/5 border border-yellow-500/20 rounded-bl-sm',
    isError && 'bg-destructive/10 border border-destructive/30 text-destructive rounded-lg',
    isInfo && 'bg-muted/30 border border-border/30 text-muted-foreground rounded-lg text-xs',
    message.disabled && 'opacity-50 line-through',
    message.pinned && 'ring-1 ring-primary/30',
  )

  const showActions = isUser || isAssistant

  const subagents = hasDebug
    ? ((message.debug_data?.subagents as Array<{
        name: string
        prompt?: string
        messages?: Array<{ role: string; content: string }>
        response?: string
      }>) || [])
    : []

  const toolCalls = message.tool_calls || []

  if ((isError || isInfo) && message.content) {
    return (
      <div className={containerClass}>
        <div className={bubbleClass}>
          <MarkdownContent content={message.content} />
        </div>
      </div>
    )
  }

  if (!message.content && toolCalls.length === 0 && subagents.length === 0) return null

  return (
    <div className={containerClass}>
      <div className={bubbleClass}>
        {isAssistant && (
          <MessageHeader message={message} />
        )}

        {isAssistant && message.reasoning && (
          <ReasoningBlock reasoning={message.reasoning} />
        )}

        {isAssistant && toolCalls.map((tc, i) => (
          <ToolCallPart key={tc.id || i} toolCall={tc} />
        ))}

        {isAssistant && subagents.map((sa, i) => (
          <SubagentPart key={i} subagent={sa} />
        ))}

        {isUser && (
          <MessageHeader message={message} />
        )}

        {message.content && (
          isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : (
            <MarkdownContent content={message.content} />
          )
        )}

        {isSummary && (
          <MessageHeader message={message} />
        )}

        {showActions && (
          <MessageActions
            messageIndex={message.index}
            role={message.role}
            disabled={message.disabled}
            pinned={message.pinned}
            canRetry={canRetry}
            hasDebug={hasDebug}
            onCopy={onCopy}
            onToggle={onToggle}
            onPin={onPin}
            onDelete={onDelete}
            onRetry={onRetry}
            onDebug={onDebug}
          />
        )}
      </div>
    </div>
  )
}
