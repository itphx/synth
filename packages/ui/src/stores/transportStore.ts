import { create } from 'zustand'
import { TransportClient, type WSEvent, type TransportKind } from '@/lib/api/transport'
import { useChatStore } from './chatStore'
import { useSessionsStore } from './sessionsStore'
import { useProjectsStore } from './projectsStore'
import { useGitStore } from './gitStore'
import { useFilesStore } from './filesStore'
import { useUIStore } from './useUIStore'
import { usePermissionStore, PERMISSION_ASK_TIMEOUT_MS, parsePermissionPreview } from './permissionStore'
import { useQuestionStore } from './questionStore'
import { useSkillsStore } from './skillsStore'
import { useInstructionsStore } from './instructionsStore'
import { usePipelinesStore } from './pipelinesStore'
import { useProcessesStore } from './processesStore'
import { useWorktreesStore } from './worktreesStore'
import type { TransportMode } from './useUIStore'
import type { MessageData, CostBreakdown, ResponseStatus, ReasoningBlockData, IntermediateTextBlockData, MessageStatus, ActiveTurn, QueueItemStatus } from './chatStore'
import { normalizeLiveToolPart, partText, toLivePart, turnHasContent } from '@/lib/messageParts'
import type { Part, PromptAcceptedResponse } from '@itphx/synth-shared/types'
import { MESSAGE_MODEL_VERSION, supportsMessageModel } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { MESSAGES_PAGE_LIMIT } from '@/lib/api/messages'
import type { SessionData } from '@/lib/api/synthApi'
import type { MessageListResponse } from '@/lib/api/messages'
import { sessionsApi } from '@/lib/api/sessions'
import { notifyMessage } from '@/hooks/useNotification'
import { i18nText } from '@/lib/i18n/text'
import type { QuestionItem, QuestionRecord, SteerMode } from '@itphx/synth-shared/types'

type EventDispatcher = (event: WSEvent) => void

/**
 * ADR-118 §1: идентификаторы частей детерминированные — текст
 * `msg:text:<ordinal>`, вызов инструмента — `callId`. По ним части и
 * дельти адресуются однозначно (upsert, а не append).
 */
const TEXT_PART_PREFIX = 'msg:text:'

// Полный refresh сессии с сервера после событий плана/ToDo (plan.approved,
// plan.updated, todos.updated). Гарантирует актуальность todos/mode/plan_approved
// в сторе независимо от содержимого payload события.
function refreshSessionFromApi(sid: string) {
  synthApi.getSession(sid)
    .then((sess) => {
      useSessionsStore.getState().upsertSession(sess)
      // ADR-119: серверная оценка занятости контекста из detail-DTO —
      // источник истины для индикатора (после сжатия она уменьшается).
      const usage = sess.context_usage
      if (usage) useChatStore.getState().setContextUsage(sid, usage)
    })
    .catch(() => {})
}

/**
 * Идентификатор отправки: уходит и в WS-кадр `send_message`, и в HTTP-тело
 * `POST /prompt` (`messageId`), поэтому серверный `message_id` (и `stream_id`
 * события `message.queued`) совпадает с id оптимистичной строки очереди.
 */
let sendSeq = 0
function nextStreamId(): string {
  sendSeq += 1
  return `stream-${sendSeq}-${Date.now()}`
}

/** Сессия сейчас в ходе (есть активный ход) — обычная отправка встанет в очередь. */
function isTurnActive(sid: string): boolean {
  const turn = useChatStore.getState().turnBySession[sid]
  return !!turn && turn.status === 'streaming'
}

/**
 * ADR-118 §7: мутации сообщений адресуются по `id`. Серверные события
 * (`context.sliding_window_applied`, `message.quality_check`) несут позиционный
 * индекс — им он служит **только** способом найти сообщение в сторе.
 */
function messageIdByIndex(sid: string, index: number): string | undefined {
  const messages = useChatStore.getState().messagesBySession[sid] ?? []
  return messages.find((m) => m.index === index)?.id
}

/**
 * ADR-118 §5: терминальный статус сообщения — «финал» шага. Сообщение с таким
 * статусом не воскрешаем: поздняя дельта/обновление к нему — мусор.
 */
function isTerminalMessageStatus(status: MessageStatus | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error'
}

/** Точка догона сбрасывается (смена пользователя/инстанса в рамках SPA). */
export function resetEventSeqTracking(): void {
  lastEventSeqBySession.clear()
}

/**
 * ADR-118 §4/§5: подтянуть историю сессии и **свести** её с живым состоянием.
 *
 * Загрузка истории — **single-flight** на сессию: `step.finished` приходит на
 * каждый шаг хода, а полная загрузка — тяжёлый запрос (в tool-loop из 10
 * шагов получалось 10 загрузок). Пока идёт одна, следующие запросы не
 * запускаются — вместо них помечается «нужен ещё один после завершения»
 * (trailing run). Данные применяются полностью: обещание вызывающего
 * резолвится после последнего прогона.
 *
 * Ключ сведения — `id` сообщения:
 * - сообщения в сторе нет — берём запись сервера как есть;
 * - сообщение уже в сторе (живое) — **сервер — источник истины** по
 *   содержимому (части/контент/статус/метаданные): без этого финальное
 *   сообщение осталось бы с пустыми частями (live-части снимаются на финале
 *   шага). Клиентские поля, которых у сервера нет (маркер доставки и т.п.),
 *   сохраняются.
 *
 * Серверные `null`/`undefined` **не затирают** живые значения сообщения
 * (`status`/`turn_id`/`step_index`/`parts`/`content`): иначе мерж истории
 * снимал индикатор текущего хода и выпадал сегмент из блока хода. Для
 * сообщения со статусом `streaming`, у которого сервер **ещё не зафиксировал
 * финал** (нет терминального `status`), части и контент вообще не
 * перезаписываются — источник там живой (live).
 *
 * Ошибка сети молча игнорируется: история — уточнение, а не источник правды о
 * ходе (живой ход восстанавливается из событий). Результат — `true`, если
 * история сведена с живым состоянием.
 */
export function mergeHistory(sid: string): Promise<boolean> {
  const state = historyMergeState(sid)
  if (state.running) {
    // Загрузка уже идёт — второй запрос не запускаем: помечаем «нужен ещё
    // один после завершения» (trailing run).
    state.pending = true
    return new Promise<boolean>((resolve) => { state.waiters.push(resolve) })
  }
  state.running = true
  state.pending = false
  return new Promise<boolean>((resolve) => {
    state.waiters.push(resolve)
    void runHistoryMergeLoop(sid, state)
  })
}

/** Состояние single-flight загрузки истории по сессиям. */
interface HistoryMergeState {
  /** Идёт ли сейчас загрузка истории. */
  running: boolean
  /** Нужен ещё один прогон после текущего. */
  pending: boolean
  /** Ожидающие промисы вызывающих. */
  waiters: Array<(ok: boolean) => void>
}

const historyMergeStates = new Map<string, HistoryMergeState>()

function historyMergeState(sid: string): HistoryMergeState {
  let state = historyMergeStates.get(sid)
  if (!state) {
    state = { running: false, pending: false, waiters: [] }
    historyMergeStates.set(sid, state)
  }
  return state
}

/** Один прогон: загрузка истории + сведение её с живым состоянием. */
async function fetchHistory(sid: string): Promise<boolean> {
  try {
    const r = await synthApi.getSessionMessages(sid, { limit: MESSAGES_PAGE_LIMIT })
    applyHistoryPage(sid, r)
    return true
  } catch {
    return false
  }
}

/**
 * Цикл прогонов загрузки: пока во время загрузки пришли новые запросы —
 * нужен ещё один прогон (иначе последние изменения остались бы незамеченными).
 */
async function runHistoryMergeLoop(sid: string, state: HistoryMergeState): Promise<void> {
  let ok = false
  for (;;) {
    ok = await fetchHistory(sid)
    if (!state.pending) break
    state.pending = false
  }
  state.running = false
  const waiters = state.waiters.splice(0)
  for (const resolve of waiters) resolve(ok)
}

/** Свести загруженную историю с живым состоянием стора. */
/**
 * Применить снимок страницы истории: свести его с живым состоянием сессии.
 *
 * Курсор пагинации («Загрузить старые») здесь **не** трогается: снимок
 * последней страницы не знает про старые страницы, догруженные пользователем,
 * а его `next_before` указывал бы на уже загруженный диапазон. Курсор живёт в
 * `historyPageBySession` и обновляется только явной догрузкой старых страниц.
 */
export function applyHistoryPage(sid: string, response: MessageListResponse): void {
  mergeServerMessages(sid, response.messages, {
    hasMore: response.has_more,
    nextBefore: response.next_before,
  })
}

/**
 * ADR-118 §1: результат инструмента из **истории** — скрытое `tool`-сообщение
 * (`metadata.tool_chain: true`, в ленте не рисуется) с `tool_call_id`.
 */
interface HistoricalToolResult {
  content: string
  isError?: boolean
  completedAt?: string
}

/**
 * Собрать результаты завершённых инструментов по id вызова.
 *
 * Результаты живут отдельными сообщениями `role: 'tool'` (у родителя и
 * саб-агента — одинаково); `MessageList` их скрывает (`tool_chain`). Карточка
 * же строится из `tool_calls` assistant-сообщения, где `result` нет (ADR-118:
 * `tool_results` в сообщение шага не пишутся). Без сведения после перезагрузки
 * карточка не знает результата и «мигает»/висит без него.
 */
function collectHistoricalToolResults(messages: MessageData[]): Map<string, HistoricalToolResult> {
  const results = new Map<string, HistoricalToolResult>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const metadata = (m.metadata ?? {}) as Record<string, unknown>
    const id = asNonEmptyString(m.tool_call_id)
      || asNonEmptyString(metadata.call_id)
      || asNonEmptyString(metadata.tool_call_id)
    if (!id || results.has(id)) continue
    const isError = metadata.isError === true || metadata.is_error === true
    results.set(id, {
      content: typeof m.content === 'string' ? m.content : '',
      ...(isError ? { isError: true } : {}),
      ...(m.created_at ? { completedAt: m.created_at } : {}),
    })
  }
  return results
}

/**
 * ADR-118 §1: историческое сведение результатов инструментов в `tool_calls`
 * assistant-сообщений (для ленты из снимка истории).
 *
 * Меняются только `tool_calls` (и только там, где результата ещё нет);
 * `parts`/live-части не трогаются — живая часть приоритетнее и в рендере
 * перекрывает dto-снимок. Неизвестный `call_id` оставляет вызов как есть.
 */
function hydrateHistoricalToolResults(messages: MessageData[]): MessageData[] {
  const results = collectHistoricalToolResults(messages)
  if (results.size === 0) return messages
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return message
    let changed = false
    const toolCalls = message.tool_calls.map((call) => {
      if (!call?.id || call.result) return call
      const result = results.get(call.id)
      if (!result) return call
      changed = true
      return {
        ...call,
        result: {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        },
        ...(call.completed_at ? {} : (result.completedAt ? { completed_at: result.completedAt } : {})),
      }
    })
    return changed ? { ...message, tool_calls: toolCalls } : message
  })
}

/**
 * Свести **снимок истории** с живым состоянием сессии (ADR-118 §5).
 *
 * Используется загрузкой сессии (`ChatTab`): снимок сервера — уточнение, а не
 * источник правды о ходе. Прямой `setMessages` затирал живое состояние более
 * старым снимком (переключение сессий во время хода: контент «мелькал» и
 * пропадал до следующего чанка). Здесь:
 *
 * - сообщения с известными id сливаются (`mergeKnownMessage`) — серверные
 *   `null`/`undefined` и **более бедный** снимок не затирают живой текст/части;
 * - новые сообщения добавляются;
 * - границы идущего хода восстанавливаются (идемпотентно).
 */

/**
 * Метаданные страницы истории, если снимок — **страница**, а не вся история.
 *
 * `hasMore === true` — снимок покрывает только последнюю страницу: сообщения
 * старше её нельзя считать удалёнными на сервере (иначе догрузка старых
 * страниц «съедала» бы их при любом мерже). `hasMore === false` — снимок
 * авторитетен по всему составу.
 */
export interface HistoryPageInfo {
  /** Есть ли сообщения старше загруженной страницы. */
  hasMore?: boolean
  /** Курсор следующей (более старой) страницы — минимальный `seq` страницы. */
  nextBefore?: number | null
}

/**
 * Минимальный `seq` снимка — граница загруженной страницы.
 *
 * Сообщения с `seq` меньше границы лежат **за пределами** страницы: снимок
 * про них ничего не знает, поэтому удалёнными их считать нельзя.
 */
function snapshotMinSeq(messages: MessageData[]): number | null {
  let min: number | null = null
  for (const m of messages) {
    if (typeof m.seq !== 'number' || !Number.isFinite(m.seq)) continue
    if (min === null || m.seq < min) min = m.seq
  }
  return min
}

export function mergeServerMessages(
  sid: string,
  messages: MessageData[],
  page?: HistoryPageInfo,
): void {
  const chat = useChatStore.getState()
  const current = chat.messagesBySession[sid] || []
  const byId = new Map<string, MessageData>()
  // Локальные сообщения без серверного id (ещё не подтверждены) не мержатся:
  // у них нет ключа, но терять их нельзя — сохраняем как есть.
  const turnActive = chat.turnBySession[sid]?.status === 'streaming'
  const localOnly = current.filter((m) => !m.id)
  const localIndexes = new Set(localOnly.map((m) => m.index))
  // Сообщения сервера без id (локальные ответы системных команд) тоже
  // сохраняем: мержить их не по чему, но терять нельзя.
  const serverLocal = messages.filter((m) => !m.id && !localIndexes.has(m.index))
  // ADR-118 §4/§7: снимок истории — источник истины по **составу** ленты.
  // Удалённое на сервере сообщение (есть `id`/`ord`, не live, не вклинивание)
  // из снимка пропадает и здесь, иначе лента другого клиента «залипала».
  const serverIds = new Set(messages.map((m) => m.id).filter((id): id is string => !!id))
  const activeTurnId = turnActive ? chat.turnBySession[sid]?.turnId : undefined
  // Пагинация истории: снимок — только последняя страница → сообщения старше
  // её границы в снимке не значатся, удалять их нельзя.
  const preserveOlder = page?.hasMore === true
  const minSeq = preserveOlder ? snapshotMinSeq(messages) : null
  for (const m of current) {
    if (!m.id) continue
    // ADR-118 §5: сообщение **активного хода** не удаляем по снимку. Шаг уже
    // закрыт (`status: 'completed'`, `ord` есть), а серверная запись может
    // отставать (троттлинг/гонка) — выпавшее из ленты сообщение шага уносило
    // карточки инструментов и прогресс саб-агентов, хотя ход жив.
    const belongsToActiveTurn = !!activeTurnId && m.turn_id === activeTurnId
    const outsideLoadedPage =
      minSeq !== null &&
      typeof m.seq === 'number' &&
      Number.isFinite(m.seq) &&
      m.seq < minSeq
    if (
      !belongsToActiveTurn
      && !serverIds.has(m.id)
      && !outsideLoadedPage
      && m.ord != null
      && m.status !== 'streaming'
      && !m.steerPending
    ) {
      continue
    }
    byId.set(m.id, m)
  }
  for (const m of messages) {
    if (!m.id) continue
    const known = byId.get(m.id)
    if (!known) {
      byId.set(m.id, m)
      continue
    }
    byId.set(m.id, mergeKnownMessage(known, m, turnActive))
  }
  const merged = [...byId.values(), ...localOnly, ...serverLocal]
  // ADR-118 §1: снимок истории не несёт `result` в `tool_calls` (он в скрытых
  // `tool`-сообщениях) — сводим их здесь, иначе карточка инструмента после
  // reload/открытия вкладки остаётся без результата.
  const hydrated = hydrateHistoricalToolResults(merged)
  chat.setMessages(sid, hydrated)
  // ADR-118 §5: в истории мог появиться живой ход (другой клиент) —
  // восстанавливаем границы, иначе он отрисуется как мёртвое сообщение.
  restoreLiveTurnFromHistory(sid, hydrated)
}

/**
 * Ресинк после восстановления транспорта (PWA вернулась из фона / реконнект).
 *
 * Пока связи не было, другие клиенты могли удалить сессии и сообщения —
 * события об этом потеряны. После переподключения:
 * 1. перечитываем список сессий;
 * 2. закрываем center-tab'ы `chat-*`, чьих сессий больше нет (и чистим ленту);
 * 3. активному чату перечитываем историю — состав ленты приходит из снимка
 *    (`mergeServerMessages` убирает удалённые сообщения).
 *
 * Ошибки глушим: ресинк — уточнение, а не источник правды о ходе.
 */
async function resyncAfterReconnect(): Promise<void> {
  if (useTransportStore.getState().versionMismatch) return
  await useSessionsStore.getState().loadSessions()
  if (useTransportStore.getState().versionMismatch) return

  const known = new Set(useSessionsStore.getState().sessions.map((s) => s.id))
  for (const tab of [...useUIStore.getState().centerTabs]) {
    if (!tab.id.startsWith('chat-')) continue
    const sessionId = tab.id.slice('chat-'.length)
    if (!sessionId || known.has(sessionId)) continue
    useUIStore.getState().closeTab(tab.id)
    useChatStore.getState().clearSession(sessionId)
  }

  const activeTabId = useUIStore.getState().activeCenterTabId
  if (!activeTabId || !activeTabId.startsWith('chat-')) return
  const activeSessionId = activeTabId.slice('chat-'.length)
  if (!activeSessionId || !known.has(activeSessionId)) return
  try {
    const r = await synthApi.getSessionMessages(activeSessionId, { limit: MESSAGES_PAGE_LIMIT })
    applyHistoryPage(activeSessionId, r)
  } catch {
    // история недоступна — оставляем живое состояние ленты
  }
  // После реконнекта серверные признаки хода — источник истины: если маркеры
  // остались от убитого процесса, `restoreLiveTurnFromSession` закроет
  // зависший ход (иначе UI вечно показывал бы активность).
  try {
    const session = await synthApi.getSession(activeSessionId)
    restoreLiveTurnFromSession(activeSessionId, session)
  } catch {
    // данные сессии недоступны — живое состояние не трогаем
  }
}

