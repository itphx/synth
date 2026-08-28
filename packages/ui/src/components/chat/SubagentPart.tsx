import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import { notifyMessage } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'
import { MarkdownContent } from './MarkdownContent'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallPart } from './ToolCallPart'
import { useRetryCountdown } from './RetryStatus'
import { isRecoverableErrorType } from '@/lib/streamErrors'
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

/** Ошибка саб-агента из tool_result metadata (B7): плашка внизу блока. */
export interface SubagentErrorInfo {
  isError?: boolean
  attempts?: number
  maxRetries?: number
  errorType?: string
  error?: string
}

export interface SubagentPartData {
  name: string
  prompt?: string
  response?: string
  sessionId?: string
  /** call_id тула `task` — связывает блок с событиями subagent.retry. */
  callId?: string
  /** true для live-блока (идёт стрим) — retry-статус актуален только в нём. */
  live?: boolean
  errorInfo?: SubagentErrorInfo
  reasoning_blocks?: Array<{ text: string; iteration: number }>
  intermediate_text_blocks?: Array<{ text: string; iteration: number }>
  tool_calls?: SubagentToolCall[]
  steps?: number
  description?: string
}

export function SubagentPart({ subagent }: { subagent: SubagentPartData }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)

  // Состояния retry/resume привязаны к сессии открытой вкладки (родитель или ребёнок).
  const activeTab = useUIStore((s) => s.centerTabs.find((tb) => tb.id === s.activeCenterTabId))
  const sid = (activeTab?.data?.sessionId as string) || ''
  const subagentRetry = useChatStore((s) => s.subagentRetryBySession[sid] || null)
  const resuming = useChatStore((s) => s.subagentResumingBySession[sid] || null)

  const retryVisible = subagent.live === true
    && subagentRetry != null
    && (!subagentRetry.callId || subagentRetry.callId === subagent.callId)
  const retrySeconds = useRetryCountdown(subagentRetry?.retryInMs ?? 5000)

  const resumeActive = resuming != null
    && !!subagent.sessionId
    && resuming.childSessionId === subagent.sessionId

  const showErrorBar = !resumeActive
    && !!subagent.errorInfo?.isError
    && !!subagent.sessionId

  const handleResume = () => {
    if (!subagent.sessionId) return
    synthApi.resumeSubagent(subagent.sessionId).catch((e) => {
      notifyMessage({ text: `${t('chat.subagent.resumeFailed')}: ${(e as Error).message}`, type: 'error', category: 'error', sessionId: subagent.sessionId })
    })
  }

  const handleStopResume = () => {
    if (!subagent.sessionId) return
    synthApi.stopGeneration(subagent.sessionId).catch(() => {})
  }

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

  const errorRecoverable = isRecoverableErrorType(subagent.errorInfo?.errorType)
  const errorAttemptsLabel = subagent.errorInfo?.attempts != null
    ? t('chat.subagent.errorAttempts', {
        attempts: String(subagent.errorInfo.attempts),
        max: String(subagent.errorInfo.maxRetries ?? 3),
      })
    : null

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

      {/* Внизу блока: статус ретрая / возобновление / ошибка. Видны и у свёрнутого блока. */}
      {retryVisible && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-yellow-500/20 bg-yellow-500/5">
          <Icon name="refresh" className="size-3.5 text-yellow-600 dark:text-yellow-400 shrink-0" />
          <span className="text-xs text-yellow-700 dark:text-yellow-400">
            {t('chat.retry.inProgress', {
              current: String(subagentRetry?.attempt ?? 1),
              max: String(subagentRetry?.maxRetries ?? 3),
              sec: String(retrySeconds),
            })}
          </span>
        </div>
      )}

      {resumeActive && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-purple-500/20 bg-purple-500/5">
          <Icon name="refresh" className="size-3.5 text-purple-500 shrink-0 animate-spin" />
          <span className="text-xs text-purple-600 dark:text-purple-400 flex-1">
            {t('chat.subagent.resuming')}
          </span>
          <button
            onClick={handleStopResume}
            className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('chat.subagent.stop')}
          </button>
        </div>
      )}

      {showErrorBar && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-destructive/20 bg-destructive/5">
          <Icon name="error-warning" className="size-3.5 text-destructive shrink-0" />
          <span className="text-xs text-destructive flex-1 min-w-0">
            {t('chat.subagent.errorStopped')}
            {errorAttemptsLabel && (
              <span className="ml-1 text-[10px] text-muted-foreground">({errorAttemptsLabel})</span>
            )}
          </span>
          {errorRecoverable && (
            <button
              onClick={handleResume}
              className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
            >
              {t('chat.subagent.resume')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
