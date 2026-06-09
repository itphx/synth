import { cn, resolveColor } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { ProviderIcon } from '@/components/admin/ProviderIcon'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import { MarkdownContent } from './MarkdownContent'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import type { StreamState, LiveToolCall, ReasoningBlockData, IntermediateTextBlockData } from '@/stores/chatStore'

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

function ToolCallTreeNode({ node }: { node: ToolCallNode }) {
  return (
    <div>
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
      {node.children.length > 0 && (
        <div className="ml-3 border-l-2 border-muted/50 pl-2">
          {node.children.map((child) => (
            <ToolCallTreeNode key={child.call.callId} node={child} />
          ))}
        </div>
      )}
    </div>
  )
}

function buildTimeline(
  reasoningBlocks: ReasoningBlockData[],
  intermediateTextBlocks: IntermediateTextBlockData[],
  toolCalls: LiveToolCall[],
): Array<
  | { type: 'reasoning'; data: ReasoningBlockData }
  | { type: 'intermediate_text'; data: IntermediateTextBlockData }
  | { type: 'tool_calls'; calls: LiveToolCall[] }
> {
  const items: Array<
    | { type: 'reasoning'; data: ReasoningBlockData }
    | { type: 'intermediate_text'; data: IntermediateTextBlockData }
    | { type: 'tool_calls'; calls: LiveToolCall[] }
  > = []

  const maxIter = Math.max(
    0,
    ...reasoningBlocks.map((r) => r.iteration),
    ...intermediateTextBlocks.map((it) => it.iteration),
    ...toolCalls.map((tc) => tc.iteration),
  )

  for (let iter = 0; iter <= maxIter; iter++) {
    for (const r of reasoningBlocks) {
      if (r.iteration === iter) items.push({ type: 'reasoning', data: r })
    }
    for (const it of intermediateTextBlocks) {
      if (it.iteration === iter) items.push({ type: 'intermediate_text', data: it })
    }
    const iterToolCalls = toolCalls.filter((tc) => tc.iteration === iter)
    if (iterToolCalls.length > 0) {
      items.push({ type: 'tool_calls', calls: iterToolCalls })
    }
  }

  return items
}

interface StreamingPlaceholderProps {
  stream: StreamState
  onStop: () => void
}

export function StreamingPlaceholder({ stream, onStop }: StreamingPlaceholderProps) {
  const agents = useAgentsStore((s) => s.agents)
  const providers = useProvidersStore((s) => s.providers)
  const { t } = useI18n()
  const intermediateTextMode = useUIStore((s) => s.intermediateTextDisplay)

  const isSummary = stream.agentRole === 'summary'
  const isDebug = stream.agentRole === 'debug'

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
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
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
          if (item.type === 'tool_calls') {
            const toolTree = buildToolCallTree(item.calls)
            return (
              <div key={`t${i}`} className="mb-2">
                {toolTree.map((node) => (
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
            <button
              onClick={onStop}
              title={t('chat.input.stop')}
              className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Icon name="stop" className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