/**
 * Слияние сообщения истории с уже известным (живым) сообщением стора.
 *
 * - `null`/`undefined` из сервера не затирают заданные клиентские значения;
 * - у живого сообщения (`status: 'streaming'`) части и контент — источник
 *   live, серверные значения их не перезаписывают — **пока сервер не
 *   зафиксировал финал сообщения**: у записи с терминальным `status`
 *   части/контент — источник истины (иначе финальный шаг остался бы без
 *   текста: live-части снимаются на финале шага);
 * - реплика пользователя: текст остаётся пользовательским — в серверной
 *   записи он с плейсхолдерами вложений (ADR-115), а в ленте вложение
 *   рисуется отдельной галереей;
 * - метаданные — по ключам: сервер wins, клиентские добавки остаются.
 */
function mergeKnownMessage(
  known: MessageData,
  m: MessageData,
  turnActive = false,
): MessageData {
  const merged: MessageData = { ...known, ...m }
  if (m.ord == null && known.ord != null) merged.ord = known.ord
  if (m.status == null && known.status != null) merged.status = known.status
  if (m.turn_id == null && known.turn_id != null) merged.turn_id = known.turn_id
  if (m.step_index == null && known.step_index != null) merged.step_index = known.step_index
  // ADR-118 §1: вызовы инструментов живого шага не затираются отстающим
  // снимком (у черновика шага `tool_calls` ещё нет) — иначе после переключения
  // вкладок карточки инструментов пропадали бы вместе с результатами.
  if (m.tool_calls == null && known.tool_calls != null) merged.tool_calls = known.tool_calls
  if (m.parts == null && known.parts != null) merged.parts = known.parts
  if (m.content == null && known.content != null) merged.content = known.content
  // Живое сообщение: части/контент — источник live (ADR-118 §5). Но если
  // сервер уже зафиксировал финал шага (терминальный `status`), его запись —
  // источник истины: live-части снимаются на финале шага, и без них текст
  // шага пропал бы.
  const serverFinal = isTerminalMessageStatus(m.status)
  if (known.status === 'streaming' && !serverFinal) {
    merged.parts = known.parts
    merged.content = known.content
  }
  // Снимок сервера отстаёт от живого состояния (персистентность с
  // троттлингом). Пока идёт ход, более богатый известный текст/части не
  // затираются — иначе при переключении сессий во время хода контент
  // «мелькал» и пропадал до следующего чанка.
  if (turnActive && known.role === 'assistant') {
    if ((known.content?.length ?? 0) > (merged.content?.length ?? 0)) merged.content = known.content
    if ((merged.parts?.length ?? 0) === 0 && (known.parts?.length ?? 0) > 0) merged.parts = known.parts
  }
  return {
    ...merged,
    ...(known.role === 'user' ? { content: known.content } : {}),
    ...(known.metadata || m.metadata
      ? { metadata: { ...(known.metadata ?? {}), ...(m.metadata ?? {}) } }
      : {}),
  }
}

/**
 * ADR-118 §5/§6: восстановление **живого хода** из истории после перезагрузки.
 *
 * История (`GET /sessions/:id/messages`) несёт `ord`/`turn_id`/`step_index`/
 * `status`; сообщение с `status: 'streaming'` — это идущий ход. Пока его
 * `turnBySession` не восстановлен, лента рисует его как обычное (мёртвое)
 * сообщение и не показывает индикатор работы, а «Стоп»/«В фон» не видят хода.
 * Восстанавливаем границы хода по последнему такому сообщению.
 *
 * Идемпотентно: уже восстановленный (или идущий) ход не перетирается —
 * перезагрузка истории со «старым» снимком не должна откатывать границы
 * хода, который идёт прямо сейчас (в сторе он свежее истории).
 */
export function restoreLiveTurnFromHistory(sessionId: string, messages: MessageData[]): void {
  const streaming = messages.filter((m) => m.status === 'streaming')
  const last = streaming[streaming.length - 1]
  if (!last) return
  const turnId = last.turn_id || last.id || ''
  if (!turnId) return
  const current = useChatStore.getState().turnBySession[sessionId]
  if (current && current.status === 'streaming') return
  useChatStore.getState().startTurn(sessionId, {
    turnId,
    ...(last.id ? { messageId: last.id } : {}),
    ...(last.step_index != null ? { stepIndex: last.step_index } : {}),
    status: 'streaming',
    ...(last.agent_role ? { agentRole: last.agent_role } : {}),
    ...(last.model ? { model: last.model } : {}),
    ...(last.provider ? { provider: last.provider } : {}),
    // Контент хода уже был? (иначе индикатор «идёт» — у реплики пользователя).
    contentStarted: turnHasContent(messages, { turnId }, last),
  })
}

/**
 * Контент хода начался (ADR-118 §5): пришла первая часть ответа.
 *
 * Индикатор «идёт» до этого живёт у реплики пользователя (плашка
 * «обработка»/«повтор»), после — в живом сегменте ответа. Флаг ставится
 * один раз на ход и не сбрасывается между шагами.
 */
function markTurnContentStarted(sessionId: string): void {
  const turn = useChatStore.getState().turnBySession[sessionId]
  if (!turn || turn.contentStarted) return
  useChatStore.getState().patchTurn(sessionId, { contentStarted: true })
}

/** Непустая строка из произвольного значения (DTO API без типизации). */
function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : ''
}

/**
 * ADR-118 §4: `queue.state.items` — статусы элементов очереди без текста/автора.
 * Валидируем defensive: только объекты с непустым `id`, статус — из набора
 * (`queued`|`starting`), остальные элементы отбрасываются.
 */
function extractQueueItems(raw: unknown): Array<{ id: string; status?: QueueItemStatus }> {
  if (!Array.isArray(raw)) return []
  const items: Array<{ id: string; status?: QueueItemStatus }> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = asNonEmptyString(item.id)
    if (!id) continue
    const status = item.status === 'starting' ? 'starting' : item.status === 'queued' ? 'queued' : undefined
    items.push(status ? { id, status } : { id })
  }
  return items
}

/**
 * Последний известный `turn_id` хода сессии — по сообщениям в сторе (с конца).
 *
 * Нужен при восстановлении хода после перезагрузки: `current_stream` старого
 * ядра не несёт `turn_id`, и `stream_id` (`stream-…`) — **не** id хода: с ним
 * live-сообщения получали `turn_id = stream-…`, а история — `turn_…`. Ход из
 * двух разных id не склеивался (блок рвался на два), а закрытие сегментов
 * по `onlyTurnId` не срабатывало — индикатор «идёт» застревал в середине
 * блока. Сообщения-уведомления о фоне `turn_id` не несут — их пропускаем.
 */
function lastKnownTurnId(messages: MessageData[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const turnId = asNonEmptyString(messages[i]?.turn_id)
    if (turnId) return turnId
  }
  return ''
}

/**
 * ADR-118 §5: применить **серверный снимок живого шага**
 * (`current_stream.live`) из `GET /sessions/:id`.
 *
 * Зачем: содержимое стримящегося шага у клиента складывается из дельт, а
 * персистентная запись отстаёт (троттлинг). Открытие сессии посреди хода
 * (вкладка, перезагрузка страницы, второй клиент) показывало только
 * зафиксированную часть, остальное дорисовывалось по чанкам. Снимок даёт всё
 * до момента запроса: текст, рассуждения и части шага.
 *
 * Идемпотентно: снимок — тот же шаг (`messageId`), части мержатся по `partId`;
 * сообщение не пересоздаётся. Финальное сообщение (терминальный статус) не
 * «воскрешается» — история по нему уже источник истины.
 */
function applyLiveStreamSnapshot(
  sessionId: string,
  stream: Record<string, unknown> | null,
): void {
  const live = (stream?.live ?? null) as Record<string, unknown> | null
  if (!live || typeof live !== 'object') return
  const messageId = asNonEmptyString(live.message_id)
  if (!messageId) return
  const content = typeof live.content === 'string' ? live.content : ''
  const reasoning = typeof live.reasoning === 'string' ? live.reasoning : ''
  const parts = Array.isArray(live.parts) ? (live.parts as Part[]) : []
  if (!content && !reasoning && parts.length === 0) return
  const stepIndex = typeof live.step_index === 'number' ? live.step_index : undefined
  const turnId = asNonEmptyString(live.turn_id) || undefined
  const chat = useChatStore.getState()
  const existing = (chat.messagesBySession[sessionId] || []).find((m) => m.id === messageId)
  // Шаг уже закрыт (терминальный статус) — снимок устарел, историю не трогаем.
  if (existing?.status && existing.status !== 'streaming') return

  if (!existing) {
    chat.upsertMessage(sessionId, {
      index: 0,
      id: messageId,
      role: 'assistant',
      content,
      status: 'streaming',
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: new Date().toISOString(),
      ...(turnId ? { turn_id: turnId } : {}),
      ...(stepIndex != null ? { step_index: stepIndex } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(parts.length > 0 ? { parts } : {}),
    })
  } else {
    const patch: Partial<MessageData> = {}
    if ((existing.content?.length ?? 0) < content.length) patch.content = content
    if ((existing.parts?.length ?? 0) === 0 && parts.length > 0) patch.parts = parts
    if (existing.status !== 'streaming') patch.status = 'streaming'
    if (!existing.turn_id && turnId) patch.turn_id = turnId
    if (existing.step_index == null && stepIndex != null) patch.step_index = stepIndex
    if (Object.keys(patch).length > 0) chat.updateMessageById(sessionId, messageId, patch)
  }

  // Live-части: `buildPartsView` собирает по ним текст/reasoning/вызовы, а
  // совпадающие `partId` мержатся с уже накопленными дельтами.
  for (const part of parts) {
    if (!part?.id) continue
    chat.upsertPart(sessionId, messageId, part.id, toLivePart(part))
  }
}

/** Позиция сообщения в ленте: `ord` (ADR-118 §2), при `null` — серверный `index`. */
function messageOrder(message: MessageData): number {
  return message.ord ?? message.index ?? 0
}

/**
 * ADR-118 §5: сообщение **шага** хода для адресации live-событий.
 *
 * Сначала — живой сегмент (`status: 'streaming'`), иначе — последнее
 * assistant-сообщение этого хода. Второй случай обязателен: ядро публикует
 * `step.finished` **до** запуска инструментов, поэтому во время длинного тула
 * сообщения со статусом `streaming` в истории уже нет, а `tool_call.*`/
 * `subagent.progress` всё ещё адресуются к сообщению шага. Без фоллбэка после
 * перезагрузки страницы карточки инструментов и прогресс саб-агентов
 * отбрасывались (`messageId` пуст).
 */
function stepMessageForTurn(messages: MessageData[], turnId: string): MessageData | undefined {
  if (!turnId) return undefined
  const ofTurn = messages.filter((m) => m.turn_id === turnId && !!m.id)
  if (ofTurn.length === 0) return undefined
  const streaming = ofTurn.filter((m) => m.status === 'streaming')
  const candidates = streaming.length > 0 ? streaming : ofTurn.filter((m) => m.role === 'assistant')
  let best: MessageData | undefined
  for (const m of candidates) {
    if (!best || messageOrder(m) >= messageOrder(best)) best = m
  }
  return best
}

/** Вызов инструмента, восстановленный из истории сообщения шага. */
interface RestoredToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  iteration: number
  startedAt?: string
}

/**
 * ADR-118 §1/§4: вызовы инструментов сообщения шага.
 *
 * Источник — `parts` (`type: 'tool_use'`, у части могут быть аргументы в
 * провайдерской форме `data.function` — нормализуем `normalizeLiveToolPart`),
 * иначе `tool_calls` (сырая форма провайдера, `arguments` — JSON-строка).
 */
function restoreToolCalls(message: MessageData): RestoredToolCall[] {
  const calls = new Map<string, RestoredToolCall>()
  for (const part of message.parts ?? []) {
    if (!part || part.type !== 'tool_use' || !part.id) continue
    const normalized = normalizeLiveToolPart({ id: part.id, type: 'tool_use', text: '', data: part.data })
    const data = (normalized.data ?? {}) as Record<string, unknown>
    const name = typeof data.name === 'string' ? data.name : ''
    calls.set(part.id, {
      id: part.id,
      name: name || 'tool',
      args: (data.args as Record<string, unknown>) ?? {},
      iteration: typeof data.iteration === 'number' ? data.iteration : 0,
      ...(typeof data.startedAt === 'string' && data.startedAt ? { startedAt: data.startedAt } : {}),
    })
  }
  for (const call of message.tool_calls ?? []) {
    if (!call?.id || calls.has(call.id)) continue
    const fn = call.function
    const name = (typeof call.name === 'string' && call.name) || (typeof fn?.name === 'string' ? fn.name : '')
    if (!name) continue
    let args: Record<string, unknown> = (call.args as Record<string, unknown>) ?? {}
    if (typeof fn?.arguments === 'string' && fn.arguments.trim()) {
      try {
        const parsed: unknown = JSON.parse(fn.arguments)
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        // аргументы не JSON — оставляем как есть
      }
    } else if (fn?.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>
    }
    calls.set(call.id, {
      id: call.id,
      name,
      args,
      iteration: typeof call.iteration === 'number' ? call.iteration : 0,
      ...(typeof call.started_at === 'string' && call.started_at ? { startedAt: call.started_at } : {}),
    })
  }
  return [...calls.values()]
}

/** id завершённых вызовов: `tool`-сообщения истории (`tool_call_id`/метаданные). */
function completedToolCallIds(messages: MessageData[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const metadata = (m.metadata ?? {}) as Record<string, unknown>
    const id = asNonEmptyString(m.tool_call_id)
      || asNonEmptyString(metadata.call_id)
      || asNonEmptyString(metadata.tool_call_id)
    if (id) ids.add(id)
  }
  return ids
}

/**
 * ADR-118 §5: «посев» live-частей **выполняющихся** вызовов шага после
 * перезагрузки страницы.
 *
 * Событие `tool_call.started` пришло до reload и не переигрывается (полный
 * reload не передаёт `since`), поэтому части вызова в сторе нет, а
 * `patchPartData` без неё молча no-op — результат (`tool_call.result`) и
 * прогресс (`subagent.progress`) терялись. Создаём ровно недостающие части
 * (`status: 'running'`); существующие не перетираем, завершённые вызовы не
 * сеем.
 */
function seedInFlightToolParts(
  sessionId: string,
  messageId: string,
  message: MessageData,
  messages: MessageData[],
): number {
  const calls = restoreToolCalls(message)
  if (calls.length === 0) return 0
  const completed = completedToolCallIds(messages)
  const chat = useChatStore.getState()
  const existing = chat.partsBySession[sessionId]?.[messageId] ?? {}
  let seeded = 0
  for (const call of calls) {
    if (completed.has(call.id) || existing[call.id]) continue
    chat.upsertPart(sessionId, messageId, call.id, {
      id: call.id,
      type: 'tool_use',
      text: '',
      data: {
        name: call.name,
        args: call.args,
        status: 'running',
        startedAt: call.startedAt ?? new Date().toISOString(),
        iteration: call.iteration,
      },
    })
    seeded += 1
  }
  return seeded
}

/**
 * ADR-118 §5: восстановление **живого хода** по признакам активного хода из
 * `GET /sessions/:id` (`current_stream`, `status.blocked`).
 *
 * Истории (`GET /sessions/:id/messages`) для этого может не хватить: идёт
 * длинный инструмент, шаг с текстом уже `completed`, а следующего
 * assistant-сообщения ещё нет — сообщения со статусом `streaming` в истории
 * нет, значит `restoreLiveTurnFromHistory` выходит, ход не восстанавливается,
 * и в UI нет ни индикатора, ни «Стоп», ни `ctrl+b`.
 *
 * API отдаёт признак активного хода: `current_stream` (идёт стрим) и
 * `status.blocked` (ход ждёт подтверждения). По ним границы хода
 * восстанавливаются.
 *
 * **id хода** (порядок источников):
 * 1. `current_stream.turn_id` — точный id хода (ядро публикует его);
 * 2. `activity.turnId` — признак активного хода из `activity` (`busy`/`retry`):
 *    ядро отдаёт его и без `current_stream`;
 * 3. `turn_id` последнего сообщения сессии — восстановленный ход должен
 *    совпадать с id хода в истории, иначе блок хода рвётся на два;
 * 4. `current_stream.stream_id` — legacy (ядро без `turn_id`).
 *
 * `activity.type === 'retry'` даёт плашку «Повтор N/M» сразу после reload
 * (без неё она появлялась только со следующим `stream.retry`).
 *
 * Идемпотентно: уже восстановленный (или идущий) ход не перетирается.
 */
