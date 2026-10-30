import { cn } from '@/lib/utils'
import { Fragment, memo } from 'react'
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
import { Notice, type NoticeVariant } from './Notice'
import { MessageAttachments, hasMediaParts } from './attachments/MessageAttachments'
import {
  backgroundNoticeName,
  backgroundNoticeRelayedFrom,
  backgroundToolCall,
  resolveBackgroundKind,
  resolveBackgroundState,
} from './background-notice'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useI18n, useResolveI18n } from '@/lib/i18n'
import type { MessageData, LiveToolCall, ReasoningBlockData, IntermediateTextBlockData, StreamRetry } from '@/stores/chatStore'
import { buildPartsView } from '@/lib/messageParts'
import { buildUsageSegments } from '@/lib/statsSegments'
import { moveSessionToBackground } from '@/lib/backgroundDetach'
import { StatsPopoverButton } from './StatsPopoverButton'
import { synthApi } from '@/lib/api/synthApi'
import { useCallback, useMemo, useState } from 'react'
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
  /**
   * Сессия сообщения — для URL вложений (`/sessions/:id/attachments/:partId`).
   * Не задана — берётся из активной центральной вкладки.
   */
  sessionId?: string
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
  /** ADR-118 §7: выделение адресуется по `id` сообщения (индекс нестабилен). */
  onToggleSelect?: (messageId: string, shiftKey: boolean) => void
  /**
   * Статус активного стрима, связанного с этим user-сообщением (по metadata.stream_id),
   * пока провайдер ещё не вернул ни одного чанка. null — статус не показываем.
   */
  pending?: PendingStreamStatus | null
  /**
   * ADR-118 §1: заголовок агента/модели — только у **первого** сегмента хода.
   * Последующие сегменты того же хода рисуются без заголовка.
   */
  showHeader?: boolean
  /**
   * ADR-118 §1: сегмент хода, склеенный с предыдущим (без визуального зазора).
   */
  compact?: boolean
  /**
   * ADR-118 §1: сегмент внутри **общего** блока хода (группа из >1 сегмента):
   * «пузырь» (фон/рамка/скругление/отступы) рисует контейнер группы
   * (`MessageList`, `data-testid="turn-block"`), сегмент даёт только типографику.
   */
  bare?: boolean
  /** Показывать ряд действий сообщения (в блоке хода — только у последнего). */
  showActions?: boolean
  /** Статус повторной попытки — показывается в живом сообщении. */
  retry?: StreamRetry | null
  onRetryNow?: () => void
  onCancelRetry?: () => void
}

export interface PendingStreamStatus {
  status: 'processing' | 'retrying'
  retry?: StreamRetry | null
  onRetryNow?: () => void
  onCancelRetry?: () => void
}

