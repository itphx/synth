import { cn } from '@/lib/utils'
import { Fragment, memo, useId } from 'react'
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
import { buildPartsView, resolveLiveParts } from '@/lib/messageParts'
import { buildUsageSegments } from '@/lib/statsSegments'
import { moveSessionToBackground } from '@/lib/backgroundDetach'
import { StatsPopoverButton } from './StatsPopoverButton'
import { synthApi } from '@/lib/api/synthApi'
import { MESSAGES_PAGE_LIMIT } from '@/lib/api/messages'
import { applyHistoryPage } from '@/stores/transportStore'
import { useCallback, useMemo, useState } from 'react'
import { Icon } from '@/components/icon/Icon'

/**
 * Вызов инструмента в форме UI (имя есть — карточку рисовать можно).
 */
type UiToolCall = NonNullable<MessageData['tool_calls']>[number] & { name: string }

/**
 * Вызовы инструментов из устаревшего поля `tool_calls` сообщения.
 *
 * Форма UI — `{name, args, result, …}`. Сырой вызов провайдера
 * (`{type:'function', function:{name, arguments}}`) карточкой **не** является:
 * имени и аргументов в форме UI у него нет, а карточка вызова приходит в
 * финальном сообщении хода (с результатом) — её и рисуем. Иначе в блоке хода
 * появлялась бы пустая карточка («#0») рядом с настоящей.
 */