export function restoreLiveTurnFromSession(sessionId: string, session: unknown): void {
  if (!session || typeof session !== 'object') return
  const data = session as Record<string, unknown>
  const current = useChatStore.getState().turnBySession[sessionId]
  const stream = (data.current_stream ?? null) as Record<string, unknown> | null
  const status = (data.status ?? null) as Record<string, unknown> | null
  const activity = (data.activity ?? null) as Record<string, unknown> | null
  const activityType = asNonEmptyString(activity?.type)
  const activityTurnId = asNonEmptyString(activity?.turnId)
  const activityStreamId = asNonEmptyString(activity?.streamId)
  const blocked = status?.blocked
  const hasStream = stream != null
  // `busy`/`retry` — активный ход и без `current_stream` (ядро отдаёт activity).
  const hasActivity = activityType === 'busy' || activityType === 'retry'
  // ADR-118 §5: сначала применяем серверный снимок живого шага — тогда
  // `contentStarted` и границы хода считаются по нему, а не по отстающей
  // персистентной записи.
  applyLiveStreamSnapshot(sessionId, stream)
  const messages = useChatStore.getState().messagesBySession[sessionId] ?? []
  const streamId = asNonEmptyString(stream?.stream_id) || activityStreamId
  const agentRole = asNonEmptyString(stream?.agent_role)

  // Плашка автоповтора — из `activity.retry`: после перезагрузки событие
  // `stream.retry` уже не придёт, и без этого «Повтор N/M» не показывалась.
  if (activityType === 'retry') {
    const retryAtMs = Date.parse(asNonEmptyString(activity?.retryAt))
    const attempt = typeof activity?.attempt === 'number' ? activity.attempt : 1
    const maxRetries = typeof activity?.maxRetries === 'number' ? activity.maxRetries : 3
    const error = asNonEmptyString(activity?.error)
    useChatStore.getState().setStreamRetry(sessionId, {
      streamId: activityStreamId || streamId,
      attempt,
      maxRetries,
      retryInMs: Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - Date.now()) : 0,
      ...(error ? { error } : {}),
    })
  }

  if (current && current.status === 'streaming') {
    // Сервер не подтверждает активность хода (`current_stream`/`blocked`/
    // `activity`) и в истории нет стримящегося сообщения — маркеры остались от
    // убитого процесса (rolling update, рестарт): ход закрываем, иначе UI вечно
    // показывает «streaming». Стримящееся сообщение в истории — живой шаг хода
    // (сервер мог не успеть отдать `current_stream`), его не гасим.
    const hasStreamingMessage = messages.some((m) => m.status === 'streaming')
    if (!hasStream && !blocked && !hasActivity && !hasStreamingMessage) {
      useChatStore.getState().finishTurn(sessionId, current.turnId, 'stopped')
      return
    }
    // Ход уже восстановлен (по истории) — **дополняем** его: `stream_id` нужен
    // для сопоставления `stream.retry` (плашка автоповтора), агент/модель —
    // для шапки хода. Границы хода (`turnId`) не трогаем.
    patchTurnFromSession(sessionId, current, { streamId, agentRole, messages })
    return
  }
  if (!hasStream && !blocked && !hasActivity) return
  const turnId =
    asNonEmptyString(stream?.turn_id)
    || activityTurnId
    // Id хода из истории — только когда идёт стрим (или ход активен по
    // `activity`): при `status.blocked` границы хода восстанавливаются из
    // истории целиком (см. ниже).
    || (hasStream || hasActivity ? lastKnownTurnId(messages) : '')
    || asNonEmptyString(stream?.stream_id)
    || activityStreamId
  if (!turnId) {
    // Границы хода из истории (сообщение со статусом `streaming`).
    restoreLiveTurnFromHistory(sessionId, messages)
    return
  }
  // Сообщение шага хода (из истории) — его id/шаг нужны границам хода.
  // Если шаг уже закрыт (`step.finished`), берём последнее assistant-сообщение
  // хода: инструменты шага ещё выполняются и адресуются именно к нему.
  const step = stepMessageForTurn(messages, turnId)
  const inFlight = step?.id ? seedInFlightToolParts(sessionId, step.id, step, messages) : 0
  useChatStore.getState().startTurn(sessionId, {
    turnId,
    status: 'streaming',
    ...(streamId ? { streamId } : {}),
    ...(step?.id ? { messageId: step.id } : {}),
    ...(step?.step_index != null ? { stepIndex: step.step_index } : {}),
    ...(agentRole ? { agentRole } : {}),
    // Инструменты шага выполняются — держим точки «работы» в шапке
    // последнего сегмента хода (ADR-118 §3).
    ...(inFlight > 0 ? { toolsRunning: true } : {}),
    contentStarted: turnHasContent(messages, { turnId }, step),
  })
}

/**
 * Дополнить уже восстановленный ход данными сессии (ADR-118 §5).
 *
 * Ход, восстановленный по истории, не знает `stream_id` (по нему
 * сопоставляется статус автоповтора `stream.retry`), агента и модель: без
 * них после перезагрузки не появлялись ни плашка «повтор», ни шапка хода.
 *
 * Заполняются **только пустые** поля: непустое значение в сторе (свежее
 * истории) не перетирается значением из сессии, а `contentStarted` не
 * сбрасывается в `false` — уже начатый контент хода остаётся начатым.
 */
function patchTurnFromSession(
  sessionId: string,
  turn: ActiveTurn,
  source: { streamId?: string; agentRole?: string; messages: MessageData[] },
): void {
  const patch: Partial<ActiveTurn> = {}
  // Сообщение шага хода (из истории) — его id/шаг нужны границам хода.
  // Закрытый шаг (`step.finished`) — последнее assistant-сообщение хода; его
  // выполняющиеся вызовы нужно «посеять» в live-части и сейчас.
  const step = stepMessageForTurn(source.messages, turn.turnId)
  const inFlight = step?.id ? seedInFlightToolParts(sessionId, step.id, step, source.messages) : 0
  if (!turn.streamId && source.streamId) patch.streamId = source.streamId
  if (!turn.agentRole && source.agentRole) patch.agentRole = source.agentRole
  const model = turn.model || asNonEmptyString(step?.model)
  if (!turn.model && model) patch.model = model
  const provider = turn.provider || asNonEmptyString(step?.provider)
  if (!turn.provider && provider) patch.provider = provider
  if (!turn.messageId && step?.id) patch.messageId = step.id
  // `messageId` хода мог «повиснуть» на сообщении, которого уже нет в ленте
  // (снимок истории его не содержал) — перепривязываем к шагу хода, иначе
  // tool-события адресуются несуществующему сообщению.
  if (
    turn.messageId
    && step?.id
    && !source.messages.some((m) => m.id === turn.messageId)
  ) {
    patch.messageId = step.id
  }
  if (turn.stepIndex == null && step?.step_index != null) patch.stepIndex = step.step_index
  if (!turn.toolsRunning && inFlight > 0) patch.toolsRunning = true
  if (!turn.contentStarted && turnHasContent(source.messages, turn, step)) {
    patch.contentStarted = true
  }
  if (Object.keys(patch).length === 0) return
  useChatStore.getState().patchTurn(sessionId, patch)
}

/**
 * Накопление **дельт** прогресса саб-агента (`subagent.progress` несёт только
 * приращение с прошлой публикации, а не накопленный текст). Блок дописывается:
 * в текущей итерации — в конец последнего блока, в новой — новым блоком.
 */
function appendDeltaBlock<T extends { text: string; iteration: number }>(
  blocks: T[],
  delta: string,
  iteration: number,
): T[] {
  if (!delta) return blocks
  const last = blocks[blocks.length - 1]
  if (last && last.iteration === iteration) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + delta }]
  }
  return [...blocks, { text: delta, iteration } as T]
}

/**
 * Сверка очереди с сервером после неподтверждённой отправки (`confirmed:false`).
 * Сообщение не теряется: строка очереди остаётся, а состав/счётчик уточняются
 * по `GET /sessions/:id` (та же семантика, что у первичной загрузки: при живом
 * ходе первый pending-элемент — сообщение текущего хода, в списке его нет;
 * хода нет — показывается вся очередь, в т.ч. вклинивание, вернувшееся в неё
 * после «Стопа»).
 *
 * Возвращает промис: терминал хода ждёт его, чтобы снять из ленты вклинивания
 * уже **после** обновления состава очереди (см. `finishTurnAndRefreshQueue`).
 */
function reconcileQueueFromApi(sid: string): Promise<void> {
  return synthApi.getSession(sid)
    .then((session) => {
      const data = session as unknown as Record<string, unknown>
      const pending = data.pending_messages as Array<Record<string, unknown>> | undefined
      if (!pending) return
      const chat = useChatStore.getState()
      if (pending.length === 0) {
        chat.clearQueueState(sid)
        return
      }
      const active = data.current_stream != null || isTurnActive(sid)
      const display = active ? pending.slice(1) : pending
      // Статусы строк (`queue.state.items`) переживают сверку: `queue.state`
      // мог прийти раньше ответа API.
      const statusById = new Map<string, QueueItemStatus>()
      for (const row of chat.pendingBySession[sid] || []) {
        if (row.id && row.status) statusById.set(row.id, row.status)
      }
      chat.setPendingMessages(sid, display.map((pm) => {
        const id = typeof pm.id === 'string' ? pm.id : ''
        const status = id ? statusById.get(id) : undefined
        return {
          ...(id ? { id } : {}),
          content: typeof pm.content === 'string' ? pm.content : '',
          agentRole: (pm.agent_role as string | undefined) ?? null,
          ...(status ? { status } : {}),
        }
      }))
      if (display.length > 0) chat.updateQueueCount(sid, display.length)
      else chat.clearQueueState(sid)
    })
    .catch(() => {})
}

/**
 * ADR-118 §4: снимок сообщения (`message.enqueued`) → запись ленты.
 *
 * `ord` не выдан (сообщение ещё не материализовано в истории) — состояние
 * «вклинивается в ход» показывает поле `steerPending` (в разметку оно не
 * попадает: реплика рисуется обычным пузырём). Поля — те же, что у DTO
 * сообщения (id/role/author/content/parts/metadata/время).
 */
function steerPendingMessageFromSnapshot(
  messageId: string,
  snapshot: Record<string, unknown>,
  index: number,
): MessageData {
  const content = typeof snapshot.content === 'string' ? snapshot.content : ''
  const parts = Array.isArray(snapshot.parts) ? (snapshot.parts as Part[]) : undefined
  const role = typeof snapshot.role === 'string' ? snapshot.role : 'user'
  const author = typeof snapshot.author === 'string' ? snapshot.author : null
  const metadata = (
    snapshot.metadata && typeof snapshot.metadata === 'object'
      ? snapshot.metadata
      : null
  ) as Record<string, unknown> | null
  // DTO сообщения отдаёт время в `timestamp`, снимок события — в `created_at`.
  const createdAt = typeof snapshot.created_at === 'string'
    ? snapshot.created_at
    : typeof snapshot.timestamp === 'string'
      ? snapshot.timestamp
      : new Date().toISOString()
  return {
    index,
    id: messageId,
    role,
    content,
    ...(parts ? { parts } : {}),
    author,
    metadata,
    ord: null,
    turn_id: null,
    status: null,
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: createdAt,
    steerPending: true,
  }
}

/**
 * ADR-118 §4: id неразрешённых вклиниваний сессии (`delivery: 'steer'`,
 * ещё не материализованные в истории).
 */
function steerPendingIds(sessionId: string): string[] {
  const messages = useChatStore.getState().messagesBySession[sessionId] || []
  const ids: string[] = []
  for (const message of messages) {
    if (message.steerPending !== true) continue
    if (message.id) ids.push(message.id)
  }
  return ids
}

/**
 * ADR-118 §4: снять из ленты неразрешённые вклинивания сессии.
 *
 * Снимаются только записи с маркером `steerPending` — доставленное сообщение
 * (`message.delivered`) маркер уже сняло, его не трогаем. `ids` — сузить до
 * конкретных сообщений (терминал хода снимает только те, что висели на момент
 * терминала).
 *
 * Вклинивание снимается **только по явным сигналам**: доставка
 * (`message.delivered`), сброс (`steer.dropped`) или терминал хода. Сам факт
 * наличия id в `pending_messages` — не сигнал: ядро публикует
 * `message.enqueued` до того, как снимет сообщение из очереди, поэтому такая
 * эвристика снимала бы вклинивание сразу после его показа.
 */
function removeSteerPendingMessages(sessionId: string, ids?: string[]): void {
  const wanted = ids && ids.length > 0 ? new Set(ids) : null
  const chat = useChatStore.getState()
  for (const message of chat.messagesBySession[sessionId] || []) {
    if (message.steerPending !== true) continue
    if (!message.id) continue
    if (wanted && !wanted.has(message.id)) continue
    chat.removeMessageById(sessionId, message.id)
  }
}

/**
 * ADR-118 §4: терминал хода — снять неразрешённые вклинивания из ленты **и**
 * перечитать состав очереди.
 *
 * Порядок — **сначала сверка, потом снятие**: пока ответ API не пришёл,
 * вклинивание остаётся в ленте (пользователь его видит) — сообщение не
 * пропадает из UI совсем. Снятие — по завершении сверки: к этому моменту панель
 * очереди уже показывает состав, вернувшийся в очередь (после «Стопа» —
 * без автозапуска, возобновляет пользователь).
 */
function finishTurnAndRefreshQueue(sid: string): void {
  const ids = steerPendingIds(sid)
  const refreshed = reconcileQueueFromApi(sid)
  if (ids.length === 0) return
  void refreshed.then(() => removeSteerPendingMessages(sid, ids))
}

/**
 * id сообщений, снятых событием `steer.dropped` (если событие их несёт).
 *
 * Контракт события ids не содержит (`reason`/`dropped_count`/`stream_id`), но
 * ядро может их добавить — тогда снимаем точечно, а не все вклинивания сессии.
 */
function extractDroppedMessageIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value) ids.push(value)
  }
  push(payload.message_id)
  push(payload.messageId)
  for (const key of ['message_ids', 'messageIds']) {
    const raw = payload[key]
    if (!Array.isArray(raw)) continue
    for (const item of raw) push(item)
  }
  return ids
}

/**
 * Изменились ли серверные счётчики очереди сессии (с последнего `queue.state`).
 *
 * Счётчики сервера включают сообщение текущего хода, а счётчик в сторе
 * (`pendingCount`) считает только показанные строки панели — сравнивать их
 * между собой нельзя, поэтому серверные значения лежат отдельно
 * (`QueueState.serverCounts`).
 */
function queueCountsChanged(sid: string, pendingCount: number, steerCount: number): boolean {
  const prev = useChatStore.getState().queueBySession[sid]?.serverCounts
  if (!prev) return true
  return prev.pendingCount !== pendingCount || prev.steerCount !== steerCount
}

/**
 * ADR-118 §4: точечная догрузка сообщения по `message.delivered`.
 *
 * Событие несёт только `messageId`/`ord`/роль/автора — **без содержания**.
 * Если сообщения ещё нет в сторе, тянем **одно** сообщение
 * (`GET /sessions/:id/messages/:messageId`), а не всю историю: `message.delivered`
 * приходит на каждое материализованное сообщение, и полный `GET /messages` на
 * каждое событие — лишний трафик. Ошибка/404 → прежний фоллбек на полную
 * историю (`mergeHistory`; дедуп по `id`/`ord` там же).
 */
async function loadDeliveredMessage(
  sid: string,
  messageId: string,
  patch: Partial<MessageData>,
): Promise<void> {
  try {
    const resp = await synthApi.getSessionMessage(sid, messageId)
    const dto = extractMessageDto(resp)
    if (!dto) {
      // Ответ без сообщения (старое ядро/иная обёртка) — сверяемся с историей.
      void mergeHistory(sid)
      return
    }
    useChatStore.getState().upsertMessage(sid, { ...dto, ...patch })
  } catch {
    void mergeHistory(sid)
  }
}

/**
 * Сообщение из ответа точечной загрузки: `{message}` (контракт) либо само
 * сообщение (плоский ответ старого ядра).
 */
function extractMessageDto(resp: unknown): MessageData | undefined {
  if (typeof resp !== 'object' || resp === null) return undefined
  const nested = (resp as { message?: unknown }).message
  const raw = nested && typeof nested === 'object' ? nested : resp
  const dto = raw as Partial<MessageData>
  return typeof dto.id === 'string' && typeof dto.role === 'string'
    ? (dto as MessageData)
    : undefined
}

/**
 * ADR-118 §6: последний применённый номер события по сессиям — точка догона.
 * При реконнекте клиент передаёт максимум в `since`, и сервер отдаёт журнал
 * строго после него (без разрыва и без дублей).
 */
const lastEventSeqBySession = new Map<string, number>()

/**
 * ADR-118 §6: номер события инстансного канала (`pipeline.run.*`) живёт в
 * собственной нумерации — смешивать его с сессионной точкой догона нельзя.
 */
const INSTANCE_CHANNEL_ID = 'instance'

/** Максимальный номер события по всем сессиям (значение для `since`). */
function maxEventSeq(): number | undefined {
  let max: number | undefined
  for (const [sessionId, value] of lastEventSeqBySession) {
    if (sessionId === INSTANCE_CHANNEL_ID) continue
    if (max === undefined || value > max) max = value
  }
  return max
}

/**
 * Дельта прогресса саб-агента: актуальное ядро присылает только приращение
 * (`content_delta`/`reasoning_delta`). Старое ядро (гибрид с другой версией)
 * присылало накопленный текст — вычитаем известный префикс, чтобы блок не
 * задвоился.
 */
function progressDelta(
  payload: Record<string, unknown>,
  deltaKey: 'content_delta' | 'reasoning_delta',
  cumulativeKey: 'content' | 'reasoning',
  lastText: string,
): string {
  const delta = payload[deltaKey]
  if (typeof delta === 'string' && delta.length > 0) return delta
  if (deltaKey in payload) return ''
  const cumulative = payload[cumulativeKey]
  if (typeof cumulative !== 'string' || cumulative.length === 0) return ''
  return cumulative.startsWith(lastText) ? cumulative.slice(lastText.length) : cumulative
}

/** fs.changed: окно коалесинга refresh Git-вкладки на проект. */
const GIT_REFRESH_DEBOUNCE_MS = 400
const gitRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * fs.changed: перечитывает реестр репозиториев проекта (git-операции агента
 * могли изменить workspace). Debounce — не чаще ~400 мс на проект.
 */
function scheduleGitRefresh(projectId: string) {
  const existing = gitRefreshTimers.get(projectId)
  if (existing) clearTimeout(existing)
  gitRefreshTimers.set(projectId, setTimeout(() => {
    gitRefreshTimers.delete(projectId)
    const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
    if (project) void useGitStore.getState().loadRepos(projectId, project.repos ?? null)
  }, GIT_REFRESH_DEBOUNCE_MS))
}

/** ADR-070 §2.6: usage live-события (camelCase из ядра) → snake_case стора. */
function mapUsage(raw: unknown): {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
} | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, number>
  return {
    input_tokens: u.inputTokens || 0,
    output_tokens: u.outputTokens || 0,
    total_tokens: u.totalTokens || 0,
    cache_read_tokens: u.cacheReadTokens,
    cache_write_tokens: u.cacheWriteTokens,
    reasoning_tokens: u.reasoningTokens,
  }
}

/** ADR-070 §2.6: cost_breakdown live-события уже в camelCase — как в сторе. */
function mapCostBreakdown(raw: unknown): CostBreakdown | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  return raw as CostBreakdown
}

/**
 * Ответ на подтверждение уже принят (403 `APPROVAL_DENIED` с
 * `details.reason === 'already_consumed'`): полагать ошибкой нечего — запрос
 * закрыт, полосу надо убрать.
 */
function isAlreadyConsumed(err: unknown): boolean {
  const details = (err as { details?: { reason?: unknown } } | null)?.details
  return details?.reason === 'already_consumed'
}

/**
 * ADR-111/ADR-113: UI-уведомления о фоновой работе (старт/финиш).
 *
 * Дедупа нет: каждое пришедшее событие фоновой работы даёт уведомление —
 * корневая причина дублей устранена в ядре (единый `enqueueUserMessage`),
 * события шины не реплеятся, у реальных прогонов разные `background_run_id`.
 */
/** Стартовые события фоновой работы. */
const BACKGROUND_START_EVENTS = new Set(['process.started', 'child.started'])

