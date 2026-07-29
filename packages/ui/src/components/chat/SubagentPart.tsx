import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { MarkdownContent } from './MarkdownContent'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import type { ReasoningBlockData, IntermediateTextBlockData } from '@/stores/chatStore'

export interface SubagentToolCall {
  name: string
  args: Record<string, unknown>
  id?: string
  result?: { content: string; isError?: boolean }
  started_at?: string
  completed_at?: string
  iteration: number
}

export interface SubagentPartData {
  name: string
  prompt?: string
  response?: string
  sessionId?: string
  reasoning_blocks?: Array<{ text: string; iteration: number }>
  intermediate_text_blocks?: Array<{ text: string; iteration: number }>
  tool_calls?: SubagentToolCall[]
  steps?: number
  description?: string
}

export function SubagentPart({ subagent }: { subagent: SubagentPartData }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)

  const reasoningBlocks: ReasoningBlockData[] = subagent.reasoning_blocks || []
  const intermediateTextBlocks: IntermediateTextBlockData[] = subagent.intermediate_text_blocks || []
  const toolCalls = subagent.tool_calls || []

  const maxIter = Math.max(
    0,
    ...reasoningBlocks.map((r) => r.iteration),
    ...intermediateTextBlocks.map((it) => it.iteration),
    ...toolCalls.map((tc) => tc.iteration),
  )

  const items: Array<
    | { type: 'reasoning'; data: ReasoningBlockData }
    | { type: 'intermediate_text'; data: IntermediateTextBlockData }
    | { type: 'tool_calls'; calls: typeof toolCalls }
  > = []

  for (let iter = 0; iter <= maxIter; iter++) {
    for (const r of reasoningBlocks) {
      if (r.iteration === iter) items.push({ type: 'reasoning', data: r })
    }
    for (const it of intermediateTextBlocks) {
      if (it.iteration === iter) items.push({ type: 'intermediate_text', data: it })
    }
    const iterCalls = toolCalls.filter((tc) => tc.iteration === iter)
    if (iterCalls.length > 0) {
      items.push({ type: 'tool_calls', calls: iterCalls })
    }
  }

  const shortSessionId = subagent.sessionId?.slice(0, 8)

  const handleOpenSession = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!subagent.sessionId) return
    useUIStore.getState().openTab({
      id: `chat-${subagent.sessionId}`,
      type: 'chat',
      title: `${t('chat.subagent.title')}: ${subagent.name}`,
      data: { sessionId: subagent.sessionId },
    })
  }

  return (
    <div className="mb-2 rounded-md border border-border/50 overflow-hidden">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/30"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon
          name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
          className="size-3.5 transition-transform"
        />
        <Icon name="git-branch" className="size-3.5 text-purple-400" />
        <span className="font-medium">{t('chat.subagent.title')}: {subagent.name}</span>
        {shortSessionId && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {shortSessionId}
          </span>
        )}
        {subagent.sessionId && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 transition-colors cursor-pointer"
            onClick={handleOpenSession}
            title={subagent.sessionId}
          >
            <Icon name="external-link" className="size-3" />
            {t('chat.subagent.open')}
          </button>
        )}
        {subagent.steps != null && (
          <span className="text-[10px] text-muted-foreground/60">
            {subagent.steps} {t('chat.subagent.steps')}
          </span>
        )}
      </button>
      {expanded && (
        <div className="p-3 border-t border-border/50 bg-muted/10 space-y-2">
          {subagent.prompt && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 mb-1 uppercase tracking-wide">Prompt</div>
              <MarkdownContent content={subagent.prompt} className="text-xs" />
            </div>
          )}

          {items.map((item, i) => {
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
              return item.calls.map((call, j) => (
                <ToolCallPart
                  key={call.id || j}
                  toolCall={{
                    name: call.name,
                    args: call.args,
                    id: call.id,
                    callId: call.id,
                    status: 'done',
                    result: call.result,
                    startedAt: call.started_at,
                    completedAt: call.completed_at,
                    iteration: call.iteration,
                  }}
                />
              ))
            }
            return null
          })}

          {subagent.response && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 mb-1 uppercase tracking-wide">Response</div>
              <MarkdownContent content={subagent.response} className="text-xs" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
