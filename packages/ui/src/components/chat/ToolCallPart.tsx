import { useState } from 'react'
import { Icon } from '../icon/Icon'
import { getToolIcon, getToolDisplayName } from '@/lib/toolIcons'
import { useI18n, useResolveI18n } from '@/lib/i18n'
import { splitBySecretPlaceholders, SecretPlaceholder } from './SecretPlaceholder'

interface ToolCallData {
  name: string
  args: Record<string, unknown>
  id?: string
  callId?: string
  status?: 'running' | 'done'
  result?: {
    content: string
    isError?: boolean
    metadata?: Record<string, unknown>
  }
  startedAt?: string
  started_at?: string
  completedAt?: string
  completed_at?: string
  iteration?: number
  parentCallId?: string
}

interface ToolCallPartProps {
  toolCall: ToolCallData
  nested?: boolean
  /** Реальные значения секретов для плейсхолдеров ⟦SYNTH_SECRET_N⟧ (AD-036). */
  secrets?: Record<string, string>
  sessionId?: string
  /** Вложенный контент (например, активность саб-агента) — рендерится ВНУТРИ карточки, под заголовком. */
  children?: React.ReactNode
}

/** JSON-строка (аргументы тула) с плейсхолдерами секретов: текст + кликабельные бейджи. */
function ArgsWithSecrets({ text, secrets, sessionId }: { text: string; secrets?: Record<string, string>; sessionId?: string }) {
  const segments = splitBySecretPlaceholders(text)
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <SecretPlaceholder key={i} placeholder={seg.value} value={secrets?.[seg.value]} sessionId={sessionId} />
        ),
      )}
    </>
  )
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

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  text: string
}

function parseDiff(diffText: string): DiffLine[] {
  const lines = diffText.split('\n')
  return lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return { type: 'header' as const, text: line }
    }
    if (line.startsWith('+')) return { type: 'add' as const, text: line }
    if (line.startsWith('-')) return { type: 'remove' as const, text: line }
    return { type: 'context' as const, text: line }
  })
}

function DiffView({ diff }: { diff: string }) {
  const parsed = parseDiff(diff)
  return (
    <pre className="text-[0.6875rem] leading-relaxed overflow-x-auto font-mono m-0 p-0 bg-transparent">
      {parsed.map((line, i) => (
        <span
          key={i}
          className={
            line.type === 'add'
              ? 'diff-added block'
              : line.type === 'remove'
                ? 'diff-removed block'
                : line.type === 'header'
                  ? 'diff-header block'
                  : 'block opacity-70'
          }
        >
          {line.text || ' '}
        </span>
      ))}
    </pre>
  )
}