/** Терминальные события фоновой работы. */
const BACKGROUND_FINISH_EVENTS = new Set([
  'process.exited',
  'process.stopped',
  'child.completed',
  'child.failed',
  'child.cancelled',
])

/** Максимальная длина имени прогона в уведомлении. */
const BACKGROUND_NOTIFY_NAME_LIMIT = 80

/** Терминальное состояние прогона по событию и payload. */
function backgroundFinishState(
  type: string,
  payload: Record<string, unknown>,
): 'completed' | 'failed' | 'cancelled' {
  const state = payload.state
  if (state === 'completed' || state === 'failed' || state === 'cancelled') return state
  if (type === 'process.stopped') return 'cancelled'
  if (type === 'child.failed') return 'failed'
  if (type === 'child.cancelled') return 'cancelled'
  return 'completed'
}

/**
 * Имя прогона для уведомления: команда (процесс) или описание (саб-агент).
 *
 * Берётся из реестра фоновых прогонов (запись уже применена событием), иначе
 * — из payload. Длинные значения обрезаются.
 */
function backgroundRunName(
  isChild: boolean,
  payload: Record<string, unknown>,
): string {
  const runId = typeof payload.background_run_id === 'string' ? payload.background_run_id : ''
  const record = runId ? useProcessesStore.getState().byId[runId] : undefined
  const raw = isChild
    ? record?.description ?? payload.description
    : record?.command ?? payload.command
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length <= BACKGROUND_NOTIFY_NAME_LIMIT) return name
  return `${name.slice(0, BACKGROUND_NOTIFY_NAME_LIMIT - 1)}…`
}

/** Максимальная длина имени вопроса в уведомлении. */
const QUESTION_NOTIFY_NAME_LIMIT = 60

/**
 * Имя вопроса для уведомления: короткий заголовок первого вопроса.
 *
 * Fallback — `question`; длинные значения обрезаются (как имя прогона).
 */
function questionNotifyName(questions: QuestionItem[] | undefined): string {
  const header = questions?.[0]?.header
  const name = typeof header === 'string' ? header.trim() : ''
  if (!name) return 'question'
  if (name.length <= QUESTION_NOTIFY_NAME_LIMIT) return name
  return `${name.slice(0, QUESTION_NOTIFY_NAME_LIMIT - 1)}…`
}

/**
 * ADR-104: показать предупреждение о снятых инъекциях (`steer.dropped`).
 *
 * Причина в тексте: лимит на ход, остановка хода («Стоп») или закончившийся ход
 * — иначе сообщение, не попавшее в ход, «исчезало» без объяснения. Повторные
 * события подряд (одинаковая причина/количество/стрим в пределах окна)
 * не дают второго тоста — иначе серия снятий спамила бы уведомлениями.
 */
const STEER_DROPPED_DEDUP_MS = 3000
let lastSteerDropped: { key: string; at: number } | null = null

function notifySteerDropped(sid: string, payload: Record<string, unknown>): void {
  const rawReason = payload.reason
  const reason: 'limit' | 'aborted' | 'turn_ended' =
    rawReason === 'aborted' || rawReason === 'turn_ended' ? rawReason : 'limit'
  const rawCount = Number(payload.dropped_count)
  const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1
  const streamId = typeof payload.stream_id === 'string' ? payload.stream_id : ''

  const key = `${sid}|${reason}|${count}|${streamId}`
  const now = Date.now()
  if (lastSteerDropped && lastSteerDropped.key === key && now - lastSteerDropped.at < STEER_DROPPED_DEDUP_MS) {
    return
  }
  lastSteerDropped = { key, at: now }

  notifyMessage({
    text: i18nText(`notify.steer.dropped.${reason}`, { count }),
    type: 'warning',
    category: 'system',
    sessionId: sid,
  })
}

/**
 * Открыта ли сессия в **активной** центральной вкладке.
 *
 * Тост о вопросе нужен только для неактивной сессии: в открытой сессии док
 * вопроса и так виден пользователю (прецедент openchamber — `permission-toast`).
 * Непрочитанный счётчик в дереве инкрементит сам `notifyMessage`.
 */
function isSessionActive(sessionId: string): boolean {
  const state = useUIStore.getState()
  const activeTab = state.centerTabs.find((t) => t.id === state.activeCenterTabId)
  return activeTab?.data?.sessionId === sessionId
}

/**
 * Показать уведомление о фоновой работе (старт/финиш прогона).
 *
 * События, которые не относятся к фоновой работе, игнорируются. Каждое
 * пришедшее событие даёт уведомление (дедупа нет).
 */
function notifyBackgroundRun(type: string, payload: Record<string, unknown>): void {
  const isStart = BACKGROUND_START_EVENTS.has(type)
  const isFinish = BACKGROUND_FINISH_EVENTS.has(type)
  if (!isStart && !isFinish) return

  const isChild = type.startsWith('child.')
  const name = backgroundRunName(isChild, payload)
  const sessionId =
    (typeof payload.session_id === 'string' ? payload.session_id : undefined) ??
    (typeof payload.parent_session_id === 'string' ? payload.parent_session_id : undefined)

  if (isStart) {
    notifyMessage({
      text: i18nText(isChild ? 'notify.background.subagentStarted' : 'notify.background.started', { name }),
      type: 'info',
      category: 'system',
      ...(sessionId ? { sessionId } : {}),
    })
    return
  }

  const state = backgroundFinishState(type, payload)
  const textKey = isChild
    ? state === 'failed'
      ? 'notify.background.subagentFailed'
      : state === 'cancelled'
        ? 'notify.background.subagentCancelled'
        : 'notify.background.subagentCompleted'
    : state === 'failed'
      ? 'notify.background.failed'
      : state === 'cancelled'
        ? 'notify.background.cancelled'
        : 'notify.background.completed'
  notifyMessage({
    text: i18nText(textKey, { name }),
    type: state === 'failed' ? 'error' : state === 'cancelled' ? 'warning' : 'success',
    category: 'system',
    ...(sessionId ? { sessionId } : {}),
  })
}

/**
 * Фаза связи — источник истины для индикации в UI. `connected` оставлен без
 * изменения семантики (на нём завязаны Header и тесты), но он не различает
 * «первое подключение» и «потеря связи», поэтому для баннера/индикатора
 * используется `phase`.
 */
export type ConnectionPhase = 'connecting' | 'online' | 'reconnecting' | 'offline'

interface TransportState {
  transportMode: TransportMode
  activeTransport: TransportKind
  connected: boolean
  /** Текущая фаза связи. */
  phase: ConnectionPhase
  /** Момент входа в текущую фазу (мс). Не сбрасывается, если фаза не менялась. */
  phaseSince: number
  /** Было ли успешное подключение в этой загрузке страницы (connecting vs reconnecting). */
  hasEverConnected: boolean
  /** ADR-118 §8: модель сообщений инстанца не совпадает с клиентской. */
  versionMismatch: boolean
  openSessions: Set<string>

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => void
  disconnect: () => void
  /**
   * Принудительный перезапуск транспорта в обход guard'а идемпотентности
   * (`connect()` пропускает повтор к тому же транспорту). Нужен, когда
   * соединение выглядит открытым, но мертво (PWA после сна/смены сети).
   */
  restart: () => void
  setTransportMode: (mode: TransportMode) => void
  /**
   * ADR-118 §3: приём сообщения — **всегда** `202 {messageId, mode, position}`.
   * Ни SSE-ожидания, ни таймаута подтверждения: сервер отвечает сразу.
   * Возвращается принятый контракт — по `messageId` реплика показывается в ленте
   * оптимистично (статус доставки — «принято/в очереди/вмешательство»).
   * Ошибка (сеть/401/валидация) бросается.
   */
  sendMessage: (
    sessionId: string,
    text: string,
    agentRole?: string,
    provider?: string,
    model?: string,
    mode?: SteerMode,
    attachmentIds?: string[],
  ) => Promise<PromptAcceptedResponse>
  cancel: (sessionId: string) => void
  /**
   * Ответ на запрос подтверждения. `true` — ответ доставлен (WS-кадр или HTTP),
   * `false` — доставить не удалось (полосу не убирать: запрос ещё открыт).
   */
  sendPermissionReply: (sessionId: string, approvalId: string, approved: boolean, once?: boolean) => Promise<boolean>
  /** «Остановить таймер» — та же семантика доставки, что у `sendPermissionReply`. */
  sendPermissionHold: (sessionId: string, approvalId: string) => Promise<boolean>
  markSessionOpen: (sid: string) => void
  markSessionClosed: (sid: string) => void
}