function ChatMessageInner({
  message,
  sessionId: sessionIdProp,
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
  showHeader = true,
  compact = false,
  bare = false,
  showActions = true,
  retry,
  onRetryNow,
  onCancelRetry,
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isError = message.role === 'error'
  const isInfo = message.role === 'info'
  const isSummary = message.role === 'summary'
  const isDebug = message.role === 'debug'
  // ADR-051: сообщения планировщика (source:'cron') приходят как role:'user' с
  // metadata.scheduler === true — рисуем их служебным Notice, а не user-пузырём.
  const isScheduler = isUser && message.metadata?.scheduler === true
  // ADR-111/ADR-113: уведомление о завершении фонового прогона приходит как
  // role:'user' с metadata.type === 'background_run_result' — тоже системный
  // блок (автор прогона — не текущий пользователь, конверт модели в UI лишний).
  const isBackgroundResult = isUser && message.metadata?.type === 'background_run_result'
  // ADR-104: инъекция во время активного хода (metadata.steer === true) —
  // помечаем маркером «вмешательство в ход»; режим `interrupt`
  // (metadata.interrupt === true) — маркером «прерывание хода».
  const isSteered = isUser && message.metadata?.steer === true
  const isInterruptSteer = isUser && message.metadata?.interrupt === true
  // ADR-104 (этап 2): прерванная генерация (metadata.status === 'interrupted') —
  // ответ частичный, ход продолжился с новым сообщением.
  const isInterrupted = isAssistant && message.metadata?.status === 'interrupted'
  const canRetry = isUser
  const hasDebug = !!message.debug_data && Object.keys(message.debug_data).length > 0

  // LLM Gateway (ADR-036): реальные значения секретов для плейсхолдеров ⟦SYNTH_SECRET_N⟧.
  const secrets = (message.metadata?.secrets as Record<string, string> | undefined) ?? undefined
  // i18n ядра: metadata.i18n → перевод по ключу (fallback — content).
  const resolveI18nText = useResolveI18n()
  const { t } = useI18n()
  const i18nMeta = message.metadata?.i18n
  // Реестр агентов — подсветка `@`-упоминаний в сообщениях пользователя.
  const agents = useAgentsStore((s) => s.agents)
  const activeTab = useUIStore((s) => s.centerTabs.find((t) => t.id === s.activeCenterTabId))
  // Сессия — из пропа (MessageList/ChatTab), фоллбек — активная вкладка:
  // от неё зависят URL вложений и подсветка плейсхолдеров секретов.
  const sessionId = sessionIdProp || (activeTab?.data?.sessionId as string) || undefined
  // Отладка открыта глобально (chatStore) — подсветить кнопку только у того
  // сообщения и сессии, для которых вызвано окно.
  const debugModalSessionId = useChatStore((s) => s.debugModalSessionId)
  const debugModalMessageId = useChatStore((s) => s.debugModalMessageId)
  const debugActive =
    !!sessionId && debugModalSessionId === sessionId && !!message.id && debugModalMessageId === message.id

  const containerClass = cn(
    'flex group',
    bare ? 'w-full min-w-0 px-0' : 'px-4',
    bare || compact ? 'py-0' : 'py-3',
    selectionMode ? 'flex-row items-start' : 'flex-col',
    isUser && 'items-end',
    isAssistant && 'items-start'
  )

  // ADR-118 §1: `bare` — сегмент внутри общего блока хода: пузырь рисует
  // контейнер группы, здесь только типографика (и состояния disabled/pinned).
  const bubbleClass = cn(
    bare
      ? 'w-full min-w-0 text-foreground'
      : cn(
          'max-w-[85%] rounded-lg px-4 py-3',
          isUser && 'bg-primary/10 text-foreground rounded-br-sm',
          isAssistant && 'bg-card border border-border/50 text-foreground rounded-bl-sm',
        ),
    message.disabled && 'opacity-50 line-through',
    message.pinned && 'ring-1 ring-primary/30',
  )

  const actionsSupported = isUser || isAssistant || isSummary || isDebug
  const actionsVisible = showActions && actionsSupported

  // ADR-070 §2.6: строка статистики — только для ответов ассистента с данными.
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
    (shiftKey: boolean) => {
      if (!message.id) return
      onToggleSelect?.(message.id, shiftKey)
    },
    [onToggleSelect, message.id]
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
  const fallbackToolCalls = useToolCallData(toolCalls)
  const fallbackReasoning = getReasoningBlocks(message)
  const intermediateTextBlocks = getIntermediateTextBlocks(message)
  const intermediateTextMode = useUIStore((s) => s.intermediateTextDisplay)
  const isInline = intermediateTextMode !== 'bottom'

  /**
   * ADR-118 §5: единственный источник контента — **части**. Живое сообщение
   * (статус `streaming`) и финальное рисуются одним компонентом: текст,
   * рассуждения и вызовы инструментов собираются из частей (`parts` из DTO +
   * накопленное живое состояние `partsBySession`).
   */
  const livePartMap = useChatStore((s) => {
    if (!sessionId || !message.id) return undefined
    return s.partsBySession[sessionId]?.[message.id]
  })
  const liveParts = useMemo(
    () => (livePartMap ? Object.values(livePartMap) : undefined),
    [livePartMap]
  )
  const partsView = useMemo(
    () => buildPartsView(message.parts, liveParts, {
      content: message.content,
      reasoningBlocks: fallbackReasoning,
      toolCalls: fallbackToolCalls,
    }),
    [message.parts, liveParts, message.content, fallbackReasoning, fallbackToolCalls]
  )
  const liveToolCalls = partsView.toolCalls
  const reasoningBlocks = partsView.reasoning
  const isLive = message.status === 'streaming'

  /**
   * ADR-111 §detach + ADR-070 §2.6: живое сообщение несёт индикатор хода,
   * live-статистику, «В фон» и «Стоп» (прежде — отдельная плашка
   * `StreamingPlaceholder`; теперь — тот же компонент, что и финальное).
   */
  const [detaching, setDetaching] = useState(false)
  const detachTargets = liveToolCalls.filter(
    (c) => c.status === 'running' && (c.name === 'task' || c.name === 'execute_shell'),
  )
  const canDetach = isLive && !!sessionId && detachTargets.length > 0
  const handleBackground = () => {
    if (!sessionId || detaching) return
    setDetaching(true)
    void moveSessionToBackground(sessionId, {
      callIds: detachTargets.map((c) => c.callId),
    }).finally(() => setDetaching(false))
  }
  const liveSegments = useMemo(() => buildUsageSegments({
    usage: message.usage ?? undefined,
    costUsd: typeof message.metadata?.cost_usd === 'number' ? message.metadata.cost_usd : undefined,
    costCurrency: typeof message.metadata?.cost_currency === 'string' ? message.metadata.cost_currency : undefined,
    tokenPrefix: message.metadata?.usage_estimated === true ? '~' : '',
  }, t), [message.usage, message.metadata, t])

  // ADR-046 §7.1: локальный ответ системной (builtin) команды — нейтральный
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
    ? [...intermediateTextBlocks.map((it) => it.text), partsView.text].filter(Boolean).join('\n\n')
    : null
  const displayContent = bottomContent ?? partsView.text

  // ADR-115: вложения приходят частями сообщения (у user и у assistant —
  // ассистент может вернуть картинку/файл через тул).
  const messageParts = message.parts ?? []
  const hasAttachments = hasMediaParts(messageParts)

  // ADR-046 §7.1: reasoning / intermediate / tool-call блоки. Для assistant
  // рендерятся в пузыре напрямую, для summary/debug — внутри Notice-тела.
  const partsContent = isAssistant || isSummary || isDebug
    ? (() => {
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
                <SecretMarkdown content={item.data.text} secrets={secrets} sessionId={sessionId} streaming={isLive} />
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
    : null

  // ADR-070 §2.6: пустой отменённый ответ (отмена до первого токена) всё равно
  // показываем — статус «Остановлено» и статистика идут через metadata.
  // ADR-115: сообщение только из вложений (картинка от ассистента без текста) — тоже рендерим.
  if (
    !displayContent &&
    !message.reasoning &&
    liveToolCalls.length === 0 &&
    reasoningBlocks.length === 0 &&
    intermediateTextBlocks.length === 0 &&
    !hasAttachments &&
    !showStats
  ) return null

  // ADR-046 §7.1: служебные сообщения (сводка/отладка/ошибка/инфо) — единый Notice.
  const noticeVariant: NoticeVariant | null = isSummary
    ? 'summary'
    : isDebug
      ? 'debug'
      : isError
        ? 'error'
        : isInfo
          ? 'info'
          : null

  if (noticeVariant) {
    const label = t(`chat.notice.${noticeVariant}`)
    const withMeta = noticeVariant === 'summary' || noticeVariant === 'debug'
    const selectionCheckboxEl = selectionMode ? (
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
    ) : null

    const noticeEl = (
      <Notice
        variant={noticeVariant}
        label={label}
        ariaLabel={label}
        meta={withMeta ? <MessageHeader message={message} metaOnly /> : undefined}
        actions={
          withMeta && actionsVisible ? (
            <MessageActions
              embedded
              showCopy={false}
              messageId={message.id}
              role={message.role}
              disabled={message.disabled}
              pinned={message.pinned}
              canRetry={canRetry}
              hasDebug={hasDebug}
              debugActive={debugActive}
              readOnly={readOnly}
              hasStats={showStats}
              statsContent={<MessageStats message={message} />}
              onCopy={handleCopy}
              onToggle={handleToggle}
              onPin={handlePin}
              onDelete={handleDelete}
              onRetry={handleRetry}
              onDebug={handleDebug}
              onFork={handleFork}
            />
          ) : undefined
        }
        onCopy={handleCopy}
        disabled={message.disabled}
      >
        {withMeta && partsContent}
        {displayContent &&
          (isInfo && (message.metadata as Record<string, unknown>)?.type === 'session_reference' ? (
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
          ))}
      </Notice>
    )

    if (!selectionMode) return noticeEl
    return (
      <div className="flex items-start">
        {selectionCheckboxEl}
        <div className="min-w-0 flex-1">{noticeEl}</div>
      </div>
    )
  }

  // ADR-111/ADR-113: уведомление о завершении фонового прогона — центрированный
  // системный блок (`Notice`, как у сообщений планировщика): шапка с иконкой
  // прогона и подписью «Фоновый процесс · <команда> · <статус>», внутри —
  // сворачиваемая карточка результата (лог или итог прогона без конверта
  // `<process …>`/`<subagent …>` — конверт нужен модели, в чате лишний).
  // Действия — полный набор как у user-сообщения (внутри `Notice`).
  if (isBackgroundResult) {
    const metadata = message.metadata ?? undefined
    const kind = resolveBackgroundKind(metadata)
    const state = resolveBackgroundState(metadata)
    const name = backgroundNoticeName(metadata, kind)
    const baseLabel =
      kind === 'subagent'
        ? t('chat.notice.backgroundSubagent', { name })
        : t('chat.notice.backgroundProcess', { name })
    const stateLabel =
      state === 'failed'
        ? t('chat.notice.backgroundState.failed')
        : state === 'cancelled'
          ? t('chat.notice.backgroundState.cancelled')
          : t('chat.notice.backgroundState.completed')
    // Без имени («Фоновый процесс · ») убираем висящий разделитель.
    const relayedFrom = backgroundNoticeRelayedFrom(metadata)
    const relayedSuffix = relayedFrom
      ? ` · ${t('chat.backgroundNotice.relayedFrom', { title: relayedFrom })}`
      : ''
    const label = `${name ? baseLabel : baseLabel.replace(/\s*·\s*$/, '')} · ${stateLabel}${relayedSuffix}`

    const selectionCheckboxEl = selectionMode ? (
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
    ) : null

    const backgroundEl = (
      <Notice
        variant="process"
        icon={kind === 'subagent' ? 'robot-2' : 'terminal-box'}
        label={label}
        ariaLabel={label}
        meta={<MessageHeader message={message} metaOnly />}
        actions={
          actionsVisible ? (
            <MessageActions
              embedded
              showCopy={false}
              messageId={message.id}
              role={message.role}
              disabled={message.disabled}
              pinned={message.pinned}
              canRetry={canRetry}
              hasDebug={hasDebug}
              debugActive={debugActive}
              readOnly={readOnly}
              hasStats={showStats}
              statsContent={<MessageStats message={message} />}
              onCopy={handleCopy}
              onToggle={handleToggle}
              onPin={handlePin}
              onDelete={handleDelete}
              onRetry={handleRetry}
              onDebug={handleDebug}
              onFork={handleFork}
            />
          ) : undefined
        }
        onCopy={handleCopy}
        disabled={message.disabled}
      >
        <ToolCallPart
          toolCall={backgroundToolCall(metadata, displayContent)}
          resultFirst
          plain
          secrets={secrets}
          sessionId={sessionId}
        />
      </Notice>
    )

    if (!selectionMode) return backgroundEl
    return (
      <div className="flex items-start">
        {selectionCheckboxEl}
        <div className="min-w-0 flex-1">{backgroundEl}</div>
      </div>
    )
  }

  // ADR-051: служебное сообщение планировщика (source:'cron') — центрированный
  // блок с иконкой расписания и подписью «Планировщик · <имя задания>» вместо
  // правого user-пузыря с шапкой текущего пользователя. Контент — чистый текст
  // задания; действия — полный набор как у user-сообщения.
  if (isScheduler) {
    const scheduleName = message.metadata?.schedule_name
    const label =
      typeof scheduleName === 'string' && scheduleName.length > 0
        ? t('chat.notice.schedulerNamed', { name: scheduleName })
        : t('chat.notice.scheduler')

    const selectionCheckboxEl = selectionMode ? (
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
    ) : null

    const schedulerEl = (
      <Notice
        variant="scheduler"
        label={label}
        ariaLabel={label}
        meta={<MessageHeader message={message} metaOnly />}
        actions={
          actionsVisible ? (
            <MessageActions
              embedded
              showCopy={false}
              messageId={message.id}
              role={message.role}
              disabled={message.disabled}
              pinned={message.pinned}
              canRetry={canRetry}
              hasDebug={hasDebug}
              debugActive={debugActive}
              readOnly={readOnly}
              hasStats={showStats}
              statsContent={<MessageStats message={message} />}
              onCopy={handleCopy}
              onToggle={handleToggle}
              onPin={handlePin}
              onDelete={handleDelete}
              onRetry={handleRetry}
              onDebug={handleDebug}
              onFork={handleFork}
            />
          ) : undefined
        }
        onCopy={handleCopy}
        disabled={message.disabled}
      >
        {displayContent && (
          <SecretMarkdown
            content={resolveI18nText(i18nMeta, displayContent)}
            secrets={secrets}
            sessionId={sessionId}
          />
        )}
      </Notice>
    )

    if (!selectionMode) return schedulerEl
    return (
      <div className="flex items-start">
        {selectionCheckboxEl}
        <div className="min-w-0 flex-1">{schedulerEl}</div>
      </div>
    )
  }

  return (
    <div className={containerClass} data-message-id={message.id}>
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
        {isSteered && (
          <span
            className="mb-1 inline-flex items-center gap-1 self-end rounded-sm bg-primary/10 px-1.5 py-0.5 text-[11px] leading-4 text-primary"
            title={isInterruptSteer ? t('chat.steer.interruptMarker') : t('chat.steer.marker')}
          >
            <Icon name={isInterruptSteer ? 'stop' : 'send-plane'} className="size-3" />
            {isInterruptSteer ? t('chat.steer.interruptMarker') : t('chat.steer.marker')}
          </span>
        )}

        {isInterrupted && (
          <span
            className="mb-1 inline-flex items-center gap-1 self-start rounded-sm bg-status-warning/15 px-1.5 py-0.5 text-[11px] leading-4 text-status-warning"
            title={t('chat.steer.interruptMarker')}
          >
            <Icon name="stop" className="size-3" />
            {t('chat.messageStats.interrupted')}
          </span>
        )}

        {isAssistant && showHeader && (
          <MessageHeader message={message} isSubagent={isSubagent} onOriginClick={handleOriginClick} />
        )}

        {isLive && (
          <span className="mb-1 inline-flex gap-0.5 self-start" aria-hidden="true">
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="size-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
        )}

        {/*
          ADR-118 §5: живое сообщение несёт индикатор активности хода — прежняя
          отдельная плашка `StreamingPlaceholder` теперь здесь: live-статистика
          и «В фон» (ADR-111 §detach). Остановка хода — общей кнопкой композера.
        */}
        {isLive && (
          <div className="mb-1 flex flex-wrap items-center gap-1 self-start text-[11px] text-muted-foreground">
            {liveSegments.length > 0 && (
              <StatsPopoverButton>
                <span className="flex flex-nowrap items-center gap-1 whitespace-nowrap" data-testid="live-stats">
                  {liveSegments.map((segment, i) => (
                    <Fragment key={segment}>
                      {i > 0 && <span aria-hidden="true">·</span>}
                      <span>{segment}</span>
                    </Fragment>
                  ))}
                </span>
              </StatsPopoverButton>
            )}
            {canDetach && (
              <button
                type="button"
                onClick={handleBackground}
                disabled={detaching}
                title={t('chat.background.hint')}
                aria-label={t('chat.background.move')}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-interactive-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <Icon name="download" className="size-3" />
                {t('chat.background.move')}
              </button>
            )}
          </div>
        )}

        {isLive && retry && (
          <RetryStatus retry={retry} onRetryNow={onRetryNow} onCancelRetry={onCancelRetry} />
        )}

        {partsContent}

        {isUser && (
          <MessageHeader
            message={message}
            isSubagent={isSubagent}
            onOriginClick={handleOriginClick}
            processing={pending?.status === 'processing'}
          />
        )}

        {hasAttachments && sessionId && (
          <MessageAttachments sessionId={sessionId} parts={messageParts} />
        )}

        {displayContent && (
          isUser ? (
            <SecretPlainText content={displayContent} secrets={secrets} sessionId={sessionId} agents={agents} />
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
              streaming={isLive}
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

        {actionsVisible && (
          <MessageActions
            messageId={message.id}
            role={message.role}
            disabled={message.disabled}
            pinned={message.pinned}
            canRetry={canRetry}
            hasDebug={hasDebug}
            debugActive={debugActive}
            readOnly={readOnly}
            hasStats={showStats}
            // ADR-070 §2.6: статистика ответа — в поповере по кнопке (единый путь).
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
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-status-info/5 border border-status-info/15 text-xs">
      {/* Заголовок с иконкой и названием */}
      <div className="flex items-center gap-2">
        <Icon name="link" className="h-4 w-4 text-status-info shrink-0" />
        <span className="font-medium text-status-info truncate">
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
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] font-medium text-status-info hover:bg-status-info/10 transition-colors"
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
