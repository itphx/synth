import { cn, resolveColor } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { ProviderIcon } from '@/components/admin/ProviderIcon'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import { SubagentPart, type SubagentPartData } from './SubagentPart'
import { MarkdownContent } from './MarkdownContent'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { RetryStatus } from './RetryStatus'
import type { StreamState, LiveToolCall, ReasoningBlockData, IntermediateTextBlockData, StreamRetry } from '@/stores/chatStore'

interface ToolCallNode {
  call: LiveToolCall
  children: ToolCallNode[]
}

function buildToolCallTree(calls: LiveToolCall[]): ToolCallNode[] {
  const nodes = new Map<string, ToolCallNode>()
  const roots: ToolCallNode[] = []

  for (const call of calls) {
    nodes.set(call.callId, { call, children: [] })
  }

  for (const call of calls) {
    const node = nodes.get(call.callId)!
    if (call.parentCallId && nodes.has(call.parentCallId)) {
      nodes.get(call.parentCallId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

/** Собираем данные саб-агента из live-узла `task` — стриминг рендерится как итоговый SubagentPart. */
function toSubagentPartData(node: ToolCallNode): SubagentPartData {
  const args = node.call.args as Record<string, unknown>
  const meta = (node.call.result?.metadata as Record<string, unknown>) || {}
  return {
    name: (args?.subagent_type as string) || 'task',
    prompt: args?.prompt as string | undefined,
    response: (meta.final_content as string) || (meta.description as string) || '',
    sessionId: meta.child_session_id as string | undefined,
    reasoning_blocks: node.call.subagentReasoningBlocks,
    intermediate_text_blocks: node.call.subagentIntermediateTextBlocks,
    tool_calls: (node.children || []).map((c) => ({
      name: c.call.name,
      args: c.call.args,
      id: c.call.callId,
      result: c.call.result,
      started_at: c.call.startedAt,
      completed_at: c.call.completedAt,
      iteration: c.call.iteration ?? 0,
    })),
    description: meta.description as string | undefined,
  }
}

function ToolCallTreeNode({ node }: { node: ToolCallNode }) {
  const isTask = node.call.name === 'task'

  // Саб-агент во время стрима рисуем как итоговый SubagentPart: PROMPT вместо
  // JSON-аргументов, без двойной обводки, сам сворачивается по клику на заголовок.
  if (isTask) {
    return <SubagentPart subagent={toSubagentPartData(node)} />
  }

  return (
    <ToolCallPart
      toolCall={{
        name: node.call.name,
        args: node.call.args,
        id: node.call.callId,
        callId: node.call.callId,
        status: node.call.status,
        result: node.call.result,
        startedAt: node.call.startedAt,
        completedAt: node.call.completedAt,
        iteration: node.call.iteration,
        parentCallId: node.call.parentCallId,
      }}
    />
  )
}

function buildTimeline(
  reasoningBlocks: ReasoningBlockData[],
  intermediateTextBlocks: IntermediateTextBlockData[],
  toolCalls: LiveToolCall[],
): Array<
  | { type: 'reasoning'; data: ReasoningBlockData }
  | { type: 'intermediate_text'; data: IntermediateTextBlockData }
  | { type: 'tool_tree'; roots: ToolCallNode[] }
> {
  // Строим ДЕРЕВО тул-вызовов глобально (по всем итерациям): внутренние вызовы
  // саб-агента (`parentCallId` → `task`) вкладываются под родителя независимо
  // от собственной нумерации итераций и не занимают отдельного слота таймлайна.
  const roots = buildToolCallTree(toolCalls)

  const items: Array<
    | { type: 'reasoning'; data: ReasoningBlockData }
    | { type: 'intermediate_text'; data: IntermediateTextBlockData }
    | { type: 'tool_tree'; roots: ToolCallNode[] }
  > = []

  const maxIter = Math.max(
    0,
    ...reasoningBlocks.map((r) => r.iteration),
    ...intermediateTextBlocks.map((it) => it.iteration),
    ...roots.map((r) => r.call.iteration),
  )

  for (let iter = 0; iter <= maxIter; iter++) {
    for (const r of reasoningBlocks) {
      if (r.iteration === iter) items.push({ type: 'reasoning', data: r })
    }
    for (const it of intermediateTextBlocks) {
      if (it.iteration === iter) items.push({ type: 'intermediate_text', data: it })
    }
    const iterRoots = roots.filter((r) => r.call.iteration === iter)
    if (iterRoots.length > 0) {
      items.push({ type: 'tool_tree', roots: iterRoots })
    }
  }

  return items
}

interface StreamingPlaceholderProps {
  stream: StreamState
  onStop: () => void
  /** Статус повторной попытки: показываем вместо «крутилки» */
  retry?: StreamRetry | null
  onRetryNow?: () => void
  onCancelRetry?: () => void
}

export function StreamingPlaceholder({ stream, onStop, retry, onRetryNow, onCancelRetry }: StreamingPlaceholderProps) {
  const agents = useAgentsStore((s) => s.agents)
  const providers = useProvidersStore((s) => s.providers)
  const { t } = useI18n()
  const intermediateTextMode = useUIStore((s) => s.intermediateTextDisplay)

  const isSummary = stream.agentRole === 'summary'
  const isDebug = stream.agentRole === 'debug'
  const isRetrying = stream.isRetrying && retry != null

  const agentInfo = !isSummary && !isDebug && stream.agentRole
    ? agents.find((a) => a.id === stream.agentRole)
    : undefined
  const agentColor = resolveColor(agentInfo?.color ?? null)

  const providerIcon = stream.provider
    ? providers.find((p) => p.name === stream.provider)?.icon || ''
    : ''
  const providerUrl = stream.provider
    ? providers.find((p) => p.name === stream.provider)?.url
    : undefined

  const isInline = intermediateTextMode !== 'bottom'
  const displayContent = isInline
    ? stream.content.slice(stream._lastContentLen).replace(/^\n+|\n+$/g, '')
    : stream.content

  const timeline = buildTimeline(
    stream.reasoningBlocks,
    isInline ? stream.intermediateTextBlocks : [],
    stream.toolCalls || [],
  )

  return (
    <div className={cn(
      'flex flex-col px-4 py-3 group',
      (isSummary || isDebug) ? 'items-center' : 'items-start',
    )}>
      <div className={cn(
        'max-w-[85%] rounded-lg px-4 py-3 text-foreground',
        isSummary
          ? 'bg-yellow-500/5 border border-yellow-500/20'
          : isDebug
            ? 'bg-amber-500/5 border border-amber-500/30 text-amber-600 dark:text-amber-400'
            : 'bg-card border border-border/50 rounded-bl-sm',
      )}>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 mb-1">
          {isSummary && (
            <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-primary">
              <Icon name="subtract" className="size-3" />
              <span>Summary</span>
            </span>
          )}

          {isDebug && (
            <span className="inline-flex items-center gap-1 rounded-sm py-0.5 text-amber-600 dark:text-amber-400">
              <Icon name="laptop" className="size-3" />
              <span>Debug</span>
            </span>
          )}

          {!isSummary && !isDebug && stream.agentRole && (
            <span
              className={`inline-flex items-center gap-1 rounded-sm py-0.5 ${agentColor ? '' : 'text-primary'}`}
              style={agentColor ? { color: agentColor } : undefined}
            >
              <Icon name={agentInfo?.icon || 'user-smile'} className="size-3" />
              <span>{agentInfo?.display_name || stream.agentRole}</span>
            </span>
          )}

          {stream.model && (
            <span className="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5">
              <ProviderIcon icon={providerIcon} baseUrl={providerUrl} size={12} className="shrink-0" />
              <span>{stream.model}</span>
            </span>
          )}

          <span className="ml-auto inline-flex gap-0.5">
            {!isRetrying && (
              <>
                <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
              </>
            )}
          </span>
        </div>

        {timeline.map((item, i) => {
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
          if (item.type === 'tool_tree') {
            return (
              <div key={`t${i}`} className="mb-2">
                {item.roots.map((node) => (
                  <ToolCallTreeNode key={node.call.callId} node={node} />
                ))}
              </div>
            )
          }
          return null
        })}

        {displayContent && <MarkdownContent content={displayContent} />}

        {stream.isStreaming && (
          <div className="flex items-center gap-0.5 mt-2 pt-1.5 border-t border-border/30">
            {isRetrying && retry ? (
              <div className="w-full">
                <RetryStatus retry={retry} onRetryNow={onRetryNow} onCancelRetry={onCancelRetry} />
              </div>
            ) : (
              <button
                onClick={onStop}
                title={t('chat.input.stop')}
                className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Icon name="stop" className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