// Экспортируется для юнит-тестов редьюсеров (subagent.retry / subagent.resume.*).
export function createDispatcher(): EventDispatcher {
  return (event: WSEvent) => {
    try {
    const type = event.type
    const payload = (event.data || event) as Record<string, unknown>

    const sid = (event.sessionId as string)
      || (event.session_id as string)
      || (payload.session_id as string)

    // ADR-118 §6: точка догона обновляется на **каждом** применённом событии —
    // до любых ранних `return` веток ниже. Исключение — инстансный канал
    // (`pipeline.run.*`): у него своя нумерация, смешивать с сессионной нельзя.
    if (sid && sid !== INSTANCE_CHANNEL_ID && typeof event.eventSeq === 'number') {
      const prev = lastEventSeqBySession.get(sid) ?? 0
      if (event.eventSeq > prev) lastEventSeqBySession.set(sid, event.eventSeq)
    }

    // ADR-101 §2.12.3: события прогона пайплайна (`pipeline.run.*`) публикуются
    // в **инстансный** канал шины — у них нет сессии (`sessionId` = 'instance'
    // или пусто). Обрабатываем ДО проверки `sid`, иначе они отбрасывались бы
    // как «бессессионные» (инвариант 6: новых транспортных каналов не заводим).
    if (type.startsWith('pipeline.')) {
      usePipelinesStore.getState().applyRunEvent(payload)
      return
    }

    // PROP-096/097: события единого реестра фоновых прогонов
    // (`process.*`/`child.*`). Они публикуются в канал сессии-владельца, но
    // разбираются ДО проверки `sid`: id сессии лежит в payload, а в кадре
    // WS его может не быть. Существующие подписки `child.*` не затрагиваются:
    // в диспетчере других веток `child.*` нет.
    if (type.startsWith('process.') || type.startsWith('child.')) {
      useProcessesStore.getState().applyEvent(type, payload)
      notifyBackgroundRun(type, payload)
      return
    }

    // ADR-114 §6: инвентарь worktree'ов проекта изменился. Событие идёт в
    // каналы сессий проекта, поэтому проект берём из payload (не из `sid`).
    // Разбираем ДО проверки `sid`: событие — сигнал «перечитай инвентарь».
    if (type === 'worktree.updated') {
      useWorktreesStore.getState().applyEvent(type, payload)
      // Привязка/отвязка меняет рабочий каталог сессии — перечитываем сессию.
      if (sid && (payload.action === 'attached' || payload.action === 'detached')) {
        refreshSessionFromApi(sid)
      }
      return
    }

    if (!sid) return

    const {
      upsertMessage,
      updateMessageById,
      setMessageStatus,
      upsertPart,
      appendPartDelta,
      startTurn,
      finishTurn,
      patchTurn,
      updateLiveSubagentUsage,
      setStreamRetry,
      setQueueStalled,
      setSummarizationPending,
      updateQueueCount,
      setQueueCounts,
      setQueueItems,
      patchPartData,
      upsertPendingMessage,
      removeFirstPending,
      setSubagentRetry,
      setSubagentResuming,
      setFinalStreamError,
    } = useChatStore.getState()

    /**
     * ADR-118 §5: сообщение-хода живёт от первой дельты до терминального
     * статуса. Идентификатор сообщения — из `step.started`/`message.delivered`;
     * если его ещё нет (старое ядро), берём id сообщения хода из стора.
     *
     * Id **хода** (`turnId`) фоллбэком не подставляется: в окне
     * `turn.started → step.started` это создало бы фантомное сообщение с id
     * хода (в ленте появился бы пузырь без содержимого).
     */
    const liveMessageId = (): string => {
      const turn = useChatStore.getState().turnBySession[sid]
      return (payload.messageId as string)
        || (payload.message_id as string)
        || turn?.messageId
        || ''
    }

    /**
     * ADR-118 §5: id сообщения шага для **tool-событий** (`tool_call.*`,
     * `subagent.progress`), отдельно от `liveMessageId` (тот остаётся строгой
     * привязкой к текущему шагу для `part.delta`/`part.updated`).
     *
     * Ядро публикует `tool_call.started` без `messageId` (только `stream_id`,
     * `call_id`, имя и аргументы), а `step.finished` приходит **до** запуска
     * инструментов. Поэтому `turn.messageId` (id шага) может быть пуст, когда
     * шаг уже закрыт: после перезагрузки `restoreLiveTurnFromSession` не
     * находит `streaming`-сообщения и не заполняет его. Фоллбэк — последнее
     * assistant-сообщение активного хода: именно в нём живут части вызовов.
     */
    const liveToolMessageId = (): string => {
      const chat = useChatStore.getState()
      const turn = chat.turnBySession[sid]
      const direct = (payload.messageId as string)
        || (payload.message_id as string)
      if (direct) return direct
      const messages = chat.messagesBySession[sid] ?? []
      // id хода доверяем, только пока сообщение есть в ленте: после смены
      // вкладок/снимка истории оно могло выпасть (гонка записи), и событие
      // инструмента адресовалось бы несуществующему сообщению.
      if (turn?.messageId && messages.some((m) => m.id === turn.messageId)) {
        return turn.messageId
      }
      const turnId = turn?.turnId
      if (!turnId) return ''
      return stepMessageForTurn(messages, turnId)?.id ?? ''
    }

    /**
     * Живое сообщение assistant'а: создаётся при первом событии хода
     * (ADR-118 §5) и живёт до терминального статуса.
     *
     * Возвращает `undefined`, когда сообщение трогать нельзя:
     * - сообщения ещё нет и **активного хода нет** — это опоздавшее событие
     *   прошлого хода (иначе в ленте появился бы фантомный пузырь);
     * - сообщение уже **финальное** (`completed`/`cancelled`/`error`) —
     *   поздняя дельта к финальному сообщению — мусор (ADR-118 §5); исключение
     *   — `opts.allowTerminal` (вызов инструмента относится к шагу и приходит
     *   уже после `step.finished`: ядро публикует финал шага **до** запуска
     *   тулов, и карточка тула обязана появиться в сообщении шага);
     * - событие относится к **другому** ходу (`opts.turnId`), а идёт ход —
     *   сообщение старого хода не создаём (фантом в блоке текущего хода).
     */
    const ensureLiveMessage = (
      messageId: string,
      extra?: Partial<MessageData>,
      opts?: { turnId?: string; allowTerminal?: boolean },
    ): MessageData | undefined => {
      if (!messageId) return undefined
      const chat = useChatStore.getState()
      const existing = chat.messagesBySession[sid]?.find((m) => m.id === messageId)
      if (existing) {
        // Финальное сообщение не воскрешаем: поздняя дельта — мусор.
        if (isTerminalMessageStatus(existing.status) && !opts?.allowTerminal) return undefined
        if (extra) chat.updateMessageById(sid, messageId, extra)
        return useChatStore.getState().messagesBySession[sid]?.find((m) => m.id === messageId)
      }
      // Активного хода нет — сообщение не создаём (опоздавшее событие).
      if (!isTurnActive(sid)) return undefined
      const turn = chat.turnBySession[sid]
      // Событие — другого хода (опоздавшее): сообщение не создаём.
      if (opts?.turnId && turn?.turnId && opts.turnId !== turn.turnId) return undefined
      const msgs = chat.messagesBySession[sid] || []
      const indexes = msgs
        .map((m) => m.index)
        .filter((i): i is number => typeof i === 'number' && Number.isFinite(i))
      const index = indexes.length > 0 ? Math.max(...indexes) + 1 : 0
      const message: MessageData = {
        index,
        id: messageId,
        role: 'assistant',
        content: '',
        parts: [],
        status: 'streaming',
        turn_id: turn?.turnId ?? null,
        step_index: turn?.stepIndex ?? null,
        agent_role: turn?.agentRole ?? undefined,
        model: turn?.model ?? undefined,
        provider: turn?.provider ?? undefined,
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: new Date().toISOString(),
        ...extra,
      }
      chat.upsertMessage(sid, message)
      return message
    }

    /**
     * ADR-118 §1/§5: индикатор «идёт» может быть только у **последнего**
     * (живого) сегмента хода. Перед новым шагом и в конце хода закрываем
     * оставшиеся `streaming` сегменты: `step.finished` мог не дойти или не
     * примениться (разрыв транспорта), и тогда точки «работы» оставались
     * в середине склеенного блока хода.
     *
     * Закрываются сегменты **того же хода**, что и событие (`onlyTurnId`):
     * опоздавшее событие старого хода (догон/реконнект/задержка) не должно
     * гасить индикатор текущего хода. Если ход события — текущий активный,
     * заведомо мёртвые сегменты прошлых ходов тоже закрываются. `onlyTurnId`
     * не задан — прежнее поведение (закрыть все).
     */
    const finalizeStreamingSegments = (
      status: MessageStatus,
      opts?: { keepMessageId?: string; onlyTurnId?: string },
    ): void => {
      const messages = useChatStore.getState().messagesBySession[sid] ?? []
      const activeTurnId = useChatStore.getState().turnBySession[sid]?.turnId
      for (const m of messages) {
        if (m.status !== 'streaming' || !m.id) continue
        if (opts?.keepMessageId && m.id === opts.keepMessageId) continue
        if (opts?.onlyTurnId) {
          const sameTurn = m.turn_id === opts.onlyTurnId
          // Сегмент **другого** хода не трогаем: опоздавшее событие старого
          // хода не должно гасить индикатор текущего.
          if (!sameTurn && opts.onlyTurnId !== activeTurnId) continue
        }
        setMessageStatus(sid, m.id, status)
      }
    }

    /**
     * Терминальное событие хода (`stream.error`/`stream.cancelled`) закрывает
     * ход.
     *
     * `turn.finished` может не дойти (ошибка/отмена пришли раньше или
     * потерялись при разрыве транспорта) — без закрытия
     * `turnBySession.status` остаётся `streaming`: композер навсегда в
     * режиме «в очередь + Стоп», а следующие сообщения не стартуют напрямую.
     *
     * Чужой/опоздавший ход не трогаем: закрывается только **активный** ход и
     * только если `stream_id` события совпадает с `streamId` хода (или
     * `stream_id` события не задан — тогда берём текущий ход).
     */
    const closeTurnOnTerminal = (
      streamId: string | undefined,
      status: 'error' | 'cancelled',
    ): void => {
      const turn = useChatStore.getState().turnBySession[sid]
      if (!turn || turn.status !== 'streaming') return
      if (streamId && turn.streamId && turn.streamId !== streamId) return
      finishTurn(sid, turn.turnId, status)
      // Ход закрыт — неразрешённые вклинивания из ленты убираем и состав
      // очереди перечитываем (ADR-118 §4): вклинивание либо применят позже
      // (отдельным `message.delivered`), либо оно вернулось в очередь.
      finishTurnAndRefreshQueue(sid)
    }

    switch (type) {
      // ADR-118 §4: `message.accepted` — **адресное** подтверждение приёма
      // (доходит только отправителю). Несёт `messageId`, `mode`, `position`.
      // Содержания сообщения в событии нет — саму реплику добавляет
      // `message.delivered`; здесь ведём только строку очереди и её позицию.
      case 'message.accepted': {
        const messageId = (payload.messageId as string) || ''
        if (!messageId) break
        const mode = (payload.mode as string) || ''
        // `steer`/`interrupt`: реплика ушла **в ход** и уже показана в ленте
        // (оптимистичная вставка `sendMessage`) — строка очереди была бы
        // дублем в панели очереди. Состав очереди уточняем у сервера.
        if (mode && mode !== 'queue') {
          reconcileQueueFromApi(sid)
          break
        }
        // Строка очереди: id известен; текст берём из уже показанной
        // оптимистичной строки (сервер его в событии не присылает — утечка снята).
        // Неизвестной строки нет — заполнится из истории при доставке.
        const knownPending = useChatStore.getState().pendingBySession[sid]
          ?.find((item) => item.id === messageId)
        upsertPendingMessage(sid, {
          id: messageId,
          content: knownPending?.content ?? '',
          agentRole: knownPending?.agentRole ?? null,
        })
        // Состав очереди уточняем у сервера (тексты и авторы — там).
        reconcileQueueFromApi(sid)
        break
      }

      // ADR-118 §4: `message.enqueued` — **адресное** событие «сообщение принято
      // и ждёт материализации». В отличие от `message.accepted` оно несёт
      // **снимок сообщения`.
      //
      // Показываем в ленте только `delivery: 'steer'` — сообщение **вклинивается
      // в текущий ход**, поэтому оно должно быть видно сразу, до материализации.
      // `delivery: 'queue'` — обычная очередь: она живёт только в панели очереди
      // (`QueuePanel`), в ленте её нет.
      case 'message.enqueued': {
        const messageId = (payload.messageId as string) || ''
        if (!messageId) break
        const delivery = (payload.delivery as string) === 'steer' ? 'steer' : 'queue'
        if (delivery !== 'steer') break
        const raw = payload.message
        const snapshot = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
        const existing = useChatStore.getState().messagesBySession[sid]?.find((m) => m.id === messageId)
        const msgs = useChatStore.getState().messagesBySession[sid] || []
        const indexes = msgs
          .map((m) => m.index)
          .filter((i): i is number => typeof i === 'number' && Number.isFinite(i))
        const index = indexes.length > 0 ? Math.max(...indexes) + 1 : 0
        const message = steerPendingMessageFromSnapshot(messageId, snapshot, index)
        // Материализованное сообщение (у него `ord`) вклинивающимся быть не
        // может: позднее событие маркер ожидания не возвращает.
        if (existing?.ord != null) message.steerPending = false
        // Дедуп по `id`: повторное событие (догон/реконнект) — патч, не дубль.
        upsertMessage(sid, message)
        break
      }

      // ADR-118 §4: `queue.state` — состояние очереди: счётчики и, аддитивно,
      // статусы элементов (`items: [{id, status}]`; без текста и автора).
      case 'queue.state': {
        const pendingCount = (payload.pendingCount as number) || 0
        const steerCount = (payload.steerCount as number) || 0
        // Сравнение счётчиков — **до** записи новых: `setQueueCounts` обновляет
        // и серверные значения (`serverCounts`), с которыми сравниваем.
        const changed = queueCountsChanged(sid, pendingCount, steerCount)
        setQueueCounts(sid, pendingCount, steerCount)
        setQueueItems(sid, extractQueueItems(payload.items))
        // Состав панели очереди берётся только из API (тексты и авторы там).
        // Изменились счётчики — изменился и состав: перечитываем очередь.
        if (changed) {
          reconcileQueueFromApi(sid)
        }
        break
      }

      // ADR-118 §4: `message.delivered` — сообщение материализовано в истории.
      // Несёт `messageId`, `ord`, роль и автора; **содержания нет** — если
      // сообщения ещё нет в сторе, догружаем историю и дедупим по `id`/`ord`.
      case 'message.delivered': {
        const messageId = (payload.messageId as string) || ''
        if (!messageId) break
        const ord = typeof payload.ord === 'number' ? payload.ord : null
        const role = (payload.role as string) || undefined
        const author = (payload.author as string) || undefined
        // ADR-118 §4 (аддитивно): ход сообщения — по нему UI привязывает
        // сообщение к ходу (группировка по `turn_id`).
        const turnId = (payload.turnId as string) || undefined
        const known = useChatStore.getState().messagesBySession[sid]?.find((m) => m.id === messageId)
        // Маркер ожидания снимается: сообщение записано в историю.
        const patch: Partial<MessageData> = { steerPending: false }
        if (ord != null) patch.ord = ord
        if (role) patch.role = role
        if (author) patch.author = author
        if (turnId) patch.turn_id = turnId
        if (known) {
          updateMessageById(sid, messageId, patch)
          break
        }
        // Сообщения в сторе нет — тянем **одно** сообщение по id (точечно),
        // а не всю историю; ошибка/404 → фоллбек на `mergeHistory`.
        void loadDeliveredMessage(sid, messageId, patch)
        break
      }

      // ADR-118 §1/§4: начало хода.
      case 'turn.started': {
        const turnId = (payload.turnId as string) || ''
        if (!turnId) break
        const active = useChatStore.getState().turnBySession[sid]
        if (active && active.status === 'streaming') {
          // Ход уже открыт (`stream.start` приходит раньше): **не заменяем** его —
          // `startTurn` стёр бы `streamId`/агента/модель, а по `streamId`
          // сопоставляется статус автоповтора (`stream.retry`).
          // `messageId` из payload — id **реплики пользователя**, а не живого
          // сообщения шага (оно придёт в `step.started`).
          patchTurn(sid, { turnId, status: 'streaming' })
        } else {
          startTurn(sid, {
            turnId,
            status: 'streaming',
            contentStarted: false,
          })
        }
        // Новый ход — снимаем следы прошлого: статус ретрая и плашку финальной
        // ошибки (иначе они «висели» бы над новым ответом).
        setStreamRetry(sid, null)
        setFinalStreamError(sid, null)
        break
      }

      // ADR-118 §1/§4: терминал хода.
      case 'turn.finished': {
        const turnId = (payload.turnId as string) || ''
        if (!turnId) break
        const status = (payload.status as 'completed' | 'cancelled' | 'error' | 'stopped') || 'completed'
        finishTurn(sid, turnId, status)
        // Ход завершён — ни один сегмент **этого** хода не может остаться
        // «живым»: закрываем оставшиеся `streaming` (даже если `step.finished`
        // потерялся). Опоздавшее `turn.finished` прошлого хода закрывает
        // только его сегменты — индикатор текущего хода не гасим.
        finalizeStreamingSegments(
          status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'cancelled',
          { onlyTurnId: turnId },
        )
        // Ход завершён — висящих запросов подтверждения по нему быть не может
        // (ask снят ответом/отменой/таймаутом): полосу убираем.
        usePermissionStore.getState().clearSession(sid)
        // Ход завершён — неразрешённые вклинивания из ленты убираем и состав
        // очереди перечитываем (ADR-118 §4): применённые уже пришли с
        // `message.delivered` (маркер снят), неприменённые вернулись в очередь.
        finishTurnAndRefreshQueue(sid)
        break
      }

      // ADR-118 §1/§4: шаг хода — assistant-сообщение создаётся здесь и живёт
      // до `step.finished` («финал» = смена статуса, ADR-118 §5).
      case 'step.started': {
        const turnId = (payload.turnId as string) || ''
        const messageId = (payload.messageId as string) || ''
        if (!messageId) break
        const stepIndex = typeof payload.stepIndex === 'number' ? payload.stepIndex : undefined
        const active = useChatStore.getState().turnBySession[sid]
        const activeTurnId = active?.turnId
        if (turnId) {
          if (!activeTurnId) {
            // Хода в сторе нет — шаг его открывает (границы хода, ADR-118 §1).
            startTurn(sid, {
              turnId,
              messageId,
              status: 'streaming',
              ...(stepIndex != null ? { stepIndex } : {}),
            })
          } else if (activeTurnId === turnId) {
            patchTurn(sid, { messageId, ...(stepIndex != null ? { stepIndex } : {}) })
          } else if (active?.status !== 'streaming') {
            // Текущий ход завершён, а событие — уже другого хода: `turn.started`
            // мог не дойти — открываем ход события.
            startTurn(sid, {
              turnId,
              messageId,
              status: 'streaming',
              ...(stepIndex != null ? { stepIndex } : {}),
            })
          }
          // Иначе ход события — **другой** (текущий идёт): событие опоздавшее,
          // границы текущего хода не переписываем.
        }
        // Новый шаг закрывает предыдущие сегменты хода: живым остаётся только
        // он (индикатор не может «застрять» в середине склеенного блока).
        // Заодно закрываются сегменты прошлого хода, чей `step.finished` потерян.
        finalizeStreamingSegments('completed', { keepMessageId: messageId, onlyTurnId: turnId || undefined })
        ensureLiveMessage(
          messageId,
          {
            ...(turnId ? { turn_id: turnId } : {}),
            ...(stepIndex != null ? { step_index: stepIndex } : {}),
            /**
             * ADR-119: служебный шаг сжатия — это **резюме**, а не ответ
             * ассистента: роль `summary` вместо `assistant`, чтобы расход
             * вызова сжатия не выглядел в ленте и в индикаторе как ответ
             * агента (роль сервера потом побеждает — он пришлёт `summary`).
             */
            ...(payload.kind === 'compression' ? { role: 'summary' } : {}),
            status: 'streaming',
          },
          { turnId: turnId || undefined },
        )
        break
      }

      // ADR-118 §3: инструменты шага запущены — между `step.finished` и
      // результатом инструмента живого сегмента в ленте нет. Флаг хода даёт
      // строке активности честный текст («Выполняется инструмент…»).
      // Учитываем только активный ход и только его собственный `turnId`:
      // опоздавшее событие прошлого хода индикатор текущего не переключает.
      case 'step_tools_started':
      case 'step.tools.started': {
        const turnId = (payload.turnId as string) || ''
        const turn = useChatStore.getState().turnBySession[sid]
        if (!turn || turn.status !== 'streaming') break
        if (turnId && turn.turnId && turnId !== turn.turnId) break
        const messageId = (payload.messageId as string) || liveToolMessageId()
        const stepIndex = typeof payload.stepIndex === 'number' ? payload.stepIndex : undefined
        patchTurn(sid, {
          toolsRunning: true,
          ...(messageId ? { messageId } : {}),
          ...(stepIndex != null ? { stepIndex } : {}),
        })
        break
      }

      // ADR-118 §3: инструменты шага завершены — возвращаем обычный индикатор.
      case 'step_tools_finished':
      case 'step.tools.finished': {
        patchTurn(sid, { toolsRunning: false })
        break
      }

      // ADR-118 §4: шаг завершён — терминальный статус сообщения + учёт токенов.
      case 'step.finished': {
        const messageId = (payload.messageId as string) || ''
        if (!messageId) break
        const turnId = (payload.turnId as string) || ''
        const status = (payload.status as 'completed' | 'cancelled' | 'error') || 'completed'
        // Опоздавшее событие прошлого хода: сообщения нет и активного хода нет —
        // создавать нечего (финальное сообщение не воскрешаем).
        const live = ensureLiveMessage(messageId, undefined, { turnId: turnId || undefined })
        // Замена удалённых `stream.usage`/`stream.done`: расход, модель и
        // стоимость шага приходят здесь (ADR-118 §4) — кладём в сообщение,
        // иначе статистика/аналитика теряют live-данные.
        const patch: Partial<MessageData> = {}
        /**
         * ADR-119: у служебного шага сжатия `usage` — расход **вызова
         * сжатия** (весь транскрипт на входе), а не занятость контекстного
         * окна: в сообщение-резюме его не кладём (в историю оно придёт из
         * серверной записи резюме, а индикатор резюме не учитывает).
         */
        const usage = payload.kind === 'compression' ? undefined : mapUsage(payload.usage)
        if (usage) patch.usage = usage
        if (typeof payload.provider === 'string' && payload.provider) patch.provider = payload.provider
        if (typeof payload.model === 'string' && payload.model) patch.model = payload.model
        if (typeof payload.agentRole === 'string' && payload.agentRole) patch.agent_role = payload.agentRole
        const extraMeta: Record<string, unknown> = {}
        if (payload.costUsd !== undefined) extraMeta.cost_usd = payload.costUsd
        if (payload.costCurrency !== undefined) extraMeta.cost_currency = payload.costCurrency
        if (payload.timings !== undefined) extraMeta.timings = payload.timings
        if (payload.attachments !== undefined) extraMeta.attachments = payload.attachments
        if (Object.keys(extraMeta).length > 0) {
          const known = useChatStore.getState().messagesBySession[sid]
            ?.find((m) => m.id === messageId)?.metadata
          patch.metadata = { ...(known ?? {}), ...extraMeta }
        }
        if (Object.keys(patch).length > 0) updateMessageById(sid, messageId, patch)
        // ADR-118 §5: «финал» шага = **смена статуса**, и она происходит
        // **сразу**, синхронно: индикатор работы гаснет в момент финала шага,
        // а не после ответа `GET /messages` (до этого точки «работы» висели в
        // середине склеенного блока хода — у уже завершённого шага).
        //
        // Live-части при этом НЕ снимаем: карточка инструмента шага должна
        // остаться видимой (ядро публикует `step.finished` **до** запуска
        // тулов, результат приходит позже через `tool_call.result` — с
        // очисткой карточка мигала бы на всё время исполнения тула).
        // «Застрявший» текст прошлого шага в рендер не попадает: текст и
        // рассуждения берутся только из dto-частей (`resolveLiveParts`).
        if (!live) break
        setMessageStatus(sid, messageId, status)
        // Сверка с историей — источник истины по **содержимению** шага (части/
        // контент). Ошибка сети молча игнорируется: live-части остаются
        // единственным источником текста шага.
        void mergeHistory(sid)
        break
      }

      // ADR-118 §4: дельта части — **upsert** по `{messageId, partId}`.
      case 'part.delta': {
        const messageId = (payload.messageId as string) || ''
        const partId = (payload.partId as string) || ''
        if (!messageId || !partId) break
        // Сообщения нет (опоздавшая дельта прошлого хода) или оно финальное —
        // дельта мусорна: игнорируем (ADR-118 §5).
        if (!ensureLiveMessage(messageId)) break
        // Части идут — статус ретрая и плашка финальной ошибки прошлой попытки
        // больше не актуальны (как у прежнего `stream.chunk`).
        if (useChatStore.getState().retryBySession[sid]) setStreamRetry(sid, null)
        setFinalStreamError(sid, null)
        // Первая часть ответа — контент хода начался: индикатор «идёт»
        // переезжает с реплики пользователя в живой сегмент ответа.
        markTurnContentStarted(sid)
        appendPartDelta(
          sid,
          messageId,
          partId,
          (payload.field as 'text' | 'raw') || 'text',
          (payload.delta as string) || '',
        )
        break
      }

      // ADR-118 §4: часть обновлена целиком — upsert по `{messageId, partId}`.
      case 'part.updated': {
        const messageId = (payload.messageId as string) || ''
        const partId = (payload.partId as string) || ''
        const part = payload.part as { id?: string; type?: string; data?: unknown } | undefined
        if (!messageId || !partId) break
        // Как и для дельты: финальное сообщение не воскрешаем.
        if (!ensureLiveMessage(messageId)) break
        // Часть обновлена — контент хода начался (как и для дельты).
        markTurnContentStarted(sid)
        upsertPart(sid, messageId, partId, {
          id: partId,
          type: (part?.type as never) || 'text',
          text: partText(part?.data),
          data: part?.data,
        })
        break
      }

      case 'message_added':
      case 'message.added': {
        // События родителя — плоские поля; события дочерней сессии
        // (`publishMessageAdded` в task.ts) несут сериализованное сообщение во
        // вложенном `message` (+ top-level `index`). Без разворачивания вложенный
        // payload давал фантомное пустое сообщение с index: undefined.
        const nested = payload.message && typeof payload.message === 'object'
          ? payload.message as Record<string, unknown>
          : undefined
        const src = nested ?? payload
        const usage = (src.usage as MessageData['usage']) ?? undefined
        // ADR-118 §4/§5: `message.added` — legacy-событие совместимости
        // (усечённый контент). Сообщение шага уже пришло `step.started` /
        // `part.*` и живёт в ленте; событие обязано адресоваться **тем же**
        // `id` (ядро кладёт его в payload, старое ядро — нет, тогда берём id
        // живого сообщения хода). Без адреса создавался второй пузырь того же
        // ответа («правильный» + задвоенный).
        const addedRole = (src.role as string) || 'assistant'
        const addedId = (src.id as string) || (src.message_id as string)
          || (addedRole === 'assistant' ? useChatStore.getState().turnBySession[sid]?.messageId : undefined)
          || undefined
        if (addedId && useChatStore.getState().messagesBySession[sid]?.some((m) => m.id === addedId)) {
          // Сообщение уже в ленте (живое) — дополнять нечем: пропускаем.
          break
        }
        const msg: MessageData = {
          index: (src.index as number) ?? (src.message_index as number) ?? (payload.index as number),
          id: addedId,
          role: addedRole,
          content: (src.content as string) || '',
          // ADR-118: порядок и принадлежность ходу — из DTO.
          ord: (src.ord as number | null) ?? null,
          turn_id: (src.turn_id as string | null) ?? null,
          step_index: (src.step_index as number | null) ?? null,
          status: (src.status as MessageData['status']) ?? null,
          agent_role: (src.agent_role as string) || undefined,
          author: (src.author as string) || undefined,
          model: (src.model as string) || undefined,
          provider: (src.provider as string) || undefined,
          reasoning: (src.reasoning as string) || undefined,
          intermediate_text_blocks: src.intermediate_text_blocks as Array<{ text: string; iteration: number }> | undefined,
          tool_calls: (src.tool_calls as MessageData['tool_calls']) ?? null,
          // ADR-115: части сообщения — медиа-вложения в живой ленте (до
          // перезагрузки), иначе остаётся только текстовый плейсхолдер.
          parts: (src.parts as MessageData['parts']) ?? undefined,
          usage,
          metadata: src.metadata as Record<string, unknown> | undefined,
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }
        upsertMessage(sid, msg)
        break
      }

      // ADR-118 §4/§7: сообщение удалено в другом клиенте (`DELETE /messages/...`
      // или batch `action:'delete'`). Убираем его из ленты и вместе с live-частями.
      case 'message.deleted': {
        const messageId = (payload.message_id as string) || (payload.messageId as string) || ''
        if (!messageId) break
        const chatState = useChatStore.getState()
        const known = chatState.messagesBySession[sid]?.some((m) => m.id === messageId) ?? false
        const hasParts = Boolean(chatState.partsBySession[sid]?.[messageId])
        // Неизвестный id — no-op (удаление могло прийти раньше загрузки истории).
        if (!known && !hasParts) break
        if (known) chatState.removeMessageById(sid, messageId)
        if (hasParts) {
          useChatStore.setState((s) => {
            const sessionParts = s.partsBySession[sid]
            if (!sessionParts?.[messageId]) return s
            const nextSession = { ...sessionParts }
            delete nextSession[messageId]
            return { partsBySession: { ...s.partsBySession, [sid]: nextSession } }
          })
        }
        break
      }

      // ADR-118 §4/§7: состояние сообщения изменилось в другом клиенте (pin /
      // toggle / batch / retry). Патчим только пришедшие поля — остальное
      // (в т.ч. live-части `streaming`-сообщения) не трогаем. Неизвестный id —
      // no-op: событие могло прийти раньше загрузки истории.
      case 'message.updated': {
        const messageId = (payload.message_id as string) || (payload.messageId as string) || ''
        if (!messageId) break
        const patch: Partial<MessageData> = {}
        if (typeof payload.pinned === 'boolean') patch.pinned = payload.pinned
        if (typeof payload.disabled === 'boolean') patch.disabled = payload.disabled
        if (Object.keys(patch).length === 0) break
        updateMessageById(sid, messageId, patch)
        break
      }

      // ADR-104 (решение 2026-10-28): сообщение не применено — лимит на ход,
      // остановка хода («Стоп») или ход уже закончился. Предупреждаем, иначе
      // отправленное «в ход» сообщение просто исчезало бы из виду.
      case 'steer.dropped': {
        notifySteerDropped(sid, payload)
        // Сообщение не применено — в ленте его больше нет: по id, если событие
        // их несёт, иначе — все неразрешённые вклинивания сессии
        // (`delivery: 'steer'`).
        const droppedIds = extractDroppedMessageIds(payload)
        removeSteerPendingMessages(sid, droppedIds.length > 0 ? droppedIds : undefined)
        break
      }

      case 'stream_start':
      case 'stream.start': {
        const agentRole = (payload.agent_role as string) || null
        const metadata = payload.metadata as Record<string, unknown> | undefined
        const streamId = (payload.stream_id as string) || ''
        // ADR-118 §1: ход начинается; его границы — `turnId`/`streamId`.
        const turnId = (payload.turnId as string) || streamId
        if (turnId) {
          const active = useChatStore.getState().turnBySession[sid]
          if (active && active.status === 'streaming') {
            // Живой ход уже открыт (`turn.started` или восстановление после
            // перезагрузки) — **не заменяем** его: `startTurn` сбросил бы
            // `contentStarted` и потерял поля хода. Дополняем ход данными
            // стрима; `contentStarted` не трогаем (контент хода уже был).
            patchTurn(sid, {
              ...(streamId ? { streamId } : {}),
              ...(agentRole ? { agentRole } : {}),
              ...(payload.model ? { model: payload.model as string } : {}),
              ...(payload.provider ? { provider: payload.provider as string } : {}),
            })
          } else {
            startTurn(sid, {
              turnId,
              streamId: streamId || undefined,
              status: 'streaming',
              agentRole,
              model: payload.model as string | undefined,
              provider: payload.provider as string | undefined,
              // Контента хода ещё нет — индикатор «идёт» живёт у реплики.
              contentStarted: false,
            })
          }
        }
        // Новая попытка — сбрасываем статус ретрая предыдущей
        setStreamRetry(sid, null)
        // Новый стрим — плашка финальной ошибки больше не актуальна
        setFinalStreamError(sid, null)

        const qs = useChatStore.getState().queueBySession[sid]
        if (qs && qs.pendingCount > 0) {
          removeFirstPending(sid)
          if (metadata?.type === 'summary') {
            // Суммаризация — системное сообщение, счётчик user-сообщений не
            // декрементируем; только сбрасываем stalled.
            useChatStore.setState((s) => ({
              queueBySession: {
                ...s.queueBySession,
                [sid]: { ...qs, isStalled: false },
              },
            }))
          } else {
            const nextCount = qs.pendingCount - 1
            if (nextCount <= 0) {
              useChatStore.getState().clearQueueState(sid)
            } else {
              useChatStore.setState((s) => ({
                queueBySession: {
                  ...s.queueBySession,
                  [sid]: { ...qs, pendingCount: nextCount, isStalled: false },
                },
              }))
            }
          }
        }
        break
      }

      // ADR-118 §4: дельта части приходит отдельным событием (`part.delta`).
      // Прежний `stream.chunk` (удалён без dual-emit) оставлен как совместимость
      // со старым ядром: текст кладётся в текстовую часть.
      case 'stream_chunk':
      case 'stream.chunk': {
        // Стрим реально пошёл после ретрая — сбрасываем «зависшую» надпись о
        // повторе (финал хода мог не дойти/быть потерян при разрыве транспорта).
        if (useChatStore.getState().retryBySession[sid]) setStreamRetry(sid, null)
        // Чанки идут — финальная ошибка прошлой попытки больше не актуальна
        setFinalStreamError(sid, null)
        const messageId = liveMessageId()
        if (!messageId) break
        if (!ensureLiveMessage(messageId)) break
        const content = (payload.content as string) || ''
        const reasoning = (payload.reasoning as string) || ''
        const iteration = (payload.iteration as number) ?? 0
        if (content) appendPartDelta(sid, messageId, `${TEXT_PART_PREFIX}${iteration}`, 'text', content)
        if (reasoning) appendPartDelta(sid, messageId, `msg:reasoning:${iteration}`, 'text', reasoning)
        break
      }

      // ADR-070 §2.6: live-статистика стрима (кумулятивный usage, cost, model).
      case 'stream_usage':
      case 'stream.usage': {
        const messageId = liveMessageId()
        if (!messageId) break
        ensureLiveMessage(messageId, {
          usage: mapUsage(payload.usage),
          metadata: {
            ...(payload.cost_usd !== undefined ? { cost_usd: payload.cost_usd } : {}),
            ...(payload.cost_currency !== undefined ? { cost_currency: payload.cost_currency } : {}),
            ...(payload.cost_breakdown !== undefined ? { cost_breakdown: mapCostBreakdown(payload.cost_breakdown) } : {}),
            ...(payload.usage_estimated !== undefined ? { usage_estimated: payload.usage_estimated } : {}),
            ...(payload.duration_ms !== undefined ? { duration_ms: payload.duration_ms } : {}),
          } as Record<string, unknown>,
          model: (payload.model as string) || undefined,
          provider: (payload.provider as string) || undefined,
        })
        break
      }

      // ADR-118 §4: `stream.done` удалён без dual-emit; прежний финал хода —
      // `step.finished` + `turn.finished`. Совместимость со старым ядром:
      // финализируем живое сообщение теми же данными.
      case 'stream_done':
      case 'stream.done': {
        const messageId = liveMessageId() || (payload.message_id as string) || ''
        const status = (payload.status as ResponseStatus) || 'completed'
        const usage = mapUsage(payload.usage)
        const metadata = {
          ...(payload.metadata as Record<string, unknown> | undefined),
          ...(payload.duration_ms !== undefined ? { duration_ms: payload.duration_ms } : {}),
          ...(payload.cost_usd !== undefined ? { cost_usd: payload.cost_usd } : {}),
          ...(payload.cost_currency !== undefined ? { cost_currency: payload.cost_currency } : {}),
          ...(payload.cost_breakdown !== undefined ? { cost_breakdown: mapCostBreakdown(payload.cost_breakdown) } : {}),
          ...(payload.usage_estimated !== undefined ? { usage_estimated: payload.usage_estimated } : {}),
        }
        if (messageId) {
          const live = ensureLiveMessage(messageId, {
            content: (payload.content as string) || undefined,
            usage,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            model: (payload.model as string) || undefined,
            provider: (payload.provider as string) || undefined,
            tool_calls: (payload.tool_calls as MessageData['tool_calls']) ?? undefined,
          })
          if (live) {
            setMessageStatus(
              sid,
              messageId,
              status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'error',
            )
          }
          // Терминал хода: прочих «живых» сегментов остаться не должно.
          // Закрываем сегменты **того же** хода (опоздавшее `stream.done`
          // прошлого хода не гасит индикатор текущего).
          const eventTurnId = (payload.turnId as string) || (payload.turn_id as string) || ''
          finalizeStreamingSegments(
            status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'error',
            { keepMessageId: messageId, onlyTurnId: eventTurnId || undefined },
          )
        }
        setStreamRetry(sid, null)
        setFinalStreamError(sid, null)
        // Ход завершён — висящих запросов подтверждения по нему быть не может
        // (ask снят ответом/отменой/таймаутом): полосу убираем.
        usePermissionStore.getState().clearSession(sid)

        const pendingCount = payload.pending_count as number | undefined
        if (pendingCount !== undefined && pendingCount > 0) {
          updateQueueCount(sid, pendingCount)
        } else if (pendingCount === 0) {
          useChatStore.getState().clearQueueState(sid)
        }
        break
      }

      // ADR-070 §2.6: терминальное live-событие дочерней сессии саб-агента
      // (task.ts). Сообщение ребёнка сохраняется отдельно.
      case 'stream_ended':
      case 'stream.ended': {
        break
      }

      case 'stream_cancelled':
      case 'stream.cancelled': {
        // ADR-118 §4: отмена хода — `step.finished` со статусом `cancelled`.
        // Совместимость со старым ядром: финализируем живое сообщение.
        const messageId = liveMessageId()
        if (messageId) {
          if (ensureLiveMessage(messageId)) setMessageStatus(sid, messageId, 'cancelled')
        }
        // Терминал хода — закрываем ход (иначе композер остаётся в режиме
        // «в очередь + Стоп», а следующие сообщения не стартуют напрямую).
        closeTurnOnTerminal(asNonEmptyString(payload.stream_id), 'cancelled')
        setStreamRetry(sid, null)
        // Отмена («Стоп»)/таймаут снимают ожидание подтверждения на бэкенде —
        // полоса не должна оставаться после отмены.
        usePermissionStore.getState().clearSession(sid)
        break
      }

      // ADR-104 (этап 2): прерывание текущей генерации (`interrupt`). Ход НЕ
      // завершается и НЕ отменяется («Стоп» — отдельный механизм, ADR-005):
      // накопленный текст прерванной генерации уже сохранён отдельным
      // сообщением (ADR-118 §4: `step.finished` со статусом `cancelled`).
      case 'stream_interrupted':
      case 'stream.interrupted': {
        const messageId = liveMessageId()
        if (messageId) setMessageStatus(sid, messageId, 'cancelled')
        break
      }

      case 'stream_error':
      case 'stream.error': {
        const streamId = payload.stream_id as string
        const errorType = (payload.error_type as string) || ''
        const rawError = (payload.error as string) || 'Unknown error'
        const canRetry = Boolean(payload.can_retry)

        if (canRetry) {
          // Recoverable-ошибка: бэкенд продолжит ретраи. Ход НЕ завершаем,
          // ничего пользователю не показываем — статус ретрая придёт событием
          // stream.retry (отобразится в user-сообщении).
          break
        }

        // Ошибка переполнения контекстного окна — показываем дружелюбный текст
        // вместо сырого сообщения провайдера.
        const error = errorType === 'context_length'
          ? i18nText('chat.error.contextLength')
          : rawError

        // Финальная ошибка (неrecoverable / исчерпаны попытки / отменено):
        // завершаем ход, убираем ретраи и индикатор обработки, показываем
        // стандартное уведомление (toast + история) и плашку над полем ввода
        // с возможностью повторить (для recoverable error_type — см. StreamErrorPanel).
        setStreamRetry(sid, null)
        const messageId = liveMessageId()
        if (messageId) {
          if (ensureLiveMessage(messageId)) setMessageStatus(sid, messageId, 'error')
        }
        // Терминал хода — закрываем ход (иначе композер остаётся в режиме
        // «в очередь + Стоп», а следующие сообщения не стартуют напрямую).
        closeTurnOnTerminal(asNonEmptyString(payload.stream_id), 'error')
        setFinalStreamError(sid, { streamId, error: rawError, errorType: errorType || 'unknown' })
        notifyMessage({ text: error, type: 'error', category: 'error', sessionId: sid })
        break
      }

      case 'stream_retry':
      case 'stream.retry': {
        const streamId = payload.stream_id as string
        const retryInMs = (payload.retry_in as number) || 5000
        const attempt = (payload.attempt as number) || 1
        const maxRetries = (payload.max_retries as number) || 3

        setStreamRetry(sid, {
          streamId,
          attempt,
          maxRetries,
          retryInMs,
          error: payload.error as string | undefined,
        })
        break
      }
      case 'queue_stalled':
      case 'queue.stalled': {
        setQueueStalled(sid, (payload.pending_count as number) || 0)
        break
      }

      case 'question.asked': {
        const pendingCount = (payload.pending_count as number) || 0
        if (pendingCount > 0) {
          const hasStream = isTurnActive(sid)
          if (!hasStream) {
            setQueueStalled(sid, pendingCount)
          } else {
            updateQueueCount(sid, pendingCount)
          }
        }
        break
      }

      case 'permission.asked': {
        const approvalId = payload.approval_id as string | undefined
        if (!approvalId) break

        const toolName = (payload.tool as string) || (payload.tool_name as string) || 'tool'
        const params = (payload.arguments as Record<string, unknown>)
          || (payload.params as Record<string, unknown>)
          || {}
        const reason = (payload.reason as string) || ''
        const timeoutMs = (payload.ask_timeout_ms as number | undefined) ?? PERMISSION_ASK_TIMEOUT_MS
        // Превью изменений (аддитивно): diff по файлам, которые тул изменит.
        const preview = parsePermissionPreview(payload.preview)
        // Shell-грант: паттерны, которые будут разрешены в сессии (аддитивно).
        const save = Array.isArray(payload.save)
          ? payload.save.filter((item): item is string => typeof item === 'string')
          : undefined

        usePermissionStore.getState().addRequest(sid, {
          approvalId,
          toolName,
          params,
          reason,
          askedAt: new Date().toISOString(),
          timeoutMs,
          ...(preview ? { preview } : {}),
          ...(save ? { save } : {}),
        })
        break
      }

      // Вопросы пользователю (`ask_user`, этап 1 roadmap 0.13 — блок 1.3).
      // ⚠️ Это НЕ `question.asked` — тот означает «очередь зависла» (см. выше).
      case 'user_question.asked': {
        const full = payload.question as QuestionRecord | undefined
        const questionId = (payload.question_id as string | undefined) || full?.id
        if (!questionId) break

        const now = new Date().toISOString()
        const record: QuestionRecord = full && typeof full === 'object'
          ? { ...full, id: full.id || questionId, sessionId: full.sessionId || sid }
          : {
              id: questionId,
              sessionId: sid,
              status: 'pending',
              questions: (payload.questions as QuestionItem[]) ?? [],
              createdAt: now,
              updatedAt: now,
              // Срок ожидания из события (ISO-8601) — по нему UI рисует
              // обратный отсчёт; без таймаута поля нет.
              ...(payload.expires_at ? { expiresAt: String(payload.expires_at) } : {}),
              ...(payload.turn_id ? { turnId: String(payload.turn_id) } : {}),
              ...(payload.tool_call_id ? { toolCallId: String(payload.tool_call_id) } : {}),
              ...(payload.agent_role ? { agentRole: String(payload.agent_role) } : {}),
            }
        useQuestionStore.getState().add(sid, record)
        // Тост — только если сессия **не** открыта: в открытой сессии док
        // вопроса и так виден пользователю. Непрочитанный счётчик в дереве
        // инкрементит сам `notifyMessage` (то же правило, что в нём).
        if (!isSessionActive(sid)) {
          notifyMessage({
            text: i18nText('notify.question.asked', { name: questionNotifyName(record.questions) }),
            type: 'info',
            category: 'system',
            sessionId: sid,
          })
        }
        break
      }

      // Вопрос закрыт (ответили или отменили) — из pending он уходит.
      case 'user_question.answered':
      case 'user_question.cancelled': {
        const questionId = payload.question_id as string | undefined
        if (questionId) useQuestionStore.getState().remove(sid, questionId)
        break
      }

      case 'context.sticky_note_added': {
        const noteId = payload.note_id as string | undefined
        if (noteId) {
          synthApi.getStickyNotes(sid).then((r) => {
            useChatStore.getState().setStickyNotes(sid, r.notes)
          }).catch(() => {})
        }
        break
      }

      case 'context.sticky_note_updated':
      case 'context.sticky_note_deleted': {
        synthApi.getStickyNotes(sid).then((r) => {
          useChatStore.getState().setStickyNotes(sid, r.notes)
        }).catch(() => {})
        break
      }

      // ADR-069 §9.3: проектные инструкции загружены (initial/lazy) — обновляем
      // снимок прозрачности для индикатора в правой панели.
      case 'context.instructions_loaded': {
        void useInstructionsStore.getState().load(sid)
        break
      }

      case 'session.updated': {
        const patch = payload as Record<string, unknown>
        useSessionsStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sid ? { ...sess, ...patch } : sess,
          ),
        }))
        if (patch.summarization_pending === false) {
          setSummarizationPending(sid, false)
        }
        if (typeof patch.name === 'string' && patch.name) {
          useUIStore.getState().updateTabTitle(`chat-${sid}`, patch.name)
        }
        break
      }

      // ADR-040: сессия перенесена между проектами (PATCH /sessions/:id или
      // project_create/project_attach от агента). Локально патчим project_id,
      // догружаем сессию (план/workspace/plan_approved сброшены), перечитываем
      // список проектов (новый проект может отсутствовать в сторе) и дерево Files.
      case 'session.moved': {
        const projectId = (payload.project_id as string | null | undefined) ?? null
        useSessionsStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sid ? { ...sess, project_id: projectId } : sess,
          ),
        }))
        refreshSessionFromApi(sid)
        useProjectsStore.getState().loadProjects().catch(() => {})
        if (projectId) void useFilesStore.getState().refreshProject(projectId)
        break
      }

      // История сессии очищена (`POST /sessions/:id/clear`): на сервере остались
      // только закреплённые сообщения, очередь и счётчики сброшены. Снимок здесь
      // **авторитетен** — `setMessages`, а не мерж: защита активного хода
      // (`mergeServerMessages`) оставила бы удалённые сообщения в ленте.
      case 'session.messages.cleared': {
        void (async () => {
          try {
            const r = await synthApi.getSessionMessages(sid, { limit: MESSAGES_PAGE_LIMIT })
            // Части сообщений, которых нет в новом снимке, больше не нужны
            // (их id уже не отрисуются). Части живого хода (оставшиеся в снимке)
            // не трогаем.
            const previous = useChatStore.getState().messagesBySession[sid] ?? []
            const nextIds = new Set(r.messages.map((m) => m.id).filter((id): id is string => !!id))
            const removedIds = previous
              .map((m) => m.id)
              .filter((id): id is string => !!id && !nextIds.has(id))
            if (removedIds.length > 0) {
              useChatStore.setState((s) => {
                const sessionParts = s.partsBySession[sid]
                if (!sessionParts) return s
                const nextParts = { ...sessionParts }
                let changed = false
                for (const id of removedIds) {
                  if (!nextParts[id]) continue
                  delete nextParts[id]
                  changed = true
                }
                if (!changed) return s
                return { partsBySession: { ...s.partsBySession, [sid]: nextParts } }
              })
            }
            useChatStore.getState().setMessages(sid, r.messages)
            // История очищена — пагинация сбрасывается: старых страниц больше нет.
            useChatStore.getState().setHistoryPage(sid, { hasMore: false, nextBefore: null })
            useChatStore.getState().clearQueueState(sid)
            useChatStore.getState().setQueueCounts(sid, 0, 0)
          } catch {
            // Сеть недоступна — очистка останется до следующего refresh истории.
          }
        })()
        break
      }

      // Сообщения из другой сессии скопированы (`POST /sessions/:id/messages/merge`).
      // Payload — **только добавленные** сообщения, а не полный снимок истории:
      // поэтому incoming сводится с уже показанной лентой (иначе семантика
      // «снимок — источник состава» удалила бы остальные сообщения).
      case 'session.messages.merged': {
        const incoming = Array.isArray(payload.messages)
          ? (payload.messages as MessageData[])
          : null
        if (incoming) {
          const current = useChatStore.getState().messagesBySession[sid] ?? []
          mergeServerMessages(sid, [...current, ...incoming])
          break
        }
        // Старое ядро не прислало сообщения — перечитываем полную историю.
        void (async () => {
          try {
            const r = await synthApi.getSessionMessages(sid, { limit: MESSAGES_PAGE_LIMIT })
            applyHistoryPage(sid, r)
          } catch {
            // История — уточнение; живое состояние ленты не затираем.
          }
        })()
        break
      }

      // `session.reference.added/removed` осознанно не обрабатываются: вкладка
      // «Ссылки» перечитывает список при открытии, live-обновление не требуется.

      // План утверждён (ADR-039): план живёт в проекте (project.plan), событие
      // plan.approved несёт только session_id/project_id — достаточно полного
      // refresh сессии (план проекта рендерится во вкладке «Проект» отдельно).
      case 'plan.approved':
      case 'plan.updated': {
        refreshSessionFromApi(sid)
        break
      }

      // ADR-089: внешнее событие материализовано в сессию (ingress). Данные
      // сессии могли измениться — полный refresh; сами изменения приходят
      // отдельными событиями очереди/сообщений.
      case 'event.routed': {
        refreshSessionFromApi(sid)
        break
      }

      // fs.changed: ядро опубликовало после успешного мутирующего тула.
      // Обновляем дерево Files (debounce) и реестр Git-вкладки. project_id
      // берём из payload, с fallback на проект сессии.
      case 'fs.changed': {
        const explicitProjectId = payload.project_id as string | null | undefined
        const projectId = explicitProjectId
          || useSessionsStore.getState().sessions.find((sess) => sess.id === sid)?.project_id
          || undefined
        if (!projectId) break
        const scope = payload.scope === 'file' ? 'file' : 'all'
        const paths = Array.isArray(payload.paths) ? (payload.paths as string[]) : undefined
        const workspaceChanged = Boolean(payload.workspace_changed)
        const op = payload.op === 'write' || payload.op === 'delete' || payload.op === 'mkdir' || payload.op === 'move'
          ? payload.op
          : undefined
        const from = typeof payload.from === 'string' ? payload.from : undefined
        const to = typeof payload.to === 'string' ? payload.to : undefined
        // `op:'move'` (execute_shell `mv`/`git mv`): синхронно, до debounce,
        // перемапливаем ключи поддерева (включая черновики) и открытые вкладки —
        // иначе активный редактор успеет перечитать диск по старому/новому пути
        // и потерять несохранённые правки. Порядок: дерево → вкладки → refresh.
        if (op === 'move' && from && to) {
          useFilesStore.getState().remapPath(projectId, from, projectId, to)
          useUIStore.getState().remapFileTabs(projectId, from, projectId, to)
        }
        useFilesStore.getState().scheduleRefresh(projectId, { scope, paths, workspaceChanged, op })
        scheduleGitRefresh(projectId)
        // ADR-114: изменение структуры каталогов (worktree'и) — тот же проект.
        useWorktreesStore.getState().applyEvent('fs.changed', { ...payload, project_id: projectId })
        break
      }

      // Проект изменён тулами (project_update/workspace_set/repo_*): перечитываем
      // список проектов с сервера и синхронизируем Git-вкладку (ADR-076) и дерево
      // Files (ADR-075: смена workspace меняет содержимое).
      case 'project.updated': {
        const projectId = payload.project_id as string | undefined
        if (projectId) void useFilesStore.getState().refreshProject(projectId)
        useProjectsStore.getState().loadProjects().then(() => {
          if (!projectId) return
          const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
          if (project) void useGitStore.getState().loadRepos(projectId, project.repos ?? null)
        }).catch(() => {})
        break
      }

      // Проект удалён (`DELETE /projects/:id`): событие приходит в канал каждой
      // его сессии до удаления. Локально убираем проект, его сессии, чат-вкладки
      // и состояние лент (API не вызываем — сервер уже удалил).
      case 'project.deleted': {
        const projectId = payload.project_id as string | undefined
        if (!projectId) break
        useProjectsStore.setState((s) => ({
          projects: s.projects.filter((p) => p.id !== projectId),
        }))
        const sessionIds = useSessionsStore.getState().sessions
          .filter((sess) => sess.project_id === projectId)
          .map((sess) => sess.id)
        for (const sessionId of sessionIds) {
          useUIStore.getState().closeTab(`chat-${sessionId}`)
          useChatStore.getState().clearSession(sessionId)
        }
        useSessionsStore.setState((s) => ({
          sessions: s.sessions.filter((sess) => sess.project_id !== projectId),
        }))
        break
      }

      // Todo обновлён (todo_write/todo_add/todo_update/todo_delete): мгновенный
      // patch из payload + полный refresh.
      case 'todos.updated': {
        const patch = payload as Record<string, unknown>
        const sessionPatch: Record<string, unknown> = {}
        if (patch.todos !== undefined) sessionPatch.todos = patch.todos
        if (patch.mode !== undefined) sessionPatch.mode = patch.mode
        if (Object.keys(sessionPatch).length > 0) {
          useSessionsStore.setState((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sid ? { ...sess, ...sessionPatch } : sess,
            ),
          }))
        }
        refreshSessionFromApi(sid)
        break
      }

      case 'session.created':
      case 'session.fork.created': {
        const session = { ...(payload as unknown as SessionData) }
        if (session.id && !session.origin) {
          // Гибрид: события удалённого backend приходят через RemoteEventBridge с
          // переписанным id (remote:<...>), но без поля origin — восстанавливаем его,
          // чтобы бейдж/фильтры дерева не теряли мир сессии.
          session.origin = session.id.startsWith('remote:') ? 'remote' : 'local'
        }
        if (session.id) {
          useSessionsStore.setState((s) => ({
            sessions: [session, ...s.sessions],
            total: s.total + 1,
          }))
        }
        break
      }

      case 'session.deleted': {
        const deletedId = (payload.session_id as string) || sid
        useSessionsStore.setState((s) => ({
          sessions: s.sessions.filter((sess) => sess.id !== deletedId),
          total: Math.max(0, s.total - 1),
        }))
        useUIStore.getState().closeTab(`chat-${deletedId}`)
        break
      }

      case 'tool_call.started':
      case 'tool_call_started': {
        const callId = (payload.call_id as string) || ''
        if (!callId) break
        const messageId = liveToolMessageId()
        if (!messageId) break
        // Вызов относится к шагу, даже если шаг уже закрыт: ядро публикует
        // `step.finished` **до** запуска тулов, а результат приходит позже
        // (`tool_call.result`). Поэтому финальный статус сообщения не мешает
        // — карточка тула вешается в сообщение шага (ADR-118 §1).
        if (!ensureLiveMessage(messageId, undefined, { allowTerminal: true })) break
        // ADR-118 §1: вызов инструмента — часть сообщения с id = `callId`.
        upsertPart(sid, messageId, callId, {
          id: callId,
          type: 'tool_use',
          text: '',
          data: {
            name: payload.name as string,
            args: (payload.arguments as Record<string, unknown>) || {},
            status: 'running',
            startedAt: new Date().toISOString(),
            iteration: (payload.iteration as number) || 0,
            parentCallId: (payload.parent_call_id as string) || undefined,
          },
        })
        // ADR-118 §5: вызов инструмента — тоже контент хода. Шаг «только вызовы
        // инструментов» иначе не поднял бы флаг — строка активности хода и
        // индикатор в живом сегменте не включились бы.
        markTurnContentStarted(sid)
        break
      }

      case 'tool_call.result':
      case 'tool_call_result': {
        const callId = (payload.call_id as string) || ''
        if (!callId) break
        // Тул завершён (в т.ч. isError) — статус ожидания ретрая этого саб-агента
        // снят. Делаем это до адресации по живому сообщению: часть могла быть
        // снята (detach/новая попытка), а плашка ретрая обязана уйти.
        const taskRetry = useChatStore.getState().subagentRetryBySession[sid]
        if (taskRetry && taskRetry.callId && taskRetry.callId === callId) {
          setSubagentRetry(sid, null)
        }
        const messageId = liveToolMessageId()
        if (!messageId) break
        const result = payload.result as Record<string, unknown> | undefined
        patchPartData(sid, messageId, callId, {
          status: 'done',
          completedAt: new Date().toISOString(),
          result: {
            content: (result?.content as string) || '',
            isError: result?.isError as boolean | undefined,
            metadata: result?.metadata as Record<string, unknown> | undefined,
          },
        })
        // Контент хода начался (как и для вызова тула) — «только вызовы
        // инструментов» тоже считаются содержимым хода.
        markTurnContentStarted(sid)
        break
      }

      case 'subagent.progress':
      case 'subagent_progress': {
        // Стриминг размышлений/промежуточного текста саб-агента родителю —
        // вкладываются в блок `task` (по parent_call_id, т.е. call_id задачи).
        // Ядро присылает **дельты** (`content_delta`/`reasoning_delta`), которые
        // накапливаются в live-блоке.
        const parentCallId = (payload.parent_call_id as string) || ''
        if (!parentCallId) break
        // ADR-070 §2.6: live-вклад саб-агента (для строки статистики в блоке
        // `task` и секции StatsTab) — учитывается независимо от того, есть ли
        // уже живое сообщение хода (usage-кадр может прийти первым).
        updateLiveSubagentUsage(sid, parentCallId, {
          usage: mapUsage(payload.usage) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          costUsd: payload.cost_usd as number | undefined,
          costCurrency: payload.cost_currency as string | undefined,
          estimated: payload.estimated as boolean | undefined,
          model: payload.model as string | undefined,
          provider: payload.provider as string | undefined,
        })
        const messageId = liveToolMessageId()
        if (!messageId) break
        const parts = useChatStore.getState().partsBySession[sid]?.[messageId] || {}
        const livePart = parts[parentCallId]
        const liveData = (livePart?.data ?? {}) as Record<string, unknown>
        const reasoningBlocks = (liveData.subagentReasoningBlocks as ReasoningBlockData[]) || []
        const textBlocks = (liveData.subagentIntermediateTextBlocks as IntermediateTextBlockData[]) || []
        const lastReasoning = reasoningBlocks.at(-1)?.text ?? ''
        const lastContent = textBlocks.at(-1)?.text ?? ''
        const iteration = (payload.iteration as number) || 0
        patchPartData(sid, messageId, parentCallId, {
          subagentReasoningBlocks: appendDeltaBlock(
            reasoningBlocks,
            progressDelta(payload, 'reasoning_delta', 'reasoning', lastReasoning),
            iteration,
          ),
          subagentIntermediateTextBlocks: appendDeltaBlock(
            textBlocks,
            progressDelta(payload, 'content_delta', 'content', lastContent),
            iteration,
          ),
        })
        break
      }
      case 'subagent.context_budget': {
        // Предохранитель бюджета контекста сработал: прогон завершён отчётом
        // (работа частично сделана) — предупреждаем пользователя.
        notifyMessage({
          text: i18nText('subagent.context_budget', {
            tokens: String(payload.tokens ?? '?'),
            steps: String(payload.steps ?? 0),
          }),
          type: 'warning',
          category: 'system',
        })
        break
      }

      case 'subagent.retry':
      case 'subagent_retry': {
        // Повторная попытка провайдера внутри саб-агента: показываем в блоке
        // саб-агента «Повторная попытка N/M через Xс». Привязка к блоку — по
        // parent_call_id (call_id тула task в родителе); в дочерней сессии при
        // resume parent_call_id отсутствует — состояние на уровне сессии.
        setSubagentRetry(sid, {
          callId: (payload.parent_call_id as string) || undefined,
          childSessionId: (payload.child_session_id as string) || undefined,
          attempt: (payload.attempt as number) || 1,
          maxRetries: (payload.max_retries as number) || 3,
          retryInMs: (payload.retry_in as number) || 5000,
          errorType: payload.error_type as string | undefined,
          error: payload.error as string | undefined,
        })
        break
      }

      case 'subagent.resume.started': {
        // Возобновление дочерней сессии пошло: событие публикуется в обе сессии
        // (родительскую и дочернюю). Состояние выставляем по обоим id — страховка
        // на случай отсутствия подписки на одну из них.
        const state = {
          childSessionId: (payload.child_session_id as string) || sid,
          parentSessionId: (payload.parent_session_id as string) || sid,
          streamId: (payload.stream_id as string) || '',
        }
        setSubagentResuming(sid, state)
        if (state.childSessionId && state.childSessionId !== sid) {
          setSubagentResuming(state.childSessionId, state)
        }
        break
      }

      case 'subagent.resume.finished': {
        // Возобновление завершено: снимаем состояние плашки, статус ретрая и
        // обновляем родительскую сессию (итоговое INFO-сообщение приходит
        // отдельным message.added — refresh гарантирует консистентность стора).
        const childId = payload.child_session_id as string | undefined
        const parentId = payload.parent_session_id as string | undefined
        setSubagentResuming(sid, null)
        setSubagentRetry(sid, null)
        if (childId && childId !== sid) {
          setSubagentResuming(childId, null)
          setSubagentRetry(childId, null)
        }
        if (parentId) refreshSessionFromApi(parentId)
        if (sid !== parentId) refreshSessionFromApi(sid)
        break
      }

      case 'context.summarization_pending': {
        setSummarizationPending(sid, true)
        break
      }

      // Ядро применило сжатие истории (обычный путь и overflow,
      // `_forceCompressForOverflow`): плашка снимается, лента перечитывается
      // последней страницей. Именно страница (`applyHistoryPage`, не
      // `setMessages`) — догруженные пользователем старые страницы не теряются.
      case 'context.summarization_applied': {
        setSummarizationPending(sid, false)
        // ADR-119: занятость контекста из события — значение «прямо сейчас»
        // после сжатия. Кладём его ДО перечитывания истории: индикатор
        // уменьшается сразу, даже если история не перечиталась.
        const contextTokens = payload.context_tokens
        const contextLimit = payload.context_limit
        if (typeof contextTokens === 'number' && typeof contextLimit === 'number') {
          useChatStore.getState().setContextUsage(sid, {
            tokens: contextTokens,
            limit: contextLimit,
            estimated: false,
          })
        }
        // Перечитывание истории не глотаем молча: `mergeHistory` —
        // single-flight с trailing-прогоном; при неудаче — один повтор.
        // Значение из события остаётся фолбэком для индикатора.
        void mergeHistory(sid).then((ok) => (ok ? undefined : mergeHistory(sid)))
        refreshSessionFromApi(sid)
        break
      }

      case 'context.sliding_window_applied': {
        const indices = payload.disabled_indices as number[] | undefined
        if (indices && Array.isArray(indices) && indices.length > 0) {
          // ADR-118 §7: мутации адресуются по `id` сообщения; серверный
          // позиционный индекс — только способ найти сообщение в сторе.
          const chat = useChatStore.getState()
          for (const idx of indices) {
            const id = messageIdByIndex(sid, idx)
            if (id) chat.updateMessageById(sid, id, { disabled: true })
          }
        } else {
          synthApi.getSessionMessages(sid, { limit: MESSAGES_PAGE_LIMIT }).then((r) => {
            // Снимок — страница истории: мерж с живым состоянием (не `setMessages`),
            // иначе догруженные старые страницы ленты терялись бы.
            applyHistoryPage(sid, r)
          }).catch(() => {})
        }
        break
      }

      case 'message.quality_check': {
        const msgIndex = payload.message_index as number | undefined
        if (msgIndex != null) {
          // ADR-118 §7: правка — по `id` сообщения (индекс сервера — только
          // способ найти его в сторе).
          const id = messageIdByIndex(sid, msgIndex)
          if (id) {
            useChatStore.getState().updateMessageById(sid, id, {
              qa_pass: payload.qa_pass as boolean | undefined,
              qa_reason: payload.qa_reason as string | undefined,
            })
          }
        }
        break
      }

      // ADR-046 §8.2: вызовы скиллов/команд — счётчики и последний вызов (часть b).
      case 'skill.invoked': {
        useSkillsStore.getState().recordSkillInvoked({
          sessionId: sid,
          name: String(payload.name ?? ''),
          source: payload.source === 'model' ? 'model' : 'user',
          scope: typeof payload.scope === 'string' ? payload.scope : undefined,
          agent: typeof payload.agent === 'string' ? payload.agent : undefined,
          timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
        })
        break
      }

      case 'command.invoked': {
        useSkillsStore.getState().recordCommandInvoked({
          sessionId: sid,
          command: String(payload.command ?? ''),
          args: typeof payload.args === 'string' ? payload.args : undefined,
          actor: payload.actor === 'cli' ? 'cli' : 'user',
          timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
        })
        break
      }
    }
    } catch (e) {
      console.error('[TransportStore] Dispatcher error:', e, event)
    }
  }
}

