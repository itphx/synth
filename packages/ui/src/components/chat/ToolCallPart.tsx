import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface ToolCallData {
  name: string
  args: Record<string, unknown>
  id?: string
  callId?: string
  status?: 'running' | 'done'
  result?: { content: string; isError?: boolean; metadata?: Record<string, unknown> }
  startedAt?: string
  started_at?: string
  completedAt?: string
  completed_at?: string
  iteration?: number
  // live-only
  parentCallId?: string
}

interface ToolCallPartProps {
  toolCall: ToolCallData
  nested?: boolean
}

function formatDuration(started?: string, completed?: string): string {
  const start = started || ''
  const end = completed || ''
  if (!start || !end) return ''
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (ms < 0) return ''
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  } catch {
    return ''
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '…'
}

export function ToolCallPart({ toolCall, nested }: ToolCallPartProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [viewMode, setViewMode] = useState<'args' | 'result'>('args')

  const isError = toolCall.result?.isError
  const isRunning = toolCall.status === 'running'
  const isDone = toolCall.status === 'done' || (!isRunning && !!toolCall.result)
  const started = toolCall.startedAt || toolCall.started_at
  const completed = toolCall.completedAt || toolCall.completed_at
  const duration = formatDuration(started, completed)
  const hasResult = !!toolCall.result?.content

  const argsStr = JSON.stringify(toolCall.args, null, 2)
  const resultStr = toolCall.result?.content || ''

  const statusIcon = isError
    ? 'close-circle'
    : isRunning
      ? 'loader-2'
      : isDone
        ? 'check-circle'
        : 'tools'
  const statusColor = isError
    ? 'text-red-400'
    : isRunning
      ? 'text-blue-400 animate-spin'
      : isDone
        ? 'text-green-400'
        : 'text-blue-400'
  const statusLabel = isError
    ? t('chat.toolCall.error')
    : isRunning
      ? t('chat.toolCall.running')
      : isDone
        ? t('chat.toolCall.done')
        : ''

  return (
    <div className={nested ? 'mb-1 ml-3' : 'mb-2'}>
      <div className="rounded-md border border-border/50 overflow-hidden">
        <button
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/30"
          onClick={() => setExpanded(!expanded)}
        >
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-3.5 transition-transform"
          />
          <Icon name={statusIcon} className={`size-3.5 shrink-0 ${statusColor}`} />
          <span className="font-medium">{statusLabel}</span>
          <span className="font-mono">{toolCall.name}</span>
          {toolCall.iteration != null && (
            <span className="text-[10px] opacity-40 ml-0.5">
              #{toolCall.iteration}
            </span>
          )}
          {duration && (
            <span className="text-[10px] opacity-40 ml-0.5">
              {duration}
            </span>
          )}
          <span className="ml-auto text-[10px] opacity-50">
            {expanded ? t('chat.toolCall.collapse') : t('chat.toolCall.expand')}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-border/50 bg-muted/10">
            {/* Tab bar for args/result when both available */}
            {hasResult && !isRunning && (
              <div className="flex gap-0 border-b border-border/30">
                <button
                  className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                    viewMode === 'args'
                      ? 'text-foreground border-b-2 border-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setViewMode('args')}
                >
                  {t('chat.toolCall.arguments')}
                </button>
                <button
                  className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                    viewMode === 'result'
                      ? 'text-foreground border-b-2 border-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setViewMode('result')}
                >
                  {t('chat.toolCall.result')}
                </button>
                <button
                  className={`ml-auto px-2 py-1 text-[10px] font-mono transition-colors ${
                    showDebug
                      ? 'text-amber-400'
                      : 'text-muted-foreground/40 hover:text-muted-foreground'
                  }`}
                  onClick={() => setShowDebug(!showDebug)}
                >
                  {t('chat.toolCall.debug')}
                </button>
              </div>
            )}
            {isRunning && (
              <div className="flex items-center gap-0 border-b border-border/30">
                <div className="px-3 py-1 text-[11px] font-medium text-blue-400">
                  {t('chat.toolCall.arguments')}
                </div>
                <button
                  className={`ml-auto px-2 py-1 text-[10px] font-mono transition-colors ${
                    showDebug
                      ? 'text-amber-400'
                      : 'text-muted-foreground/40 hover:text-muted-foreground'
                  }`}
                  onClick={() => setShowDebug(!showDebug)}
                >
                  {t('chat.toolCall.debug')}
                </button>
              </div>
            )}
            {/* Debug view */}
            {showDebug && (
              <div className="px-3 py-2 border-b border-amber-500/20 bg-amber-500/5">
                <pre className="text-[11px] text-amber-600 dark:text-amber-400 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
                  {JSON.stringify({
                    name: toolCall.name,
                    args: toolCall.args,
                    status: toolCall.status,
                    result: toolCall.result,
                    startedAt: started,
                    completedAt: completed,
                    duration,
                    iteration: toolCall.iteration,
                    parentCallId: toolCall.parentCallId,
                  }, null, 2)}
                </pre>
              </div>
            )}
            {/* Content */}
            <div className="p-3">
              {viewMode === 'args' && (
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono">
                  {truncate(argsStr, 4000)}
                </pre>
              )}
              {viewMode === 'result' && hasResult && (
                <pre className={`text-xs whitespace-pre-wrap overflow-x-auto font-mono ${
                  isError ? 'text-red-400' : 'text-muted-foreground'
                }`}>
                  {truncate(resultStr, 4000)}
                </pre>
              )}
              {!hasResult && viewMode === 'result' && (
                <div className="text-xs text-muted-foreground/50 italic">
                  {t('common.empty')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