function useToolCallData(toolCalls: MessageData['tool_calls']) {
  return useMemo(() => {
    if (!toolCalls || toolCalls.length === 0) return []
    return toolCalls
      .filter((tc): tc is UiToolCall => typeof tc.name === 'string' && tc.name.length > 0)
      .map((tc) => ({
        callId: tc.id || `tc_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        args: tc.args ?? {},
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
  onCopy: (msg: MessageData, plain?: boolean) => void
  onToggle: (msg: MessageData) => void
  onPin: (msg: MessageData) => void
  onDelete: (msg: MessageData) => void
  onRetry: (msg: MessageData) => void
  onDebug: (msg: MessageData) => void
  onFork: (msg: MessageData) => void
  /**
   * ADR-118 §1: сообщение, дебаг которого открывает кнопка «Отладка».
   *
   * `debug_data` пишется только в **финальное** сообщение хода, а действия
   * рисуются у последнего сегмента каждой группы — в ходе, разорванном
   * уведомлением, у первой группы кнопки не было. `MessageList` передаёт сюда
   * дебаг-цель хода; `undefined` — цель — само сообщение (одиночные сообщения).
   */
  debugTarget?: MessageData
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
   * Новая UX-модель индикатора: заголовок агента/модели есть у **каждой**
   * assistant-группы хода; `compact` лишь убирает зазор между сегментами.
   */
  showHeader?: boolean
  /**
   * ADR-118 §1: сегмент хода, склеенный с предыдущим (без визуального зазора).
   */
  compact?: boolean
  /**
   * Ход идёт и это **последний** assistant-сегмент хода: в шапке вместо
   * времени — три точки (`MessageHeader processing`).
   */
  headerProcessing?: boolean
  /**
   * ADR-118 §1: сегмент внутри **общего** блока хода (группа из >1 сегмента):
   * «пузырь» (фон/рамка/скругление/отступы) рисует контейнер группы
   * (`MessageList`, `data-testid="turn-block"`), сегмент даёт только типографику.
   */
  bare?: boolean
  /** Показывать ряд действий сообщения (в блоке хода — только у последнего). */
  showActions?: boolean
  /** Активный автоповтор хода — плашка внизу ответа последнего сегмента. */
  retry?: StreamRetry | null
  /** Рисовать ли плашку автоповтора (только у последнего сегмента хода). */
  showRetry?: boolean
  onRetryNow?: () => void
  onCancelRetry?: () => void
  /**
   * ADR-118 §5: пустой живой сегмент (новый шаг до первого токена) рисуется
   * **только заголовком с точками** — без тела. Если сегмент не первый в
   * группе (`showHeader === false`), не рендерится: шапка блока уже несёт точки.
   */
  showLivePlaceholder?: boolean
  /**
   * Ключ группы-ответа для кнопки «Развернуть» в шапке. У многошагового хода
   * пузырь рисует контейнер группы (`MessageList`), у одношагового — сам
   * `ChatMessage`; ключ общий — `MessageGroup.key`.
   */
  expandKey?: string
  /** Развёрнут ли ответ агента на всю ширину области чата. */
  expanded?: boolean
  /** Тумблер разворота (стабильная ссылка из `MessageList`). */
  onToggleExpand?: (key: string) => void
  /**
   * Компактная плотность ленты (прошлый ход): не рисовать размышления,
   * промежуточные тексты и карточки инструментов. Карточки саб-агентов
   * (`item.type === 'subagent'`) остаются — это результат прогона.
   */
  serviceCollapsed?: boolean
  /** Вызовов инструментов в ходе — для строки-сводки скрытых шагов. */
  serviceToolCount?: number
  /** Блоков размышлений в ходе — для строки-сводки скрытых шагов. */
  serviceReasoningCount?: number
  /** Ключ группы-хода (сводка рендерится один раз на группу). */
  serviceKey?: string
  /** Сводка скрытых шагов раскрыта. */
  serviceExpanded?: boolean
  /** Тумблер сводки (стабильная ссылка из `MessageList`). */
  onToggleService?: (key: string) => void
}

export interface PendingStreamStatus {
  status: 'processing'
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
  headerProcessing = false,
  retry,
  showRetry = false,
  onRetryNow,
  onCancelRetry,
  showLivePlaceholder = false,
  debugTarget,
  expandKey,
  expanded = false,
  onToggleExpand,
  serviceCollapsed = false,
  serviceToolCount = 0,
  serviceReasoningCount = 0,
  serviceKey,
  serviceExpanded = false,
  onToggleService,
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
  // ADR-115: вложение, доставленное инструментом (`metadata.source === 'tool-attachment'`),
  // приходит как role:'user' с `author:'Tool'` — это служебный блок, а не
  // реплика пользователя (автор — не текущий пользователь).
  const isToolAttachment = isUser && message.metadata?.source === 'tool-attachment'
  // ADR-104: инъекция во время активного хода (`metadata.steer`) — **без
  // маркера**: реплика, вклинившаяся в ход, рисуется обычным пузырём.
  // Режим `interrupt` (`metadata.interrupt === true`) — маркером «прерывание
  // хода» (маркер остаётся).
  const isInterruptSteer = isUser && message.metadata?.interrupt === true
  // ADR-104 (этап 2): прерванная генерация (metadata.status === 'interrupted') —
  // ответ частичный, ход продолжился с новым сообщением.
  const isInterrupted = isAssistant && message.metadata?.status === 'interrupted'
  const canRetry = isUser
  /** Дебаг-цель хода (финальное сообщение с `debug_data`) — фоллбек на само сообщение. */
  const debugMessage = debugTarget ?? message
  const hasDebug =
    !!debugMessage.debug_data && Object.keys(debugMessage.debug_data).length > 0

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
  //
  // Развёрнутый ответ агента занимает всю ширину области чата: у пузыря —
  // `max-w-full` вместо `max-w-[85%]`. Именно выбор одного класса, а не
  // наложение двух: порядок в сгенерированном CSS не гарантирует победу
  // `max-w-full`. `bare`-сегменты не трогаем — их ширину задаёт контейнер группы.
  const bubbleClass = cn(
    bare
      ? 'w-full min-w-0 text-foreground'
      : cn(
          isAssistant && expanded ? 'max-w-full' : 'max-w-[85%]',
          'rounded-lg px-4 py-3',
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
  // `MessageActions` передаёт вторым аргументом режим копирования (Shift+клик —
  // без разметки); другие места (`Notice`, `CommandMessage`) его не передают.
  const handleCopy = useCallback(
    (_messageId?: string, plain?: boolean) => onCopy(message, plain),
    [onCopy, message],
  )
  const handleToggle = useCallback(() => onToggle(message), [onToggle, message])
  const handlePin = useCallback(() => onPin(message), [onPin, message])
  const handleDelete = useCallback(() => onDelete(message), [onDelete, message])
  const handleRetry = useCallback(() => onRetry(message), [onRetry, message])
  const handleDebug = useCallback(
    () => onDebug(debugTarget ?? message),
    [onDebug, message, debugTarget],
  )
  const handleFork = useCallback(() => onFork(message), [onFork, message])
  const handleToggleSelect = useCallback(
    (shiftKey: boolean) => {
      if (!message.id) return
      onToggleSelect?.(message.id, shiftKey)
    },
    [onToggleSelect, message.id]
  )

  /**
   * Тумблер разворота ответа на всю ширину. Пропс прокидывается в шапку
   * **только для ответа агента**; ссылка стабильна при неизменных
   * `expandKey`/`onToggleExpand` — `React.memo(ChatMessage)` не слетает.
   */
  const handleToggleExpand = useCallback(() => {
    if (expandKey && onToggleExpand) onToggleExpand(expandKey)
  }, [expandKey, onToggleExpand])

  /**
   * Компактная плотность ленты: сводка скрытых шагов хода. Показываем её, когда
   * есть что скрывать (`serviceKey` передаёт только владелец сводки группы).
   * Колбэк/идентификатор стабильны — `React.memo(ChatMessage)` не слетает.
   */
  const serviceStepCount = serviceToolCount + serviceReasoningCount
  const hasServiceSummary =
    !!onToggleService && !!serviceKey && serviceStepCount > 0
  const serviceContentId = useId()
  const handleToggleService = useCallback(() => {
    if (serviceKey) onToggleService?.(serviceKey)
  }, [serviceKey, onToggleService])
  const serviceSummaryLabel = useMemo(() => {
    const chunks: string[] = []
    if (serviceToolCount > 0) chunks.push(t('chat.compact.tools', { count: serviceToolCount }))
    if (serviceReasoningCount > 0) {
      chunks.push(t('chat.compact.reasoning', { count: serviceReasoningCount }))
    }
    return chunks.join(' · ')
  }, [serviceToolCount, serviceReasoningCount, t])

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
  const intermediateTextMode = useUIStore((s) => s.intermediateTextDisplay)
  const isInline = intermediateTextMode !== 'bottom'
  const isLive = message.status === 'streaming'

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
  /**
   * Live-части — источник истины **во время шага**. У финального сообщения
   * источник истины — части/контент из истории («застрявшие» части шага давали
   * в блоке хода текст чужого шага), но пока части из истории не пришли
   * (окно между `step.finished` и ответом `GET /messages`) live-части остаются
   * фоллбеком — иначе текст, который пользователь уже видел, исчезал бы на
   * миг (ADR-118 §5).
   */
  const liveParts = useMemo(() => {
    // Нормализация вызова тула (`{name, args}`) — внутри `buildPartsView`.
    const parts = livePartMap ? Object.values(livePartMap) : undefined
    return resolveLiveParts(parts, { isLive, dtoParts: message.parts })
  }, [isLive, livePartMap, message.parts])
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

  /**
   * ADR-118 §1/§5: промежуточные тексты.
   *
   * Текст каждого шага лежит в **своём** сообщении шага (сегмент хода) —
   * он и рисуется в этом сегменте. У сообщения финального шага
   * `intermediate_text_blocks` — это тексты *прошлых* шагов: они уже
   * нарисованы в своих сегментах склеенного блока хода, рисовать их снова
   * нельзя (текст шага дублировался бы в блоке хода); промежуточный текст,
   * совпадающий с основным текстом сообщения, тоже не рисуется — основной
   * текст показывается ровно один раз.
   */
  const isLaterStep = typeof message.step_index === 'number' && message.step_index > 0
  const intermediateTextBlocks = useMemo(() => {
    if (isLaterStep) return []
    const blocks = getIntermediateTextBlocks(message)
    const main = partsView.text.trim()
    if (!main) return blocks
    return blocks.filter((block) => block.text.trim() !== main)
  }, [isLaterStep, message, partsView.text])

  /**
   * ADR-111 §detach + ADR-070 §2.6: живое сообщение несёт индикатор хода,
   * live-статистику, «В фон» и «Стоп» (отдельной плашки стрима больше нет —
   * индикатор живёт в самом сегменте шага/в строке активности хода).
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

  const getSubagentData = (tc: LiveToolCall): SubagentPartData | null => {
    if (tc.name !== 'task') return null
    const meta = tc.result?.metadata as Record<string, unknown> | undefined
    const args = (tc.args ?? {}) as Record<string, unknown>
    const prompt = typeof args.prompt === 'string' ? args.prompt : undefined
    const liveReasoning = tc.subagentReasoningBlocks ?? []
    const liveTexts = tc.subagentIntermediateTextBlocks ?? []
    /**
     * Живой саб-агент (в т.ч. **синхронный**, блокирующий ход).
     *
     * Пока прогон идёт, `result.metadata` ещё нет: шаги ребёнка приходят
     * событиями `subagent.progress` (размышления/промежуточный текст) и
     * `tool_call.*` с `parent_call_id` (вызовы внутри ребёнка). Строим
     * карточку из этих данных — иначе в основной сессии был виден только
     * PROMPT, а шаги и ответ появлялись лишь после завершения.
     */
    if (!meta && prompt == null && liveReasoning.length === 0 && liveTexts.length === 0) {
      return null
    }
    const running = tc.status === 'running'
    const metaToolCalls = meta?.tool_calls as SubagentPartData['tool_calls']
    /**
     * ADR-111: **фоновый** прогон. У него `result.metadata` — только
     * `child_session_id`/`status`/`background_run_id`: тул вернул управление
     * сразу, публикация в родительский стрим отключена, поэтому ни шагов, ни
     * `tool_calls` в метаданных нет. Шаги лежат в истории дочерней сессии —
     * карточка догружает их лениво (`stores/subagentRunsStore`).
     */
    const background = meta?.child_session_id != null
      && metaToolCalls == null
      && meta?.steps == null
    return {
      name: (meta?.subagent_type as string) || (args.subagent_type as string) || 'task',
      prompt,
      response: (meta?.final_content as string) || (meta?.description as string) || '',
      sessionId: meta?.child_session_id as string | undefined,
      callId: tc.callId,
      live: running,
      running,
      background,
      errorInfo: {
        isError: tc.result?.isError === true || meta?.error === true,
        attempts: meta?.attempts as number | undefined,
        maxRetries: meta?.max_retries as number | undefined,
        errorType: meta?.error_type as string | undefined,
        error: meta?.error as string | undefined,
      },
      reasoning_blocks:
        (meta?.reasoning_blocks as SubagentPartData['reasoning_blocks'])
        ?? (liveReasoning.length > 0 ? liveReasoning : undefined),
      intermediate_text_blocks:
        (meta?.intermediate_text_blocks as SubagentPartData['intermediate_text_blocks'])
        ?? (liveTexts.length > 0 ? liveTexts : undefined),
      tool_calls: metaToolCalls,
      steps: meta?.steps as number | undefined,
      description: (args.description as string | undefined) || (meta?.description as string | undefined),
    }
  }

  /**
   * Вызовы инструментов **внутри** саб-агента (`parent_call_id` = callId
   * карточки). В основной ленте они не рисуются отдельными карточками —
   * они шаги саб-агента внутри его блока.
   */
  const childToolCalls = (callId: string): NonNullable<SubagentPartData['tool_calls']> =>
    liveToolCalls
      .filter((c) => c.parentCallId === callId)
      .map((c) => ({
        name: c.name,
        args: c.args,
        id: c.callId,
        result: c.result
          ? { content: c.result.content, isError: c.result.isError }
          : undefined,
        started_at: c.startedAt,
        completed_at: c.completedAt,
        iteration: c.iteration,
      }))

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
                // Живые шаги ребёнка — из событий с `parent_call_id`
                // (у завершённого прогона они уже в `result.metadata`).
                if (!sa.tool_calls || sa.tool_calls.length === 0) {
                  const child = childToolCalls(tc.callId)
                  if (child.length > 0) sa.tool_calls = child
                }
                if (sa.steps == null && sa.tool_calls && sa.tool_calls.length > 0) {
                  sa.steps = Math.max(...sa.tool_calls.map((c) => c.iteration || 0)) + 1
                }
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
          // Компактная плотность прошлого хода: карточки саб-агентов — это
          // результат прогона, их оставляем; размышления, промежуточные тексты
          // и карточки инструментов скрыты строкой-сводкой.
          if (serviceCollapsed && item.type !== 'subagent') return null
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

  /**
   * Контент частей при наличии сводки оборачиваем в невидимый контейнер
   * (`display: contents` — раскладка не меняется) ради `aria-controls`.
   */
  const partsContentEl =
    hasServiceSummary && partsContent
      ? (
          <div id={serviceContentId} data-service-content="" className="contents">
            {partsContent}
          </div>
        )
      : partsContent

  /**
   * Тихая строка-сводка скрытых шагов (компактная плотность): «N инструментов ·
   * M размышлений». Клик раскрывает/скрывает содержимое хода.
   */
  const serviceSummaryEl = hasServiceSummary ? (
    <button
      type="button"
      data-testid="service-summary"
      aria-expanded={serviceExpanded}
      aria-controls={serviceContentId}
      aria-label={serviceExpanded ? t('chat.compact.collapse') : t('chat.compact.expand')}
      title={serviceExpanded ? t('chat.compact.collapse') : t('chat.compact.expand')}
      onClick={handleToggleService}
      className="service-summary"
    >
      <Icon name={serviceReasoningCount > 0 ? 'brain' : 'tools'} className="size-3.5" />
      {serviceExpanded ? t('chat.compact.hide') : serviceSummaryLabel}
    </button>
  ) : null

  // ADR-070 §2.6: пустой отменённый ответ (отмена до первого токена) всё равно
  // показываем — статус «Остановлено» и статистика идут через metadata.
  // ADR-115: сообщение только из вложений (картинка от ассистента без текста) — тоже рендерим.
  // Новая UX-модель индикатора: пустой живой сегмент (новый шаг до первого
  // токена) рисуется **только заголовком с точками** — без тела.
  // Компакт: сегмент со сводкой не должен исчезать, даже если весь его контент
  // скрыт (иначе пропала бы строка-сводка с тумблером).
  if (
    !displayContent &&
    !message.reasoning &&
    liveToolCalls.length === 0 &&
    reasoningBlocks.length === 0 &&
    intermediateTextBlocks.length === 0 &&
    !hasAttachments &&
    !showStats &&
    !hasServiceSummary
  ) {
    if (!isAssistant || !showLivePlaceholder || !showHeader) return null
    return (
      <div className={containerClass} data-message-id={message.id} data-role={message.role}>
        <div className={bubbleClass} data-bubble="">
          <MessageHeader
            message={message}
            isSubagent={isSubagent}
            onOriginClick={handleOriginClick}
            processing={headerProcessing}
          />
        </div>
      </div>
    )
  }

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
    // Автопродолжение после рестарта: отдельная подпись вместо общего «Инфо»;
    // текст блока локализуется штатно — из `metadata.i18n`.
    const isRestartResumed = isInfo
      && (message.metadata as Record<string, unknown> | undefined)?.type === 'restart_resumed'
    const label = isRestartResumed
      ? t('chat.notice.restartResumed')
      : t(`chat.notice.${noticeVariant}`)
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

  // ADR-115: вложение, доставленное инструментом, — центрированный служебный
  // блок (как у фонового результата), а не правый user-пузырь: автор сообщения —
  // системный `Tool`, агент — в `metadata.agent_role`. Подпись —
  // «Агент · <имя> · вложение» (без известной роли — «Агент · вложение»),
  // внутри — вложения сообщения, действия — полный набор.
  if (isToolAttachment) {
    const meta = message.metadata as Record<string, unknown> | undefined
    const role = typeof meta?.agent_role === 'string' ? meta.agent_role : ''
    const agentName = role
      ? agents.find((a) => a.id === role)?.display_name || role
      : ''
    const label = agentName
      ? t('chat.notice.toolAttachment', { name: agentName })
      : t('chat.notice.toolAttachmentAnonymous')

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

    const attachmentEl = (
      <Notice
        variant="attachment"
        icon="attachment-2"
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
        {hasAttachments && sessionId ? (
          <MessageAttachments sessionId={sessionId} parts={messageParts} />
        ) : null}
      </Notice>
    )

    if (!selectionMode) return attachmentEl
    return (
      <div className="flex items-start">
        {selectionCheckboxEl}
        <div className="min-w-0 flex-1">{attachmentEl}</div>
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
    <div className={containerClass} data-message-id={message.id} data-role={message.role}>
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
      <div className={bubbleClass} data-bubble="">
        {/*
          ADR-104: маркер **прерывания** хода (`metadata.interrupt`) — оставлен.
          Маркера «вмешательство в ход» (`metadata.steer`) больше нет: реплика,
          вклинившаяся в ход, рисуется обычным пузырём ( ADR-118 §4).
        */}
        {isInterruptSteer && (
          <span
            className="mb-1 inline-flex items-center gap-1 self-end rounded-sm bg-primary/10 px-1.5 py-0.5 text-[11px] leading-4 text-primary"
            title={t('chat.steer.interruptMarker')}
          >
            <Icon name="stop" className="size-3" />
            {t('chat.steer.interruptMarker')}
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
          <MessageHeader
            message={message}
            isSubagent={isSubagent}
            onOriginClick={handleOriginClick}
            processing={headerProcessing}
            expanded={expanded}
            // Кнопка «Развернуть» — только у ответа агента; в user-шапку,
            // metaOnly-шапки (Notice/фон/планировщик) и пустой live-сегмент
            // пропс не передаётся.
            onToggleExpand={onToggleExpand ? handleToggleExpand : undefined}
          />
        )}

        {partsContentEl}

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

        {/* Автоповтор хода — внизу ответа у последнего сегмента (не у реплики). */}
        {serviceSummaryEl}

        {showRetry && retry && (
          <RetryStatus retry={retry} onRetryNow={onRetryNow} onCancelRetry={onCancelRetry} />
        )}

        {/*
          ADR-118 §1/§5: live-статистика и «В фон» (ADR-111 §detach) — в
          **конце** содержимого сегмента. Точек-индикатора в теле больше нет:
          «идёт» показывают точки в шапке последнего сегмента хода.
        */}
        {isLive && (
          <div className="mt-1 flex flex-wrap items-center gap-1 self-start text-[11px] text-muted-foreground">
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
      const result = await synthApi.getSessionMessages(currentSessionId, { limit: MESSAGES_PAGE_LIMIT })
      // Снимок — страница истории: мерж с живым состоянием (не `setMessages`),
      // иначе догруженные старые страницы ленты терялись бы.
      applyHistoryPage(currentSessionId, result)
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
