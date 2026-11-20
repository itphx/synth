import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { getToolIcon, getToolDisplayName } from '@/lib/toolIcons'
import { useI18n, useResolveI18n } from '@/lib/i18n'
import { moveSessionToBackground } from '@/lib/backgroundDetach'
import { splitBySecretPlaceholders, SecretPlaceholder } from './SecretPlaceholder'
import { DiffView } from './DiffView'
import { AnsiText } from '@/components/ansi/AnsiText'

interface ToolCallData {
  name: string
  args: Record<string, unknown>
  id?: string
  callId?: string
  /**
   * Состояние вызова (ADR-118, addendum MESSAGE_FLOW §8.2):
   * - `queued` — вызов ещё **не стартовал** (стоит за барьером, ждёт
   *   подтверждения, ждёт медленного соседа по батчу): ядро публикует
   *   `tool_call.started` в момент фактического старта, до него карточка
   *   нейтральная и без индикатора работы;
   * - `running` — вызов исполняется (`tool_call.started` пришёл);
   * - `done` — исход известен (`tool_call.result`).
   */
  status?: 'queued' | 'running' | 'done'
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
  /** Реальные значения секретов для плейсхолдеров ⟦SYNTH_SECRET_N⟧ (ADR-036). */
  secrets?: Record<string, string>
  sessionId?: string
  /** Вложенный контент (например, активность саб-агента) — рендерится ВНУТРИ карточки, под заголовком. */
  children?: React.ReactNode
  /**
   * Карточка без заливки — для вложения в системный блок (`Notice`):
   * ряд-детализация, а не «карточка в карточке».
   */
  plain?: boolean
  /**
   * Результат — главное содержимое карточки: вкладка «Результат» доступна
   * даже для тула `task` и открыта по умолчанию (тело видно сразу после
   * раскрытия карточки).
   */
  resultFirst?: boolean
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

/** Строка пары «вопрос → ответ» для карточки тула `question`. */
interface QuestionAnswerRow {
  header?: string
  question: string
  answer: string
}

/**
 * Пары «вопрос → выбранный ответ» из аргументов и результата тула `question`.
 *
 * Источник — `result.metadata.answers` (`string[][]`, значения `options[].value`)
 * и `args.questions` (состав вопроса). Значения маппятся на `options[].label`;
 * неизвестное значение показывается как есть; несколько выбранных вариантов
 * (`multiple`) — через запятую. Форма не совпала — `null` (рендерим прежний
 * текст результата).
 */
function questionAnswerRows(
  args: Record<string, unknown> | undefined,
  result: ToolCallData['result'] | undefined,
): QuestionAnswerRow[] | null {
  const answers = result?.metadata?.answers
  const questions = args?.questions
  if (!Array.isArray(answers) || !Array.isArray(questions)) return null
  const rows: QuestionAnswerRow[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index] as Record<string, unknown> | null | undefined
    if (!item || typeof item !== 'object') return null
    const question = typeof item.question === 'string' ? item.question : ''
    if (!question) return null
    const selected = answers[index]
    if (!Array.isArray(selected)) return null
    const options = Array.isArray(item.options)
      ? (item.options as Array<Record<string, unknown> | null | undefined>)
      : []
    const values = selected.map((value) => {
      const raw = typeof value === 'string' ? value : String(value)
      const option = options.find((candidate) => candidate && candidate.value === raw)
      const label = option && typeof option.label === 'string' ? option.label : ''
      return label || raw
    })
    rows.push({
      ...(typeof item.header === 'string' && item.header ? { header: item.header } : {}),
      question,
      answer: values.join(', '),
    })
  }
  return rows.length > 0 ? rows : null
}