let transport: TransportClient | null = null
let transportReady = false
// Эффективный транспорт текущего клиента: 'ws' | 'sse' пока идёт подключение
// или соединение живо; null — клиент сброшен (disconnect/разрыв). Вместе с
// transport.getTransport() даёт идемпотентность connect() к тому же транспорту.
let activeKind: 'ws' | 'sse' | null = null
/**
 * Синхронный резерв режима на время асинхронного старта (ADR-118 §8).
 *
 * `connect()` сначала спрашивает `GET /api/v2/meta` и только потом зовёт
 * `client.connect()`, поэтому до этого момента `client.getTransport()` ещё
 * `disconnected` и guard идемпотентности его не видел. Двойной вызов в этом
 * окне (dev: StrictMode / профиль-настройка транспорта приходит после первого
 * маунта) создавал **второй** клиент, а первый оставался жить и доставлял те же
 * события второй раз (чанки применялись дважды). Резерв закрывает окно: пока
 * `connectingKind === actualMode`, повторный connect к тому же транспорту
 * пропускается.
 */
let connectingKind: 'ws' | 'sse' | null = null
/**
 * Было ли соединение в этой загрузке страницы. Первое подключение — обычный
 * старт; все следующие (после обрыва/возврата из фона/`restart`) — реконнект,
 * после которого нужен ресинк ленты и списка сессий.
 */
