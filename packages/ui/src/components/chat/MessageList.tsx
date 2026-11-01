import { Fragment, useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChatMessage, type PendingStreamStatus } from './ChatMessage'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { ScrollableOverlay } from '../ui/ScrollableOverlay'
import { isVisibleMessage } from './messageVisibility'
import { turnHasContent } from '@/lib/messageParts'
import {
  sortMessagesByOrd,
  useChatStore,
  type ActiveTurn,
  type MessageData,
  type StreamRetry,
} from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'

/**
 * Группа сообщений ленты (ADR-118 §1): **сегменты одного хода** склеиваются в
 * одну группу — заголовок (агент/модель) рисуется только у первого сегмента,
 * между сегментами нет вертикального зазора.
 */
export interface MessageGroup {
  /** Стабильный ключ группы (для React/виртуализатора). */
  key: string
  /** Ход группы; `null` — сообщение вне хода (user/системное). */
  turnId: string | null
  messages: MessageData[]
}

/** Счётчики «скрытых» шагов хода для сводки компактной плотности. */
export interface ServiceCounts {
  tools: number
  reasoning: number
}

/**
 * Сгруппировать сообщения по ходу (`turn_id`).
 *
 * - порядок — по `ord` (`sortMessagesByOrd`): при равном `ord` — тай-брейк по
 *   `id`; если `ord` есть только у одного сообщения — по `created_at`
 *   (позиционный `index` с `ord` не смешивается);
 * - соседние сообщения склеиваются, только если у них **один** `turn_id` и ни
 *   одно из них не user-реплика;
 * - вставленное user-сообщение (вмешательство, ADR-104) **разделяет** сегменты
 *   хода: оно само — отдельная группа и не склеивается с соседями своего хода.
 */