/** Читаемые пары «вопрос → ответ» в карточке тула `question`. */
function QuestionAnswers({
  rows,
  emptyText,
}: {
  rows: QuestionAnswerRow[]
  emptyText: string
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${index}-${row.question}`} className="text-xs">
          {row.header && (
            <div className="text-[0.6875rem] font-medium text-muted-foreground">{row.header}</div>
          )}
          <div className="font-medium text-foreground">{row.question}</div>
          <div className="mt-0.5 text-muted-foreground whitespace-pre-wrap">
            {row.answer || <span className="italic opacity-60">{emptyText}</span>}
          </div>
        </div>
      ))}
    </div>
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

export function ToolCallPart({ toolCall, nested, secrets, sessionId, children, plain, resultFirst }: ToolCallPartProps) {
  const { t } = useI18n()
  // i18n ядра: metadata.i18n у tool_result → перевод по ключу (fallback — content).
  const resolveI18nText = useResolveI18n()
  // `question`: ответы пользователя — главное содержимое, вкладка «Результат»
  // открывается по умолчанию, но только если результат уже есть (иначе
  // показываем аргументы — вопросы и варианты).
  const isQuestionTool = toolCall.name === 'question'
  const preferQuestionResult = isQuestionTool && !!toolCall.result?.content
  const [expanded, setExpanded] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [viewMode, setViewMode] = useState<'args' | 'result'>(
    resultFirst || preferQuestionResult ? 'result' : 'args',
  )
  // ADR-111 §detach: перевод идущего `execute_shell` в фон — состояние
  // запроса и признак «уже переведён» (повторную кнопку не показываем).
  const [detaching, setDetaching] = useState(false)
  const [detached, setDetached] = useState(false)

  const isError = toolCall.result?.isError
  /** Вызов ещё не стартовал: нейтральная карточка без индикатора работы. */
  const isQueued = toolCall.status === 'queued'
  const isRunning = toolCall.status === 'running'
  // Результат закрывает карточку и у вызова без явного `done` (история до
  // ADR-118): прежнее правило сохранено, `queued` его не ослабляет.
  const isDone = toolCall.status === 'done' || (!isRunning && !!toolCall.result)
  const started = toolCall.startedAt || toolCall.started_at
  const completed = toolCall.completedAt || toolCall.completed_at
  // Длительности у нестартовавшего вызова нет: показывать «0ms»/время от
  // посева — врать про исполнение.
  const duration = isQueued ? '' : formatDuration(started, completed)
  const hasResult = !!toolCall.result?.content
  const isSubagent = toolCall.name === 'task'

  /**
   * ADR-111 §detach: «В фон» — только у идущего `execute_shell` открытого
   * чата. Переводятся именно блокирующие вызовы этой сессии, поэтому нужен
   * `sessionId` и `callId` парта.
   */
  const canDetach =
    isRunning && toolCall.name === 'execute_shell' && !!sessionId && !detached

  const handleBackground = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (!sessionId || detaching || detached) return
    setDetaching(true)
    void moveSessionToBackground(sessionId, {
      type: 'process',
      callIds: toolCall.callId ? [toolCall.callId] : undefined,
    })
      .then((response) => {
        if (response) setDetached(true)
      })
      .finally(() => setDetaching(false))
  }
  // Спец-рендер результата `question` — пары «вопрос → ответ»; форма не
  // совпала — прежний текст результата.
  const questionRows = isQuestionTool ? questionAnswerRows(toolCall.args, toolCall.result) : null
  // `resultFirst` — результат главное содержимое: вкладка «Результат» есть и
  // для `task` (карточка фонового прогона), и открыта по умолчанию.
  const showResultTab = !isSubagent || resultFirst === true
  const subagentType = (toolCall.args as Record<string, unknown>)?.subagent_type as string | undefined
  const diff = toolCall.result?.metadata?.diff as string | undefined

  const argsStr = JSON.stringify(toolCall.args, null, 2)
  const resultStr = toolCall.result?.content || ''
  const localizedResult = toolCall.result
    ? resolveI18nText(toolCall.result.metadata?.i18n, resultStr)
    : ''

  const toolIcon = isSubagent ? 'robot-2' : getToolIcon(toolCall.name)

  const headerColor = isError
    ? 'text-status-error'
    : isSubagent
      ? 'text-primary'
      : isQueued
        ? 'text-muted-foreground/60'
        : isRunning
          ? ''
          : isDone
            ? ''
            : ''

  const nameColor = isError
    ? 'text-status-error'
    : isQueued
      ? 'text-muted-foreground/70'
      : ''

  return (
    <div className={nested ? 'mb-1 ml-3' : plain ? 'mb-0' : 'mb-2'}>
      <div
        data-card="service"
        data-tool-status={toolCall.status ?? ''}
        className={cn(
          'rounded-md border overflow-hidden',
          plain ? 'border-transparent' : 'border-border bg-muted'
        )}
      >
        <div className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <button
            data-tool-call-toggle="1"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
                : getToolDisplayName(toolCall.name)}
            </span>
            {toolCall.iteration != null && (
              <span className="text-[0.625rem] opacity-40 shrink-0">
                #{toolCall.iteration}
              </span>
            )}
            {/* `queued`: вызов ещё не стартовал — подпись вместо индикатора работы. */}
            {isQueued && (
              <span
                data-testid="tool-call-queued"
                className="shrink-0 text-[0.625rem] text-muted-foreground/70"
              >
                {t('chat.tool.queued')}
              </span>
            )}
            {duration && (
              <span className="text-[0.625rem] opacity-40 shrink-0">
                {duration}
              </span>
            )}
          </button>
          {canDetach && (
            <button
              type="button"
              disabled={detaching}
              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.625rem] text-primary transition-colors hover:bg-primary/10 hover:text-primary/80 cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent"
              onClick={handleBackground}
              title={t('chat.background.hint')}
              aria-label={t('chat.background.move')}
              data-testid="tool-call-background"
            >
              <Icon name="download" className="size-3" />
              {t('chat.background.move')}
            </button>
          )}
        </div>
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
                {showResultTab && (
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
                      ? 'text-status-warning'
                      : 'text-muted-foreground/40 hover:text-muted-foreground'
                  }`}
                  onClick={() => setShowDebug(!showDebug)}
                >
                  {t('chat.toolCall.debug')}
                </button>
              </div>
            )}
            {(isRunning || isQueued) && (
              <div className="flex items-center gap-0 border-b border-border/30">
                <div
                  className={`px-3 py-1 text-[0.6875rem] font-medium ${
                    isQueued ? 'text-muted-foreground' : 'text-status-info'
                  }`}
                >
                  {t('chat.toolCall.arguments')}
                </div>
                <button
                  className={`ml-auto px-2 py-1 text-[0.625rem] font-mono transition-colors ${
                    showDebug
                      ? 'text-status-warning'
                      : 'text-muted-foreground/40 hover:text-muted-foreground'
                  }`}
                  onClick={() => setShowDebug(!showDebug)}
                >
                  {t('chat.toolCall.debug')}
                </button>
              </div>
            )}
            {showDebug && (
              <div className="px-3 py-2 border-b border-status-warning/20 bg-status-warning/5">
                <pre className="text-[0.6875rem] text-status-warning whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
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
              {!isSubagent && viewMode === 'result' && hasResult && isQuestionTool && questionRows && (
                <QuestionAnswers rows={questionRows} emptyText={t('common.empty')} />
              )}
              {!isSubagent && viewMode === 'result' && hasResult && !(isQuestionTool && questionRows) && diff && (
                <DiffView diff={diff} />
              )}
              {!isSubagent && viewMode === 'result' && hasResult && !(isQuestionTool && questionRows) && !diff && (
                <pre className={`text-xs whitespace-pre-wrap overflow-x-auto font-mono ${
                  isError ? 'text-status-error' : 'text-muted-foreground'
                }`} data-testid="tool-call-result-text">
                  <AnsiText text={truncate(localizedResult, 4000)} colors testId="tool-call-result-ansi" />
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