function SubagentResult({ result, toolCall: _toolCall }: { result: ToolCallData['result']; toolCall: ToolCallData }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const [showToolCalls, setShowToolCalls] = useState(false)

  if (!result?.metadata) return null

  const reasoning = result.metadata.reasoning as string | undefined
  const toolCalls = result.metadata.tool_calls as
    | Array<{ name: string; args: Record<string, unknown>; result: string }>
    | undefined

  return (
    <div className="space-y-2">
      {reasoning && (
        <div>
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            <Icon
              name={showReasoning ? 'arrow-down-s' : 'arrow-right-s'}
              className="size-3"
            />
            Рассуждения
          </button>
          {showReasoning && (
            <div className="pl-4 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-border/30">
              {truncate(reasoning, 3000)}
            </div>
          )}
        </div>
      )}

      {toolCalls && toolCalls.length > 0 && (
        <div>
          <button
            onClick={() => setShowToolCalls(!showToolCalls)}
            className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            <Icon
              name={showToolCalls ? 'arrow-down-s' : 'arrow-right-s'}
              className="size-3"
            />
            Инструменты ({toolCalls.length})
          </button>
          {showToolCalls && (
            <div className="pl-4 space-y-1">
              {toolCalls.map((tc, i) => (
                <div key={i} className="text-[0.6875rem] flex items-start gap-1.5">
                  <Icon name={getToolIcon(tc.name)} className="size-3 shrink-0 mt-0.5 text-muted-foreground" />
                  <div className="min-w-0">
                    <span className="font-medium">{getToolDisplayName(tc.name)}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      {truncate(tc.result.slice(0, 120), 120)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolCallPart({ toolCall, nested, secrets, sessionId, children }: ToolCallPartProps) {
  const { t } = useI18n()
  // i18n ядра: metadata.i18n у tool_result → перевод по ключу (fallback — content).
  const resolveI18nText = useResolveI18n()
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
  const isSubagent = toolCall.name === 'task'
  const subagentType = (toolCall.args as Record<string, unknown>)?.subagent_type as string | undefined
  const diff = toolCall.result?.metadata?.diff as string | undefined

  const argsStr = JSON.stringify(toolCall.args, null, 2)
  const resultStr = toolCall.result?.content || ''
  const localizedResult = toolCall.result
    ? resolveI18nText(toolCall.result.metadata?.i18n, resultStr)
    : ''

  const toolIcon = isSubagent ? 'robot-2' : getToolIcon(toolCall.name)
  const toolDisplayName = getToolDisplayName(toolCall.name)

  const headerColor = isError
    ? 'text-status-error'
    : isSubagent
      ? 'text-primary'
      : isRunning
        ? ''
        : isDone
          ? ''
          : ''

  const nameColor = isError ? 'text-status-error' : ''

  return (
    <div className={nested ? 'mb-1 ml-3' : 'mb-2'}>
      <div className="rounded-md border border-border bg-muted overflow-hidden">
        <button
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-3.5 transition-transform shrink-0"
          />
          <Icon
            name={toolIcon}
            className={`size-3.5 shrink-0 ${headerColor}${isRunning ? ' animate-tool-pulse' : ''}`}
          />
          <span className={`font-mono font-medium truncate ${nameColor}${isRunning ? ' animate-tool-pulse' : ''}`}>
            {isSubagent && subagentType
              ? `${t('chat.subagent.title')}: ${subagentType}`
              : toolDisplayName}
          </span>
          {toolCall.iteration != null && (
            <span className="text-[0.625rem] opacity-40 shrink-0">
              #{toolCall.iteration}
            </span>
          )}
          {duration && (
            <span className="text-[0.625rem] opacity-40 shrink-0">
              {duration}
            </span>
          )}
        </button>
        {expanded && (
          <div className="border-t border-border">
            {hasResult && !isRunning && (
              <div className="flex gap-0 border-b border-border/30">
                <button
                  className={`px-3 py-1 text-[0.6875rem] font-medium transition-colors ${
                    viewMode === 'args'
                      ? 'text-foreground border-b-2 border-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setViewMode('args')}
                >
                  {t('chat.toolCall.arguments')}
                </button>
                {!isSubagent && (
                  <button
                    className={`px-3 py-1 text-[0.6875rem] font-medium transition-colors ${
                      viewMode === 'result'
                        ? 'text-foreground border-b-2 border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => setViewMode('result')}
                  >
                    {t('chat.toolCall.result')}
                  </button>
                )}
                <button
                  className={`ml-auto px-2 py-1 text-[0.625rem] font-mono transition-colors ${
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
                <div className="px-3 py-1 text-[0.6875rem] font-medium text-blue-400">
                  {t('chat.toolCall.arguments')}
                </div>
                <button
                  className={`ml-auto px-2 py-1 text-[0.625rem] font-mono transition-colors ${
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
            {showDebug && (
              <div className="px-3 py-2 border-b border-amber-500/20 bg-amber-500/5">
                <pre className="text-[0.6875rem] text-amber-600 dark:text-amber-400 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
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
            <div className="p-3">
              {isSubagent && viewMode === 'result' && hasResult && (
                <div className="space-y-3">
                  <SubagentResult result={toolCall.result} toolCall={toolCall} />
                  <div className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {truncate(localizedResult, 4000)}
                  </div>
                </div>
              )}
              {viewMode === 'args' && (
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono">
                  <ArgsWithSecrets text={truncate(argsStr, 4000)} secrets={secrets} sessionId={sessionId} />
                </pre>
              )}
              {!isSubagent && viewMode === 'result' && hasResult && diff && (
                <DiffView diff={diff} />
              )}
              {!isSubagent && viewMode === 'result' && hasResult && !diff && (
                <pre className={`text-xs whitespace-pre-wrap overflow-x-auto font-mono ${
                  isError ? 'text-status-error' : 'text-muted-foreground'
                }`}>
                  {truncate(localizedResult, 4000)}
                </pre>
              )}
              {!hasResult && viewMode === 'result' && (
                <div className="text-xs text-muted-foreground/50 italic">
                  {t('common.empty')}
                </div>
              )}
            </div>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