export function groupMessagesByTurn(messages: MessageData[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let current: MessageGroup | null = null

  for (const msg of sortMessagesByOrd(messages)) {
    const turnId = msg.turn_id ?? null
    const prev = current?.messages[current.messages.length - 1]
    const joinsTurn =
      current !== null &&
      turnId !== null &&
      current.turnId === turnId &&
      prev !== undefined &&
      prev.role !== 'user' &&
      msg.role !== 'user'

    if (joinsTurn && current) {
      current.messages.push(msg)
      continue
    }

    current = {
      key: `${turnId ? `turn:${turnId}` : 'msg'}:${msg.id ?? msg.index}`,
      turnId,
      messages: [msg],
    }
    groups.push(current)
  }

  return groups
}

interface MessageListProps {
  messages: MessageData[]
  /**
   * ADR-118 §1: активный ход сессии (`turnBySession`) — границы группировки и
   * источник статуса «идёт обработка» у user-реплики.
   */
  turn?: ActiveTurn | null
  /** Сессия — для URL вложений сообщений (ADR-115). */
  sessionId?: string
  onCopy: (msg: MessageData) => void
  onToggle: (msg: MessageData) => void
  onPin: (msg: MessageData) => void
  /** ADR-118 §10: pin на контейнере хода — все сегменты группы. */
  onPinTurn?: (segments: MessageData[]) => void
  onDelete: (msg: MessageData) => void
  onRetry: (msg: MessageData) => void
  onDebug: (msg: MessageData) => void
  onFork: (msg: MessageData) => void
  readOnly?: boolean
  /** true если сессия — дочерняя (сабагент) */
  isSubagent?: boolean
  selectionMode?: boolean
  /** ADR-118 §7: выделение адресуется по `id` сообщения (индекс нестабилен). */
  selectedIds?: Set<string>
  onToggleSelect?: (messageId: string, shiftKey: boolean) => void
  onSelectRange?: (fromMessageId: string, toMessageId: string) => void
  /** Статус повторной попытки (stream.retry) — показываем вместо «крутилки» */
  retry?: StreamRetry | null
  onRetryNow?: () => void
  onCancelRetry?: () => void
}

const VIRTUALIZE_THRESHOLD = 30
const OVERSCAN = 30

/**
 * ADR-118 §1: «пузырьными» классами рисует группа-ход из нескольких сегментов —
 * её сегменты идут с `bare` (только типографика, без собственной карточки).
 * Значения совпадают с assistant-пузырём `ChatMessage`.
 */
const TURN_BLOCK_CLASS =
  'group flex w-full max-w-[85%] flex-col items-start rounded-lg px-4 py-3 bg-card border border-border/50 text-foreground rounded-bl-sm'

/**
 * Тот же блок хода, но **развёрнутый** на всю ширину области чата.
 *
 * Отдельная готовая строка классов, а не наложение `max-w-[85%]` + `max-w-full`:
 * порядок правил в сгенерированном CSS не гарантирует победу `max-w-full`.
 */
const TURN_BLOCK_CLASS_EXPANDED =
  'group flex w-full max-w-full flex-col items-start rounded-lg px-4 py-3 bg-card border border-border/50 text-foreground rounded-bl-sm'

/** Сегмент, который обычно рисует собственный пузырь (assistant без системной команды). */
function isBubbleSegment(msg: MessageData): boolean {
  return msg.role === 'assistant' && msg.metadata?.command !== true
}

/**
 * Группа рендерится **одним** блоком-пузырём, если в ней больше одного сегмента
 * и все они — assistant-шаги (user-реплики в группы не склеиваются по построению,
 * а служебные `Notice`-сообщения блок не образуют).
 */
function isTurnBlock(group: MessageGroup): boolean {
  return group.messages.length > 1 && group.messages.every(isBubbleSegment)
}

/**
 * Ключ сообщения для адресации (ADR-118 §7) — `id`; у legacy-сообщений без
 * `id` — позиционный индекс (иначе статус «обработка» к ним не привязать).
 */
function messageKeyOf(msg: MessageData): string {
  return msg.id ?? `idx:${msg.index}`
}

/**
 * Реплика **человека** (не служебная).
 *
 * Плашка «обработка»/«повтор» должна быть у реплики пользователя. Но
 * служебные сообщения тоже приходят с `role: 'user'` и рисуются как
 * `Notice` (без плашки): уведомление о фоне
 * (`metadata.type === 'background_run_result'`), сообщения шедулера и
 * системные команды. Если такая реплика оказывалась последней, плашка
 * уезжала на неё, а индикатор работы хода пропадал.
 */
function isHumanReply(msg: MessageData): boolean {
  const meta = msg.metadata
  if (!meta) return true
  if (meta.type === 'background_run_result') return false
  if (meta.state === true) return false
  if (meta.commandPrompt === true) return false
  if (meta.scheduler) return false
  if (msg.author === 'Scheduler') return false
  return true
}

/**
 * Статус «идёт обработка» у последней user-реплики, пока в ходе ещё нет живого
 * сообщения (первой дельты). Возвращает `null` — статус не показываем.
 *
 * Автоповтор (`retry`) у реплики больше не рисуется: `RetryStatus` живёт внизу
 * последнего сегмента ответа (новая UX-модель индикатора).
 */
function computePendingStatus(
  turn: ActiveTurn | null | undefined,
): PendingStreamStatus | null {
  if (!turn || turn.status !== 'streaming') return null
  return { status: 'processing' }
}

export function MessageList({
  messages,
  turn,
  sessionId,
  onCopy,
  onToggle,
  onPin,
  onPinTurn,
  onDelete,
  onRetry,
  onDebug,
  onFork,
  readOnly,
  isSubagent,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onSelectRange,
  retry,
  onRetryNow,
  onCancelRetry,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chatZoneRef = useRef<HTMLDivElement>(null)
  const [btnLeft, setBtnLeft] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const lastClickedRef = useRef<string | null>(null)

  /**
   * Развёрнутые на всю ширину ответы агента. Состояние **runtime** (не
   * персистится), ключ — `MessageGroup.key`: у многошагового хода пузырь рисует
   * контейнер группы, у одношагового ответа — сам `ChatMessage`.
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())

  /**
   * Тумблер разворота группы. Стабильная ссылка (`useCallback`): пропсы
   * `onToggleExpand`/`expandKey` в `ChatMessage` не должны быть новыми на каждом
   * рендере списка, иначе слетает `React.memo(ChatMessage)`
   * (`ChatMessage.memo.test.tsx`).
   */
  const toggleGroupExpanded = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /**
   * Раскрытые человеком сводки скрытых шагов прошлых ходов (компактная
   * плотность). Состояние **runtime** (не персистится), ключ — `MessageGroup.key`.
   * Стабильная ссылка (`useCallback`) — иначе слетит `React.memo(ChatMessage)`.
   */
  const [revealedServiceGroups, setRevealedServiceGroups] = useState<Set<string>>(() => new Set())

  const toggleServiceExpanded = useCallback((key: string) => {
    setRevealedServiceGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const chatDensity = useUIStore((s) => s.chatDensity)
  const chatViewMode = useUIStore((s) => s.chatViewMode)

  // Кнопка «Вниз»: чуть правее правой границы зоны чата; если места справа нет — внутрь зоны.
  useEffect(() => {
    const container = containerRef.current
    const zone = chatZoneRef.current
    if (!container || !zone) return

    const update = () => {
      const cw = container.clientWidth
      const zw = zone.clientWidth
      const zoneRight = (cw - zw) / 2 + zw
      const btnW = 36
      const gap = 8
      setBtnLeft(cw - zoneRight >= btnW + gap ? zoneRight + gap : cw - btnW - gap)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(container)
    ro.observe(zone)
    return () => ro.disconnect()
  }, [])

  /**
   * ADR-118 §5: живой контент — **части** сообщения (`partsBySession`), а не
   * отдельный «стрим». Для автоскролла хватает объёма накопленного текста.
   */
  const livePartsSize = useChatStore((s) => {
    if (!sessionId) return 0
    const byMessage = s.partsBySession[sessionId]
    if (!byMessage) return 0
    let size = 0
    for (const parts of Object.values(byMessage)) {
      for (const part of Object.values(parts)) size += part.text.length + (part.raw?.length ?? 0)
    }
    return size
  })

  // Служебные сообщения tool-chain (metadata.tool_chain === true) не рендерятся
  // отдельными пузырями — их визуальное представление уже в сообщениях шагов
  // хода (части, вызовы инструментов, рассуждения — ADR-118 §1). Durable
  // state-сообщения режима/плана/todo (ADR-070 §2.8) тоже скрыты в UI.
  const visibleMessages = useMemo(() => messages.filter(isVisibleMessage), [messages])
  /** Группы-ходы (ADR-118 §1) — единица рендера и виртуализации. */
  const groups = useMemo(() => groupMessagesByTurn(visibleMessages), [visibleMessages])

  /**
   * Счётчики «скрытых» шагов по `turn_id` (не по группе: фоновое уведомление
   * делит ход на две группы). Источник — части сообщения (`tool_use`,
   * `reasoning`); фоллбек — DTO-поля `tool_calls`/`reasoning_blocks` (старые
   * сообщения без частей).
   */
  const serviceCountsByTurn = useMemo(() => {
    const map = new Map<string, ServiceCounts>()
    for (const msg of visibleMessages) {
      if (!msg.turn_id) continue
      const parts = Array.isArray(msg.parts) ? msg.parts : []
      let tools = 0
      let reasoning = 0
      for (const part of parts) {
        if (part?.type === 'tool_use') tools += 1
        else if (part?.type === 'reasoning') reasoning += 1
      }
      if (tools === 0) tools = msg.tool_calls?.length ?? 0
      if (reasoning === 0) {
        reasoning = msg.reasoning_blocks?.length ?? (msg.reasoning ? 1 : 0)
      }
      if (tools === 0 && reasoning === 0) continue
      const acc = map.get(msg.turn_id) ?? { tools: 0, reasoning: 0 }
      acc.tools += tools
      acc.reasoning += reasoning
      map.set(msg.turn_id, acc)
    }
    return map
  }, [visibleMessages])

  /**
   * Последний assistant-сегмент каждого хода: `turnId → id` последнего
   * assistant-сообщения его **последней** группы (группа после `Notice` тоже
   * учитывается — она идёт позже, значит её сегмент и будет последним).
   *
   * Внизу этого сегмента рисуется плашка автоповтора (`RetryStatus`).
   */
  const lastTurnSegmentId = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of groups) {
      if (!group.turnId) continue
      for (const msg of group.messages) {
        if (msg.role !== 'assistant' || !msg.id) continue
        map.set(group.turnId, msg.id)
      }
    }
    return map
  }, [groups])

  /**
   * Последняя **assistant**-группа каждого хода (`turnId → key`) — визуальный
   * блок, чья шапка (первый сегмент) несёт точки «идёт», пока ход активен.
   * Группы без assistant-сегментов (уведомления) не в счёт: у них своя шапка.
   */
  const lastTurnGroupKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of groups) {
      if (!group.turnId) continue
      if (!group.messages.some((msg) => msg.role === 'assistant')) continue
      map.set(group.turnId, group.key)
    }
    return map
  }, [groups])

  /**
   * ADR-118 §5: контент хода уже начался? — **единый предикат**
   * (`turnHasContent`): флаг `contentStarted` хода либо непустой контент
   * assistant-сообщения хода (для восстановленного после перезагрузки хода).
   *
   * Пока контента нет, индикатор «идёт» живёт **у реплики пользователя**
   * (точки «обработка»); после первой части ответа — у последнего сегмента
   * хода (точки в шапке вместо времени).
   */
  const turnContentStarted = useMemo(
    () => turnHasContent(visibleMessages, turn),
    [visibleMessages, turn],
  )

  /**
   * Статус «обработка/повтор» — только у последней **человеческой**
   * user-реплики и только пока контент хода ещё не начался (до первой части
   * ответа). Мемоизирован, чтобы `React.memo(ChatMessage)` не сбрасывался на
   * каждом рендере списка.
   *
   * ADR-118 §7: адресация — по `id` сообщения (индекс нестабилен).
   */
  const pendingById = useMemo(() => {
    const map = new Map<string, PendingStreamStatus>()
    if (turnContentStarted) return map
    const status = computePendingStatus(turn)
    if (!status) return map
    const humanReplies = visibleMessages.filter((m) => m.role === 'user' && isHumanReply(m))
    // Реплика текущего хода (`turn_id` хода) — приоритетная: реплики без
    // `turn_id` (уведомления о фоне, служебные) этому ходу не принадлежат.
    const turnId = turn?.turnId
    const hasOwnReply = !!turnId && humanReplies.some((m) => m.turn_id === turnId)
    const candidates = hasOwnReply
      ? humanReplies.filter((m) => m.turn_id != null)
      : humanReplies
    const lastUser = candidates[candidates.length - 1]
    if (!lastUser) return map
    if (turn?.turnId && lastUser.turn_id && lastUser.turn_id !== turn.turnId) return map
    map.set(messageKeyOf(lastUser), status)
    return map
  }, [visibleMessages, turn, turnContentStarted])

  /**
   * `toolsRunning` — идёт вызов инструмента шага (`step.tools.started`):
   * контента ответа может не быть, но ход жив — пустой живой сегмент рисуется
   * заголовком с точками, а не пузырём.
   */
  const toolsRunning = turn?.toolsRunning === true

  /**
   * Дебаг-цель каждого хода: последнее assistant-сообщение этого `turn_id` с
   * непустым `debug_data` (пишется только в **финальное** сообщение хода).
   * Кнопка «Отладка» видна у любого сегмента хода — включая первую группу,
   * если ход разорван уведомлением (вторая группа с тем же `turn_id`).
   */
  const debugTargetByTurn = useMemo(() => {
    const map = new Map<string, MessageData>()
    for (const group of groups) {
      if (!group.turnId) continue
      for (const msg of group.messages) {
        if (msg.role !== 'assistant') continue
        if (!msg.debug_data || Object.keys(msg.debug_data).length === 0) continue
        map.set(group.turnId, msg)
      }
    }
    return map
  }, [groups])

  /**
   * ADR-118 §10: pin на контейнере хода — у группы из нескольких сегментов
   * действие первого сегмента пинит **весь** ход. Обработчики мемоизированы,
   * чтобы `React.memo(ChatMessage)` не сбрасывался на каждом рендере списка.
   */
  const pinTurnHandlers = useMemo(() => {
    if (!onPinTurn) return null
    const map = new Map<string, (msg: MessageData) => void>()
    for (const group of groups) {
      if (group.messages.length > 1) map.set(group.key, () => onPinTurn(group.messages))
    }
    return map
  }, [groups, onPinTurn])

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: OVERSCAN,
  })

  /**
   * Смена плотности или вида меняет высоту каждой группы (свёрнутые ходы
   * заметно ниже, «лента» снимает пузырь и отступы): без сброса кэша
   * `estimateSize` виртуализатор считал бы позиции по старым оценкам и лента
   * «прыгала». Авто-скролл вниз — в эффекте ниже (зависимости `chatDensity` и
   * `chatViewMode`).
   */
  useEffect(() => {
    virtualizer.measure()
  }, [chatDensity, chatViewMode, virtualizer])

  const scrollToBottom = useCallback((smooth = true) => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    })
    setAutoScroll(true)
    setShowScrollBtn(false)
  }, [])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 60
    setAutoScroll(atBottom)
    setShowScrollBtn(!atBottom && scrollHeight > clientHeight + 100)

    const hasTop = scrollTop > 1
    const hasBottom = scrollHeight - scrollTop - clientHeight > 1
    const el = scrollRef.current
    if (hasTop && hasBottom) {
      el.setAttribute('data-scroll-shadow', 'top-bottom')
    } else if (hasTop) {
      el.setAttribute('data-scroll-shadow', 'top')
    } else if (hasBottom) {
      el.setAttribute('data-scroll-shadow', 'bottom')
    } else {
      el.removeAttribute('data-scroll-shadow')
    }
  }, [])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollToBottom(false)
      })
    }
  }, [messages, livePartsSize, turn?.status, autoScroll, scrollToBottom, chatDensity, chatViewMode])

  const shouldVirtualize = visibleMessages.length > VIRTUALIZE_THRESHOLD
  const virtualItems = virtualizer.getVirtualItems()

  const handleToggleSelect = useCallback((messageId: string, shiftKey: boolean) => {
    if (shiftKey && lastClickedRef.current != null) {
      // Границы диапазона вычисляет стор (по позициям в отсортированной ленте).
      onSelectRange?.(lastClickedRef.current, messageId)
    } else {
      onToggleSelect?.(messageId, shiftKey)
    }
    lastClickedRef.current = messageId
  }, [onToggleSelect, onSelectRange])

  const renderSegment = (
    group: MessageGroup,
    msg: MessageData,
    first: boolean,
    opts?: { bare?: boolean; last?: boolean },
  ) => {
    const bare = opts?.bare === true
    const last = opts?.last === true
    // Одна шапка на визуальный блок: у первого сегмента группы. Точки «идёт» —
    // в шапке **последнего блока активного хода**, независимо от того, какой
    // сегмент сейчас стримится (шаг может быть уже `completed` — идут инструменты).
    const isHeaderSegment =
      first &&
      !!turn &&
      turn.status === 'streaming' &&
      group.turnId != null &&
      group.turnId === turn.turnId &&
      lastTurnGroupKey.get(group.turnId) === group.key
    // Автоповтор — внизу **последнего** сегмента активного хода.
    const isLastTurnSegment =
      !!turn &&
      turn.status === 'streaming' &&
      group.turnId != null &&
      group.turnId === turn.turnId &&
      msg.role === 'assistant' &&
      msg.id != null &&
      lastTurnSegmentId.get(group.turnId) === msg.id
    const segmentRetry = isLastTurnSegment && retry && turn?.streamId && retry.streamId === turn.streamId
      ? retry
      : null
    // ADR-118 §10: у контейнера хода pin пинит весь ход — у первого сегмента
    // (прежнее поведение) и у последнего в едином блоке (там ряд действий).
    const pinTurn = pinTurnHandlers?.get(group.key)
    const pinHandler = (first || (bare && last)) && pinTurn ? pinTurn : onPin
    /**
     * Компактная плотность: прошлый (завершённый) ход сворачивается в одну
     * тихую строку-сводку. Текущий ход и ход с ошибкой всегда раскрыты.
     * Содержимое скрывается у **каждого** сегмента группы, сводка — у её
     * последнего assistant-сегмента (там же ряд действий) — строка стоит ровно
     * перед `MessageActions`.
     */
    const isPastTurn = group.turnId != null && group.turnId !== turn?.turnId
    const groupHasError = group.messages.some((m) => m.status === 'error')
    const groupHasAssistant = group.messages.some((m) => m.role === 'assistant')
    const serviceActive =
      chatDensity === 'compact' && isPastTurn && !groupHasError && groupHasAssistant
    const serviceRevealed = revealedServiceGroups.has(group.key)
    const serviceCollapsed = serviceActive && !serviceRevealed
    const serviceCounts = group.turnId ? serviceCountsByTurn.get(group.turnId) : undefined
    let summaryOwnerKey: string | undefined
    for (const m of group.messages) {
      if (m.role === 'assistant') summaryOwnerKey = messageKeyOf(m)
    }
    // Сводка — у последнего assistant-сегмента **своего** блока; счётчики при
    // этом общие на ход (`turn_id`), поэтому у хода, разорванного уведомлением,
    // обе группы показывают суммарные числа.
    const ownsSummary = serviceActive && summaryOwnerKey === messageKeyOf(msg)
    return (
      <ChatMessage
        key={msg.id ?? `${msg.role}-${msg.index}-${msg.created_at}`}
        message={msg}
        sessionId={sessionId}
        onCopy={onCopy}
        onToggle={onToggle}
        onPin={pinHandler}
        onDelete={onDelete}
        onRetry={onRetry}
        onDebug={onDebug}
        onFork={onFork}
        readOnly={readOnly}
        isSubagent={isSubagent}
        selectionMode={selectionMode}
        isSelected={msg.id ? (selectedIds?.has(msg.id) ?? false) : false}
        onToggleSelect={handleToggleSelect}
        pending={pendingById.get(messageKeyOf(msg)) ?? null}
        // Одна шапка «агент · модель · время» на визуальный блок — у первого
        // сегмента группы.
        showHeader={first}
        compact={!first}
        // ADR-118 §1: в общем блоке хода пузырь рисует контейнер группы.
        bare={bare}
        // …и ряд действий — только у последнего сегмента (внизу блока).
        showActions={!bare || last}
        // Пока ход идёт — в шапке последнего блока точки вместо времени.
        headerProcessing={isHeaderSegment}
        // Пустой живой сегмент (новый шаг до первого токена) — только шапка с
        // точками; до начала контента хода индикатор живёт у реплики.
        showLivePlaceholder={
          msg.status === 'streaming' && (turn?.contentStarted === true || toolsRunning)
        }
        retry={segmentRetry}
        showRetry={segmentRetry != null}
        onRetryNow={onRetryNow}
        onCancelRetry={onCancelRetry}
        /**
         * ADR-118 §1: дебаг-цель хода (финальное сообщение с `debug_data`).
         * `undefined` — цель совпадает с самим сообщением (одиночные сообщения).
         */
        debugTarget={group.turnId ? debugTargetByTurn.get(group.turnId) : undefined}
        // Разворот ответа агента на всю ширину: ключ — группа (ход), ссылки
        // стабильны между рендерами (см. `toggleGroupExpanded`).
        expandKey={group.key}
        expanded={expandedGroups.has(group.key)}
        onToggleExpand={toggleGroupExpanded}
        // Компактная плотность ленты: у прошлых ходов скрываем размышления и
        // карточки инструментов, оставляя тихую строку-сводку (раскрывается
        // кликом). Все значения — примитивы, колбэк стабилен (memo).
        serviceCollapsed={serviceCollapsed}
        serviceToolCount={ownsSummary ? (serviceCounts?.tools ?? 0) : 0}
        serviceReasoningCount={ownsSummary ? (serviceCounts?.reasoning ?? 0) : 0}
        serviceKey={ownsSummary ? group.key : undefined}
        serviceExpanded={serviceRevealed}
        onToggleService={serviceActive ? toggleServiceExpanded : undefined}
      />
    )
  }

  /** Одна группа-ход: либо контейнер-пузырь с `bare`-сегментами, либо как раньше. */
  const renderGroup = (group: MessageGroup) => {
    const turnBlock = isTurnBlock(group)
    const segments = group.messages.map((msg, i) => {
      const segment = renderSegment(group, msg, i === 0, {
        bare: turnBlock,
        last: i === group.messages.length - 1,
      })
      if (!turnBlock || i === 0) return segment
      // Между шагами — тонкий разделитель, без отдельных карточек. Это
      // **отдельный пустой элемент** (сиблиг сегмента), а не обёртка сегмента:
      // так DOM хода однороден и структурное CSS-правило
      // (`styles/index.css`) снимает нижний отступ последнего блока
      // предыдущего сегмента одинаково на **каждой** границе (иначе у хода
      // из 3+ сегментов зазоры внутри различались: 8px против 16px).
      return (
        <Fragment key={`divider:${msg.id ?? msg.index}`}>
          <div data-step-divider className="mt-2 w-full border-t border-border/30" />
          {segment}
        </Fragment>
      )
    })
    if (!turnBlock) return segments
    return (
      // Внешний прозрачный отступ блока хода (12px сверху и снизу) — вертикальный
      // ритм ленты: между разными сообщениями 24px. Именно **padding**, а не
      // margin/gap: при виртуализации измеряется высота элемента, и отступ
      // обязан входить в неё, иначе скролл прыгает.
      <div key={group.key} className="py-3">
        <div
          data-testid="turn-block"
          className={expandedGroups.has(group.key) ? TURN_BLOCK_CLASS_EXPANDED : TURN_BLOCK_CLASS}
        >
          {segments}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden">
      <ScrollableOverlay
        ref={scrollRef as unknown as React.Ref<HTMLElement>}
        outerClassName="h-full"
        className="overflow-y-auto overflow-x-hidden chat-scroll-container"
        onScroll={handleScroll}
      >
        <div
          ref={chatZoneRef}
          className="chat-column mx-auto w-full"
          data-view-mode={chatViewMode}
          data-density={chatDensity}
        >
          <div
            className="relative w-full"
            style={{
              height: shouldVirtualize ? `${virtualizer.getTotalSize()}px` : 'auto',
            }}
          >
            {shouldVirtualize ? (
              <div
                className="absolute top-0 left-0 w-full"
                style={{
                  transform: `translateY(${virtualItems[0]?.start ?? 0}px)`,
                }}
              >
                {virtualItems.map((vi) => {
                  const group = groups[vi.index]
                  if (!group) return null
                  return (
                    <div key={group.key} data-index={vi.index} ref={virtualizer.measureElement}>
                      {renderGroup(group)}
                    </div>
                  )
                })}
              </div>
            ) : (
              groups.map((group) => <div key={group.key}>{renderGroup(group)}</div>)
            )}
          </div>
        </div>
      </ScrollableOverlay>

      <ScrollToBottomButton visible={showScrollBtn} onClick={() => scrollToBottom()} left={btnLeft ?? undefined} />
    </div>
  )
}