let everConnected = false
/** Ресинк уже запущен в текущем эпизоде соединения (WS: `onConnect` + `onBackendReady`). */
let resyncDoneThisEpisode = false

/** Сброс модульного состояния ресинка (тесты; между наборами держится модулем). */
export function __resetTransportResyncForTests(): void {
  everConnected = false
  resyncDoneThisEpisode = false
}

/** Перевести фазу связи, не сбрасывая `phaseSince`, если фаза не изменилась. */
function setPhaseIfChanged(next: ConnectionPhase): void {
  const state = useTransportStore.getState()
  if (state.phase === next) return
  useTransportStore.setState({ phase: next, phaseSince: Date.now() })
}

/** Успешное подключение: `online` и признак «связь уже была». */
function markOnline(): void {
  const state = useTransportStore.getState()
  const patch: Partial<TransportState> = { hasEverConnected: true }
  if (state.phase !== 'online') {
    patch.phase = 'online'
    patch.phaseSince = Date.now()
  }
  useTransportStore.setState(patch)
}

/** Зафиксировать успешное подключение: первый раз — запомнить, дальше — ресинк. */
function noteConnected(): void {
  if (!everConnected) {
    everConnected = true
    resyncDoneThisEpisode = true
    return
  }
  if (resyncDoneThisEpisode) return
  resyncDoneThisEpisode = true
  void resyncAfterReconnect().catch(() => {})
}

export function isTransportConnected(): boolean {
  return transportReady
}

// Очистка при HMR (hot module replacement)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    transport?.disconnect();
    transport = null;
    transportReady = false;
    activeKind = null;
    connectingKind = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', onBrowserOffline);
      window.removeEventListener('online', onBrowserOnline);
    }
  });
}

export const useTransportStore = create<TransportState>()((set, get) => ({
  transportMode: 'auto',
  activeTransport: 'disconnected',
  connected: false,
  phase: 'connecting',
  phaseSince: Date.now(),
  hasEverConnected: false,
  versionMismatch: false,
  openSessions: new Set(),

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => {
    const actualMode = override || (mode === 'sse' ? 'sse' as const : 'ws' as const)

    // Идемпотентность: к тому же эффективному транспорту уже подключаемся или
    // подключены. Раньше это пересоздавало клиент и закрывало CONNECTING-сокет
    // (auto→ws + сохранённый prefs ws = один и тот же транспорт — см. ADR-024).
    // `connectingKind` закрывает окно асинхронного старта (проверка `/meta`):
    // клиент уже создан и зарезервирован, но `getTransport()` ещё `disconnected`.
    if (
      transport
      && activeKind === actualMode
      && (connectingKind === actualMode || transport.getTransport() === actualMode)
    ) {
      console.debug('[TransportStore] connect skipped (already', actualMode, ')')
      return
    }

    transport?.disconnect()
    transport = null
    transportReady = false
    activeKind = null
    connectingKind = null
    resyncDoneThisEpisode = false

    // Первое подключение — `connecting`, любое следующее — `reconnecting`
    // (связь уже была, значит это восстановление, а не старт приложения).
    const startPhase: ConnectionPhase = get().hasEverConnected ? 'reconnecting' : 'connecting'
    // `connecting` — всегда новый эпизод старта (в т.ч. поздний логин после
    // долгого простоя на экране входа): отметку времени обновляем, иначе
    // баннер «нет связи» вспыхнул бы сразу из-за старого phaseSince.
    if (get().phase !== startPhase || startPhase === 'connecting') {
      set({ phase: startPhase, phaseSince: Date.now() })
    }

    console.debug('[TransportStore] Connecting:', actualMode, '(mode=', mode, ')')
    const dispatcher = createDispatcher()

    const client = new TransportClient({
      // События покинутого клиента (обрыв/пересоздание/асинхронный старт в
      // пользу нового) не применяем: иначе одно событие доезжает дважды —
      // дельты складываются в задвоенный текст.
      onEvent: (event) => {
        if (transport !== client) return
        dispatcher(event)
      },
      onConnect: () => {
        if (transport !== client) return
        activeKind = actualMode
        if (actualMode === 'sse') {
          transportReady = true
          set({ connected: true, activeTransport: 'sse' })
          console.debug('[TransportStore] Connected (SSE):', client.getTransport())
          // SSE готов уже на `onopen`; WS ждёт кадр `connected` от backend.
          markOnline()
        } else {
          // WS: сокет открыт, но backend ещё не зарегистрировал клиента —
          // `online` только по `onBackendReady` (ниже).
          set({ connected: true })
          console.debug('[TransportStore] WS socket open, waiting for backend ready...')
        }
        noteConnected()
      },
      onBackendReady: () => {
        if (transport !== client) return
        activeKind = actualMode
        transportReady = true
        set({ connected: true, activeTransport: 'ws' })
        console.debug('[TransportStore] Backend ready:', client.getTransport())
        markOnline()
        noteConnected()
      },
      onDisconnect: (reason) => {
        if (transport !== client) return
        // Обрыв/ручное закрытие: клиент больше не считается «активным» —
        // иначе форс-реконнект (ConnectionStatus) и auto-fallback WS→SSE
        // блокировались бы guard'ом идемпотентности.
        activeKind = null
        connectingKind = null
        transportReady = false
        // Следующее успешное подключение — новый эпизод: ресинк нужен снова.
        resyncDoneThisEpisode = false
        set({ connected: false })
        console.debug('[TransportStore] Disconnected:', reason)

        if (reason === 'manual') {
          // Выход из аккаунта: это не «потеря связи», а штатная остановка.
          setPhaseIfChanged('connecting')
          return
        }
        if (reason !== 'restart') {
          // network | heartbeat | auth и прочие обрывы — восстанавливаемся.
          setPhaseIfChanged('reconnecting')
        }

        const failed = transport
        const failedKind = failed?.getTransport()

        // Одноразовый fallback WS→SSE в режиме auto. Для SSE (и когда транспорта
        // нет) НЕ пересоздаём клиент — TransportClient сам переподключается через
        // scheduleReconnect() с экспоненциальным backoff.
        if (get().transportMode === 'auto' && failedKind === 'ws' && failed) {
          console.debug('[TransportStore] Auto-fallback: switching to SSE')
          transport = null
          failed.disconnect()
          get().connect('auto', 'sse')
        }
      },
    })

    activeKind = actualMode
    connectingKind = actualMode
    transport = client
    // ADR-118 §8: **fail-closed** сверка версий модели сообщений. Сначала
    // возможности инстанса (`GET /api/v2/meta`); при несовпадении — отказ
    // подключения с понятным сообщением (тихая деградация запрещена).
    const startTransport = (since: number | undefined) => {
      connectingKind = null
      // Без точки догона второй аргумент не передаём (чистый контракт connect).
      if (since === undefined) client.connect(actualMode)
      else client.connect(actualMode, { since })
    }
    void Promise.resolve()
      .then(() => synthApi.getInstanceCapabilities())
      .then((caps) => {
        // Пока шла проверка, клиент мог быть заменён/сброшен — стартовать
        // покинутый клиент нельзя (иначе он жил бы параллельно с новым).
        if (transport !== client) return
        if (!supportsMessageModel(caps)) {
          connectingKind = null
          activeKind = null
          transportReady = false
          set({ connected: false, activeTransport: 'disconnected', versionMismatch: true })
          notifyMessage({
            text: i18nText('chat.error.messageModelMismatch', {
              client: String(MESSAGE_MODEL_VERSION),
              server: String(caps?.messageModel ?? '?'),
            }),
            type: 'error',
            category: 'error',
          })
          client.disconnect()
          return
        }
        set({ versionMismatch: false })
        startTransport(maxEventSeq())
      })
      .catch(() => {
        if (transport !== client) return
        // Мета недоступна — подключаемся: гейт `messageModel=2` на сервере
        // всё равно откажет несовместимый клиент.
        set({ versionMismatch: false })
        startTransport(maxEventSeq())
      })
  },

  disconnect: () => {
    transport?.disconnect('manual')
    transport = null
    transportReady = false
    activeKind = null
    connectingKind = null
    set({ connected: false, activeTransport: 'disconnected' })
    setPhaseIfChanged('connecting')
  },

  restart: () => {
    // Текущий эффективный транспорт: в режиме `auto` это фактический ws/sse
    // (после fallback — sse), а не «auto» — перезапускаем ровно его.
    const kind = activeKind
    console.debug('[TransportStore] Restart transport:', kind)
    transport?.disconnect('restart')
    transport = null
    transportReady = false
    activeKind = null
    connectingKind = null
    resyncDoneThisEpisode = false
    set({ connected: false, activeTransport: 'disconnected' })
    // `restart` сам по себе не «потеря»: фазу выставит `connect()` —
    // `reconnecting`, если связь уже была (phaseSince сохранится, если фаза та же).
    get().connect(get().transportMode, kind ?? undefined)
  },

  setTransportMode: (mode: TransportMode) => {
    const state = get()

    console.debug('[TransportStore] Switching mode:', state.transportMode, '→', mode)
    set({ transportMode: mode })
    get().connect(mode)
  },

  sendMessage: async (sessionId, text, agentRole, provider, model, mode, attachmentIds) => {
    // ADR-118 §3: приём — только HTTP (`POST /sessions/:id/prompt` → `202`).
    // WS-кадр `send_message` и ожидание ack со «Send timeout» удалены:
    // подтверждение приходит адресным событием `message.accepted`.
    const messageId = nextStreamId()
    const isQueueMode = !mode || mode === 'queue'
    // Состояние хода читаем **до** любых вставок в ленту: от него зависит,
    // показывать реплику сразу или только строкой очереди.
    const activeTurn = isTurnActive(sessionId)
    const queued = isQueueMode && activeTurn

    // Реальная ошибка (сеть/401/валидация) бросается — сообщение не показано.
    const accepted = await synthApi.enqueueMessage(sessionId, text, {
      agentRole,
      model,
      provider,
      mode,
      streamId: messageId,
      attachments: attachmentIds,
    })

    // Строка очереди: показывается сразу (своя реплика — не утечка чужих
    // сообщений); `message.accepted` подтвердит её по тому же id.
    const chat = useChatStore.getState()
    if (queued) {
      // Ход идёт: реплика уходит **в очередь**, а не в ленту. Оптимистичная
      // вставка в ленту давала дубль (лента + «в очереди») и разрывала текущий
      // ответ (реплика вставала между сегментами хода, хотя агент ответит на
      // неё только следующим ходом). В ленте она появится по `message.delivered`
      // — обработчик догружает историю и дедупит по `id`/`ord`.
      chat.upsertPendingMessage(sessionId, {
        id: accepted.messageId,
        content: text,
        agentRole: agentRole ?? null,
      })
      return accepted
    }

    // Ход не идёт — реплика показывается оптимистично сразу по `messageId`
    // из ответа; `message.delivered` затем «примирит» её (ord/роль/автор).
    // Режимы `steer`/`interrupt` (ADR-104) — бейдж «Вмешательство в ход»
    // виден сразу, не дожидаясь `message.delivered`.
    const steerMeta = mode === 'steer'
      ? { steer: true }
      : mode === 'interrupt'
        ? { steer: true, interrupt: true }
        : null
    const msgs = chat.messagesBySession[sessionId] || []
    const nextIndex = msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 1 : 0
    chat.upsertMessage(sessionId, {
      index: nextIndex,
      id: accepted.messageId,
      role: 'user',
      content: text,
      ord: null,
      turn_id: null,
      status: 'completed',
      agent_role: agentRole ?? null,
      provider: provider ?? null,
      model: model ?? null,
      disabled: false,
      pinned: false,
      hidden: false,
      ...(steerMeta ? { metadata: steerMeta } : {}),
      created_at: new Date().toISOString(),
    })
    return accepted
  },

  cancel: (sessionId) => {
    // Запрос подтверждения больше не актуален: «Стоп» снимает ожидание на
    // бэкенде (ask отменяется вместе с ходом), полоса должна исчезнуть сразу.
    usePermissionStore.getState().clearSession(sessionId)
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] cancel via WS:', sessionId)
      transport.cancel(sessionId)
    } else {
      console.debug('[TransportStore] cancel via HTTP POST:', sessionId)
      synthApi.stopGeneration(sessionId).catch(() => {})
    }
  },

  sendPermissionReply: async (sessionId, approvalId, approved, once) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendPermissionReply via WS:', sessionId, approvalId, approved, once)
      transport.sendPermissionReply(sessionId, approvalId, approved, once)
      return true
    }
    // WS нет (SSE/фоллбек после разрыва): отвечаем HTTP-путём — иначе запрос
    // висел бы до ask-таймаута (инцидент на test: «Запретить» терялся).
    try {
      console.debug('[TransportStore] sendPermissionReply via HTTP POST:', sessionId, approvalId, approved)
      await sessionsApi.permissionReply(sessionId, approvalId, {
        action: approved ? 'allow' : 'deny',
        ...(once !== undefined ? { once } : {}),
      })
      return true
    } catch (err) {
      // 403 `already_consumed` — запрос уже отвечен (гонка с полосой/WS):
      // для UI это успех, полосу можно убрать.
      if (isAlreadyConsumed(err)) return true
      console.warn('[TransportStore] sendPermissionReply failed:', sessionId, approvalId, err)
      return false
    }
  },

  sendPermissionHold: async (sessionId, approvalId) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendPermissionHold via WS:', sessionId, approvalId)
      transport.sendPermissionHold(sessionId, approvalId)
      return true
    }
    try {
      console.debug('[TransportStore] sendPermissionHold via HTTP POST:', sessionId, approvalId)
      await sessionsApi.permissionReply(sessionId, approvalId, { action: 'hold' })
      return true
    } catch (err) {
      if (isAlreadyConsumed(err)) return true
      console.warn('[TransportStore] sendPermissionHold failed:', sessionId, approvalId, err)
      return false
    }
  },

  markSessionOpen: (sid) => {
    const next = new Set(get().openSessions)
    next.add(sid)
    set({ openSessions: next })
    // ADR-118 §5: сессия открыта — если история уже в сторе, восстанавливаем
    // границы идущего хода (`status: 'streaming'`), иначе он отрисуется как
    // обычное сообщение и «Стоп»/«В фон» не увидят активной работы.
    const loaded = useChatStore.getState().messagesBySession[sid]
    if (loaded) restoreLiveTurnFromHistory(sid, loaded)
  },

  markSessionClosed: (sid) => {
    const next = new Set(get().openSessions)
    next.delete(sid)
    set({ openSessions: next })
  },
}))

/**
 * Фаза связи по событиям сети браузера: `offline` при уже потерянной связи —
 * `offline` (сервер точно недоступен), `online` — `reconnecting` и немедленная
 * попытка (её делает `TransportClient.resume()` на том же событии; здесь только
 * фаза, чтобы UI не ждал следующего backoff-тика).
 */
function onBrowserOffline(): void {
  const state = useTransportStore.getState()
  if (state.phase === 'online') setPhaseIfChanged('reconnecting')
  else if (state.phase !== 'offline') setPhaseIfChanged('offline')
}

function onBrowserOnline(): void {
  if (useTransportStore.getState().phase === 'online') return
  setPhaseIfChanged('reconnecting')
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', onBrowserOffline)
  window.addEventListener('online', onBrowserOnline)
}

/** Снять сетевые слушатели (HMR/тесты): без этого при перезагрузке модуля они дублируются. */
export function __detachConnectionPhaseListenersForTests(): void {
  if (typeof window === 'undefined') return
  window.removeEventListener('offline', onBrowserOffline)
  window.removeEventListener('online', onBrowserOnline)
}
