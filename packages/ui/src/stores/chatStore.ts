import { create } from 'zustand'
import { type ReasoningBlock } from '@itphx/synth-shared/utils'
import type { MessageStatus, Part, PartMetadata, PartType } from '@itphx/synth-shared/types'
import type { StickyNoteData } from '@/lib/api/synthApi'
import { costCurrencyKey } from '@/lib/currency'

/**
 * ADR-118 §5: статус сообщения-хода (`streaming` → терминальный) — контракт
 * из shared. Реэкспорт: UI-слои импортируют тип из стора (единая точка).
 */
export type { MessageStatus }

export type DebugData = Record<string, unknown>

/**
 * Блок рассуждений в ленте. Тип и хелпер накопления живут в shared: провайдер
 * шлёт reasoning кумулятивно, и ядро (финальные `reasoning_blocks`) и UI должны
 * склеивать его одинаково. Алиас сохранён ради существующих импортов.
 */
export type ReasoningBlockData = ReasoningBlock

export interface IntermediateTextBlockData {
  text: string
  iteration: number
}

/**
 * ADR-070 §2.6: статус **ответа** ассистента (`metadata.status`), определяет
 * префикс статистики. Не путать со статусом сообщения-хода
 * (`MessageStatus` из `@itphx/synth-shared/types` — ADR-118 §5).
 */
export type ResponseStatus = 'completed' | 'cancelled' | 'stopped' | 'error' | 'limit' | 'interrupted'

export interface MessageData {
  /** Позиционный индекс в истории (серверный, ADR-118: не идентичность). */
  index: number
  /** ADR-118 §7: устойчивый идентификатор сообщения — адресация мутаций. */
  id?: string
  seq?: number
  /**
   * ADR-118 §2: монотонный порядок записи в истории сессии. Не перенумеровывается
   * при вставке в середину; `null` — сообщение ещё не материализовано в истории.
   */
  ord?: number | null
  /** ADR-118 §1: идентификатор хода (`Turn`), которому принадлежит сообщение. */
  turn_id?: string | null
  /** ADR-118 §1: индекс шага внутри хода (0-based). */
  step_index?: number | null
  /** ADR-118 §5: статус сообщения-хода (`streaming` → терминальный). */
  status?: MessageStatus | null
  origin?: string
  source_msg_id?: string | null
  /** ADR-115: части сообщения; медиа — `image`/`audio`/`video`/`file` с `MediaPartData`. */
  parts?: Part[] | null
  role: string
  content: string
  tool_calls?: Array<{
    /**
     * Имя тула. У **сырого** вызова провайдера
     * (`{type:'function', function:{name, arguments}}`) его нет — такая запись
     * карточкой не рисуется (карточка вызова приходит в финальном сообщении
     * хода, с результатом).
     */
    name?: string
    args?: Record<string, unknown>
    id?: string
    /** Сырой вызов провайдера (`{type:'function', function:{…}}`). */
    type?: string
    index?: number
    function?: { name?: string; arguments?: string }
    result?: { content: string; isError?: boolean; metadata?: Record<string, unknown> }
    started_at?: string
    completed_at?: string
    iteration?: number
  }> | null
  tool_call_id?: string | null
  disabled: boolean
  pinned: boolean
  hidden: boolean
  debug_data?: Record<string, unknown> | null
  model?: string | null
  provider?: string | null
  provider_type?: string | null
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number } | null
  reasoning?: string | null
  reasoning_blocks?: ReasoningBlockData[] | null
  intermediate_text_blocks?: IntermediateTextBlockData[] | null
  source?: string | null
  author?: string | null
  agent_role?: string | null
  summary_of?: number[] | null
  metadata?: Record<string, unknown> | null
  created_at: string
  timestamp?: string
  qa_pass?: boolean
  qa_reason?: string
}

/**
 * ADR-118 §4: часть сообщения в **живом** состоянии.
 *
 * Ключ — `{messageId, partId}` (upsert, а не append — ADR-118
 * «Идемпотентность доставки»). Идентификаторы частей детерминированные
 * (ADR-118 §1): текст — `msg:text:<ordinal>`, вызов инструмента — `callId`.
 */
export interface LivePart {
  id: string
  type: PartType
  /** Накопленный текст части (text/reasoning). */
  text: string
  /** Накопленный «сырой» поток (например, JSON-аргументы вызова). */
  raw?: string
  /** Структурные данные части (`tool_use`: `{name,args,status,result}`}). */
  data?: unknown
  /** Служебные метаданные части (Anthropic thinking: подпись/redacted). */
  metadata?: PartMetadata
}

/**
 * ADR-118 §1: активный ход (`Turn`) сессии — границы группировки в ленте.
 *
 * `messageId` — сообщение текущего шага (единственный «живой» источник
 * контента: ADR-118 §5 — сообщение живёт от первой дельты до терминального
 * статуса). Агент/модель/провайдер — из `stream.start` (шаг их не несёт).
 */
export interface ActiveTurn {
  turnId: string
  streamId?: string
  messageId?: string
  stepIndex?: number
  status?: 'streaming' | 'completed' | 'cancelled' | 'error' | 'stopped'
  agentRole?: string | null
  model?: string
  provider?: string
  /**
   * Контент хода начался (ADR-118 §5): пришла первая часть ответа.
   *
   * Пока флаг не выставлен, индикатор «идёт» живёт **у реплики пользователя**
   * (плашка «обработка»/«повтор»); после первой части — в живом сегменте
   * ответа. Флаг не сбрасывается между шагами хода: контент хода уже был.
   */
  contentStarted?: boolean
  /**
   * Идёт вызов инструментов шага (`step.tools.started` → `step.tools.finished`).
   *
   * Между `step.finished` шага и результатом инструмента живого сегмента в
   * ленте нет — без флага строка активности хода писала бы «Выполняется…»
   * вместо «Выполняется инструмент…». Сбрасывается на финише инструментов и
   * на любом терминальном событии хода.
   */
  toolsRunning?: boolean
}

export interface LiveToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done'
  result?: { content: string; isError?: boolean; metadata?: Record<string, unknown> }
  startedAt: string
  completedAt?: string
  iteration: number
  parentCallId?: string
  /** Размышления саб-агента, стримящиеся внутри блока `task` (во время выполнения). */
  subagentReasoningBlocks?: ReasoningBlockData[]
  /** Промежуточный текст саб-агента, стримящийся внутри блока `task`. */
  subagentIntermediateTextBlocks?: IntermediateTextBlockData[]
}

/** ADR-070 §2.6: usage в snake_case (как в MessageData). */
export interface UsageData {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
}

/** ADR-070 §2.6: разбивка стоимости live-события (camelCase из ядра). */
export interface CostBreakdown {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

/** ADR-070 §2.6: live-вклад одного вызова саб-агента (по parent_call_id) в родителе. */
export interface LiveSubagentCallUsage {
  usage: UsageData
  costUsd?: number
  /** C2a: валюта `costUsd` (из stream/subagent payload). */
  costCurrency?: string
  estimated: boolean
  model?: string
  provider?: string
}

/** ADR-070 §2.6: live-вклад саб-агентов сессии (агрегат + разбивка по вызовам). */
export interface LiveSubagentSessionUsage {
  usage: UsageData
  /** Номинальная сумма вкладов (обратная совместимость); валюты не смешиваются — см. `costByCurrency`. */
  costUsd?: number
  /** C2a: валюта `costUsd` (из stream/subagent payload). */
  costCurrency?: string
  /** C2b: разбивка стоимости по валютам (код → сумма). */
  costByCurrency?: Record<string, number>
  estimated: boolean
  byCall: Record<string, LiveSubagentCallUsage>
}

/** Статус повторной попытки (событие stream.retry): «Повторная попытка N/MAX через X сек». */
export interface StreamRetry {
  streamId: string
  attempt: number
  maxRetries: number
  /** Задержка backoff в миллисекундах */
  retryInMs: number
  error?: string
}

/** Статус повторной попытки саб-агента (событие subagent.retry). */
export interface SubagentRetryState {
  /** call_id тула `task` в родительской сессии (parent_call_id); в дочерней сессии при resume отсутствует. */
  callId?: string
  childSessionId?: string
  attempt: number
  maxRetries: number
  /** Задержка backoff в миллисекундах */
  retryInMs: number
  errorType?: string
  error?: string
}

/** Активное возобновление дочерней сессии (событие subagent.resume.started). */
export interface SubagentResumeState {
  childSessionId: string
  parentSessionId: string
  streamId: string
}

/** Финальная ошибка стрима (событие stream.error с can_retry: false) — плашка над полем ввода. */
export interface FinalStreamError {
  streamId: string
  error: string
  errorType: string
}

export interface QueueState {
  pendingCount: number
  /** ADR-118 §4: сообщений-вмешательств (`steer`/`interrupt`), ждущих применения. */
  steerCount: number
  isStalled: boolean
}

/** Статус элемента очереди из `queue.state` (ADR-118 §4). */
export type QueueItemStatus = 'queued' | 'starting'

export interface QueuedMessage {
  /** Серверный id pending-сообщения (`pending_messages[].id`) — адресация по id. */
  id?: string
  content: string
  agentRole?: string | null
  /** ADR-115: число вложений сообщения (для строки очереди); нет данных — 0. */
  attachmentCount?: number
  /** Статус в очереди (`queue.state.items`): `queued` — ждёт, `starting` — уже запускается. */
  status?: QueueItemStatus
  /**
   * Оптимистичная строка: сообщение отправлено, серверное подтверждение
   * (`message.accepted`) ещё не пришло. Строка показывается сразу при отправке
   * и «подтверждается» тем же id.
   */
  sending?: boolean
}

/**
 * Ключи порядка сообщения (ADR-118 §2).
 *
 * - `ord` — монотонный порядок записи в истории (единственный «настоящий»
 *   ключ порядка);
 * - `id` — устойчивая идентичность (ADR-118 §7), тай-брейк;
 * - `created_at` — время материализации (ISO) — фолбэк, когда `ord` есть
 *   только у одного из сообщений;
 * - `index` — позиция в серверном массиве: **не** ключ порядка (смешивать с
 *   `ord` нельзя — это разные шкалы).
 */
export type MessageOrderKey = Pick<MessageData, 'ord' | 'id' | 'index' | 'status'> & {
  created_at?: string
}

/**
 * Позиционный индекс для тай-брейка: `index` может отсутствовать (legacy
 * сообщения без индекса) — тогда `NaN` в компараторе сортировки ломает
 * порядок, поэтому отсутствующий индекс считаем нулём.
 */
function tieBreakIndex(m: MessageOrderKey): number {
  return typeof m.index === 'number' && Number.isFinite(m.index) ? m.index : 0
}

/** Тай-брейк по `id` (ADR-118 §7) — при полном равенстве ключей порядок по `index`. */
function tieBreakById(a: MessageOrderKey, b: MessageOrderKey): number {
  const aid = a.id ?? ''
  const bid = b.id ?? ''
  if (aid !== bid) return aid < bid ? -1 : 1
  return tieBreakIndex(a) - tieBreakIndex(b)
}

/**
 * «Живое» сообщение — источник времени **клиентский** (`new Date()` в
 * `ensureLiveMessage`), серверного времени у него нет:
 *
 * - статус `streaming` — идёт ход (ADR-118 §5);
 * - `ord` нет и `created_at` нет — ещё не материализовано в истории.
 *
 * Клиентское и серверное время смешивать нельзя (часы клиента и инстанса
 * разъезжаются) — поэтому живое сообщение всегда **последнее**.
 */
function isLiveOrderKey(m: MessageOrderKey, ord: number | null, createdAt: string): boolean {
  if (m.status === 'streaming') return true
  return ord === null && !createdAt
}

/**
 * Сортировка сообщений по `ord` (ADR-118 §2) — монотонный порядок записи.
 *
 * - живое сообщение (статус `streaming` или ещё не материализованное) —
 *   **последнее**: его `created_at` — клиентское время, смешивать его с
 *   серверным нельзя;
 * - у обоих есть `ord` — по нему; при равном `ord` — tie-break по `id`
 *   (ADR-118 «Порядок и идемпотентность»);
 * - `ord` есть только у одного — сравниваем **по времени материализации**
 *   (`created_at`, ISO — лексикографически), и только при полном равенстве —
 *   по `id`. Позиционный `index` здесь не участвует: это позиция в серверном
 *   массиве, а не порядок записи; смешивание шкал уводило сообщение
 *   (например, уведомление о завершении фонового прогона) под ответ агента;
 * - время сравнивается, только когда оба времени одного происхождения
 *   (оба серверные либо оба клиентские) — смешанные часы не сравниваем;
 * - нет ни `ord`, ни `created_at` — живое (ещё не материализованное)
 *   сообщение: оно новее всех записанных → в конец.
 */
export function compareMessagesByOrd(a: MessageOrderKey, b: MessageOrderKey): number {
  const ao = a.ord ?? null
  const bo = b.ord ?? null
  const ac = a.created_at ?? ''
  const bc = b.created_at ?? ''

  // Живое сообщение (клиентское время) — новее всех записанных → в конец.
  const aLive = isLiveOrderKey(a, ao, ac)
  const bLive = isLiveOrderKey(b, bo, bc)
  if (aLive !== bLive) return aLive ? 1 : -1

  // `ord` у обоих — монотонный порядок записи (ADR-118 §2).
  if (ao !== null && bo !== null) {
    if (ao !== bo) return ao - bo
    return tieBreakById(a, b)
  }

  // `ord` есть только у одного (или у обоих нет) — сравниваем по времени
  // материализации; при равенстве — тай-брейк по `id`.
  if (ac && bc) {
    if (ac !== bc) return ac < bc ? -1 : 1
  }
  return tieBreakById(a, b)
}

/** Сортировка сообщений сессии по `ord` (ADR-118 §2). */
export function sortMessagesByOrd(messages: MessageData[]): MessageData[] {
  return [...messages].sort(compareMessagesByOrd)
}

interface ChatStore {
  /**
   * ADR-118 §5: **единственный** источник сообщений сессии. Живое сообщение
   * (статус `streaming`) живёт здесь же — от первой дельты до терминального
   * статуса; отдельного параллельного массива «стримов» нет.
   */
  messagesBySession: Record<string, MessageData[]>
  /**
   * ADR-118 §4: части сообщений в живом состоянии —
   * `sessionId → messageId → partId → часть` (upsert по `{messageId, partId}`).
   */
  partsBySession: Record<string, Record<string, Record<string, LivePart>>>
  /** ADR-118 §1: активный ход сессии (границы группировки в ленте). */
  turnBySession: Record<string, ActiveTurn | null>
  streamFinishTickBySession: Record<string, number>
  queueBySession: Record<string, QueueState>
  pendingBySession: Record<string, QueuedMessage[]>
  retryBySession: Record<string, StreamRetry | null>
  subagentRetryBySession: Record<string, SubagentRetryState | null>
  subagentResumingBySession: Record<string, SubagentResumeState | null>
  finalErrorBySession: Record<string, FinalStreamError | null>
  stickyNotesBySession: Record<string, StickyNoteData[]>
  summarizationPendingBySession: Record<string, boolean>
  /** ADR-070 §2.6: live-вклад саб-агентов родительской сессии (для StatsTab). */
  liveSubagentUsageBySession: Record<string, LiveSubagentSessionUsage>
  debugModalSessionId: string | null
  /** ADR-118 §7: отладка адресуется по `id` сообщения (индекс нестабилен). */
  debugModalMessageId: string | null

  /** ADR-118 §7: выделение адресуется по `id` сообщения (индекс нестабилен). */
  selectionBySession: Record<string, { mode: boolean; ids: Set<string> }>

  setMessages: (sessionId: string, messages: MessageData[]) => void
  /** Upsert сообщения по `id` (ADR-118 §7 — идентификатор устойчив). */
  upsertMessage: (sessionId: string, message: MessageData) => void
  /** Точечная правка сообщения по `id`. */
  updateMessageById: (sessionId: string, messageId: string, changes: Partial<MessageData>) => void
  /** Удаление сообщения по `id`. */
  removeMessageById: (sessionId: string, messageId: string) => void
  /** ADR-118 §5: смена статуса сообщения («финал» = смена статуса). */
  setMessageStatus: (sessionId: string, messageId: string, status: MessageStatus) => void

  /** ADR-118 §4: upsert части по `{messageId, partId}`. */
  upsertPart: (sessionId: string, messageId: string, partId: string, part: LivePart) => void
  /** ADR-118 §4: дельта части (`part.delta`) — дописывает текст. */
  appendPartDelta: (
    sessionId: string,
    messageId: string,
    partId: string,
    field: 'text' | 'raw',
    delta: string,
  ) => void
  /** Точечная правка данных части (вызов инструмента, результат, прогресс). */
  patchPartData: (
    sessionId: string,
    messageId: string,
    partId: string,
    patch: Record<string, unknown>,
  ) => void
  /** ADR-118 §1: начало хода. */
  startTurn: (sessionId: string, turn: ActiveTurn) => void
  /** ADR-118 §1: терминальный статус хода. */
  finishTurn: (sessionId: string, turnId: string, status?: ActiveTurn['status']) => void
  /** Точечная правка активного хода (агент/модель/шаг). */
  patchTurn: (sessionId: string, patch: Partial<ActiveTurn>) => void

  setStreamRetry: (sessionId: string, retry: StreamRetry | null) => void
  setSubagentRetry: (sessionId: string, retry: SubagentRetryState | null) => void
  setSubagentResuming: (sessionId: string, state: SubagentResumeState | null) => void
  setFinalStreamError: (sessionId: string, error: FinalStreamError | null) => void
  updateLiveSubagentUsage: (sessionId: string, callId: string, data: {
    usage: UsageData
    costUsd?: number
    costCurrency?: string
    estimated?: boolean
    model?: string
    provider?: string
  }) => void
  /**
   * ADR-111 §detach: переведённые в фон блокирующие прогоны (`task`/`execute_shell`)
   * больше не ждут в активном ходе. `callIds` не заданы — снимаются все running
   * парты этих тулов сессии (то, что переводит кнопка хода и `ctrl+b`).
   */
  dropDetachedToolCalls: (sessionId: string, callIds?: string[]) => void

  setPendingMessages: (sessionId: string, pending: QueuedMessage[]) => void
  setQueueStalled: (sessionId: string, pendingCount: number) => void
  clearQueueState: (sessionId: string) => void
  resetQueueStalled: (sessionId: string) => void
  updateQueueCount: (sessionId: string, pendingCount: number) => void
  /** ADR-118 §4: счётчики очереди из события `queue.state`. */
  setQueueCounts: (sessionId: string, pendingCount: number, steerCount: number) => void
  /**
   * ADR-118 §4: статусы элементов очереди из `queue.state.items` (по id).
   * Строки, которых нет в списке, считаются `queued` (тексты и авторы —
   * только из API, событие их не несёт).
   */
  setQueueItems: (sessionId: string, items: Array<{ id: string; status?: QueueItemStatus }>) => void
  addPendingMessage: (sessionId: string, msg: QueuedMessage) => void
  /**
   * Подтверждение строки очереди серверным событием: строка с тем же `id`
   * заменяется (дедуп оптимистичной и серверной записи), иначе добавляется.
   */
  upsertPendingMessage: (sessionId: string, msg: QueuedMessage) => void
  /** Снять оптимистичную строку по id (реальная ошибка отправки). */
  removePendingById: (sessionId: string, id: string) => void
  removeFirstPending: (sessionId: string) => void
  /**
   * Переупорядочивание очереди по списку серверных `id` (DnD-перетаскивание):
   * элементы идут в порядке `ids`, отсутствующие (в т.ч. без `id`) — в конце
   * с сохранением прежнего относительного порядка.
   */
  reorderPending: (sessionId: string, ids: string[]) => void
  clearSession: (sessionId: string) => void
  setStickyNotes: (sessionId: string, notes: StickyNoteData[]) => void
  addStickyNote: (sessionId: string, note: StickyNoteData) => void
  updateStickyNote: (sessionId: string, noteId: string, changes: Partial<StickyNoteData>) => void
  deleteStickyNote: (sessionId: string, noteId: string) => void
  openDebugModal: (sessionId: string, messageId: string) => void
  closeDebugModal: () => void
  setSummarizationPending: (sessionId: string, pending: boolean) => void

  retryInputBySession: Record<string, string>
  setRetryInput: (sessionId: string, text: string) => void
  clearRetryInput: (sessionId: string) => void

  toggleSelectionMode: (sessionId: string) => void
  /** ADR-118 §7: toggle выделения — по `id` сообщения. */
  toggleMessageSelection: (sessionId: string, messageId: string) => void
  selectMessageRange: (sessionId: string, fromMessageId: string, toMessageId: string) => void
  selectAllMessages: (sessionId: string) => void
  clearSelection: (sessionId: string) => void
}

/**
 * Инструментальный вызов (`tool_use`) → часть сообщения (ADR-118 §1:
 * идентификатор части вызова инструмента — `callId`).
 */
export function toolCallToPart(tc: LiveToolCall): LivePart {
  return {
    id: tc.callId,
    type: 'tool_use',
    text: '',
    data: {
      name: tc.name,
      args: tc.args,
      status: tc.status,
      result: tc.result,
      startedAt: tc.startedAt,
      completedAt: tc.completedAt,
      iteration: tc.iteration,
      parentCallId: tc.parentCallId,
      subagentReasoningBlocks: tc.subagentReasoningBlocks,
      subagentIntermediateTextBlocks: tc.subagentIntermediateTextBlocks,
    },
  }
}

/** Часть `tool_use` → инструментальный вызов (для рендера `ToolCallPart`). */
export function partToToolCall(part: LivePart): LiveToolCall | null {
  if (part.type !== 'tool_use') return null
  const d = (part.data ?? {}) as Record<string, unknown>
  const name = typeof d.name === 'string' ? d.name : 'unknown'
  const args = (d.args as Record<string, unknown>) || {}
  const rawResult = d.result as { content: string; isError?: boolean; metadata?: Record<string, unknown> } | undefined
  const status = d.status === 'done' || rawResult ? 'done' : 'running'
  return {
    callId: part.id,
    name,
    args,
    status,
    result: rawResult,
    startedAt: typeof d.startedAt === 'string' ? d.startedAt : '',
    completedAt: typeof d.completedAt === 'string' ? d.completedAt : undefined,
    iteration: typeof d.iteration === 'number' ? d.iteration : 0,
    parentCallId: typeof d.parentCallId === 'string' ? d.parentCallId : undefined,
    subagentReasoningBlocks: d.subagentReasoningBlocks as ReasoningBlockData[] | undefined,
    subagentIntermediateTextBlocks: d.subagentIntermediateTextBlocks as IntermediateTextBlockData[] | undefined,
  }
}

export const useChatStore = create<ChatStore>((set) => ({
  messagesBySession: {},
  partsBySession: {},
  turnBySession: {},
  streamFinishTickBySession: {},
  queueBySession: {},
  pendingBySession: {},
  retryBySession: {},
  subagentRetryBySession: {},
  subagentResumingBySession: {},
  finalErrorBySession: {},
  stickyNotesBySession: {},
  summarizationPendingBySession: {},
  liveSubagentUsageBySession: {},
  debugModalSessionId: null,
  debugModalMessageId: null,
  retryInputBySession: {},
  selectionBySession: {},

  setMessages: (sessionId, messages) =>
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: sortMessagesByOrd(messages) },
    })),

  upsertMessage: (sessionId, message) =>
    set((s) => {
      const current = s.messagesBySession[sessionId] || []
      const at = message.id
        ? current.findIndex((m) => m.id === message.id)
        : current.findIndex((m) => m.index === message.index)
      if (at === -1) {
        return {
          messagesBySession: {
            ...s.messagesBySession,
            [sessionId]: sortMessagesByOrd([...current, message]),
          },
        }
      }
      const prev = current[at]!
      const merged: MessageData = {
        ...prev,
        ...message,
        // Контент из `message.added` может быть усечён (500 симв.); не затираем
        // уже известный полный контент.
        content: prev.content || message.content,
        metadata: { ...(prev.metadata ?? {}), ...(message.metadata ?? {}) },
      }
      const next = [...current]
      next[at] = merged
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: sortMessagesByOrd(next) } }
    }),

  updateMessageById: (sessionId, messageId, changes) =>
    set((s) => {
      const current = s.messagesBySession[sessionId]
      if (!current) return s
      const at = current.findIndex((m) => m.id === messageId)
      if (at === -1) return s
      const next = [...current]
      next[at] = { ...next[at]!, ...changes }
      // `ord` приходит сюда из `message.delivered` (ADR-118 §4) — пересортировываем,
      // чтобы порядок в сторе совпадал с порядком отрисовки (и с `index` сервера).
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: sortMessagesByOrd(next) } }
    }),

  removeMessageById: (sessionId, messageId) =>
    set((s) => {
      const current = s.messagesBySession[sessionId]
      if (!current) return s
      const next = current.filter((m) => m.id !== messageId)
      if (next.length === current.length) return s
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: next } }
    }),

  setMessageStatus: (sessionId, messageId, status) =>
    set((s) => {
      const current = s.messagesBySession[sessionId]
      if (!current) return s
      const at = current.findIndex((m) => m.id === messageId)
      if (at === -1) return s
      const next = [...current]
      next[at] = { ...next[at]!, status }
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: next } }
    }),

  upsertPart: (sessionId, messageId, partId, part) =>
    set((s) => {
      const sessionParts = s.partsBySession[sessionId] || {}
      const messageParts = sessionParts[messageId] || {}
      if (messageParts[partId] === part) return s
      return {
        partsBySession: {
          ...s.partsBySession,
          [sessionId]: {
            ...sessionParts,
            [messageId]: { ...messageParts, [partId]: part },
          },
        },
      }
    }),

  appendPartDelta: (sessionId, messageId, partId, field, delta) =>
    set((s) => {
      if (!delta) return s
      const sessionParts = s.partsBySession[sessionId] || {}
      const messageParts = sessionParts[messageId] || {}
      const existing = messageParts[partId]
      const next: LivePart = existing
        ? field === 'raw'
          ? { ...existing, raw: (existing.raw ?? '') + delta }
          : { ...existing, text: existing.text + delta }
        : {
            id: partId,
            type: field === 'raw' ? 'tool_use' : 'text',
            text: field === 'raw' ? '' : delta,
            ...(field === 'raw' ? { raw: delta } : {}),
          }
      return {
        partsBySession: {
          ...s.partsBySession,
          [sessionId]: {
            ...sessionParts,
            [messageId]: { ...messageParts, [partId]: next },
          },
        },
      }
    }),

  patchPartData: (sessionId, messageId, partId, patch) =>
    set((s) => {
      const sessionParts = s.partsBySession[sessionId]
      const messageParts = sessionParts?.[messageId]
      const existing = messageParts?.[partId]
      if (!existing) return s
      const data = (existing.data ?? {}) as Record<string, unknown>
      return {
        partsBySession: {
          ...s.partsBySession,
          [sessionId]: {
            ...sessionParts,
            [messageId]: {
              ...messageParts,
              [partId]: { ...existing, data: { ...data, ...patch } },
            },
          },
        },
      }
    }),

  startTurn: (sessionId, turn) =>
    set((s) => ({ turnBySession: { ...s.turnBySession, [sessionId]: turn } })),

  finishTurn: (sessionId, turnId, status) =>
    set((s) => {
      const current = s.turnBySession[sessionId]
      if (!current || current.turnId !== turnId) return s
      return {
        turnBySession: {
          ...s.turnBySession,
          [sessionId]: {
            ...current,
            status: status ?? 'completed',
            // Терминальный ход не может «выполнять инструмент»: иначе флаг
            // пережил бы ход и строка активности соврала бы в следующем.
            toolsRunning: false,
          },
        },
      }
    }),

  patchTurn: (sessionId, patch) =>
    set((s) => {
      const current = s.turnBySession[sessionId]
      if (!current) return s
      return {
        turnBySession: { ...s.turnBySession, [sessionId]: { ...current, ...patch } },
      }
    }),

  setStreamRetry: (sessionId, retry) =>
    set((s) => ({
      retryBySession: { ...s.retryBySession, [sessionId]: retry },
    })),

  setSubagentRetry: (sessionId, retry) =>
    set((s) => ({
      subagentRetryBySession: { ...s.subagentRetryBySession, [sessionId]: retry },
    })),

  setSubagentResuming: (sessionId, state) =>
    set((s) => ({
      subagentResumingBySession: { ...s.subagentResumingBySession, [sessionId]: state },
    })),

  setFinalStreamError: (sessionId, error) =>
    set((s) => {
      const prev = s.finalErrorBySession[sessionId]
      // no-op если значение не меняется — иначе лишние перерендеры
      if (prev === error || (prev === null && error === null)) return s
      if (prev && error && prev.streamId === error.streamId && prev.error === error.error && prev.errorType === error.errorType) return s
      return {
        finalErrorBySession: { ...s.finalErrorBySession, [sessionId]: error },
      }
    }),

  updateLiveSubagentUsage: (sessionId, callId, data) =>
    set((s) => {
      const sessionUsage = s.liveSubagentUsageBySession[sessionId]
      const byCall = { ...(sessionUsage?.byCall || {}) }
      const prev = byCall[callId]
      byCall[callId] = {
        usage: data.usage ?? prev?.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        costUsd: data.costUsd ?? prev?.costUsd,
        costCurrency: data.costCurrency ?? prev?.costCurrency,
        estimated: data.estimated ?? prev?.estimated ?? false,
        model: data.model ?? prev?.model,
        provider: data.provider ?? prev?.provider,
      }

      let input = 0
      let output = 0
      let total = 0
      let cacheRead = 0
      let cacheWrite = 0
      let reasoning = 0
      let cost = 0
      let anyCost = false
      let anyEstimated = false
      // C2b: не смешиваем валюты — копим раздельно по кодам, номинальная сумма
      // (`costUsd`) остаётся для обратной совместимости.
      const costByCurrency: Record<string, number> = {}
      for (const call of Object.values(byCall)) {
        input += call.usage.input_tokens || 0
        output += call.usage.output_tokens || 0
        total += call.usage.total_tokens || 0
        cacheRead += call.usage.cache_read_tokens || 0
        cacheWrite += call.usage.cache_write_tokens || 0
        reasoning += call.usage.reasoning_tokens || 0
        if (call.costUsd !== undefined) {
          cost += call.costUsd
          anyCost = true
          const key = costCurrencyKey(call.costCurrency)
          costByCurrency[key] = (costByCurrency[key] ?? 0) + call.costUsd
        }
        if (call.estimated) anyEstimated = true
      }
      const currencies = Object.keys(costByCurrency)
      const costCurrency = currencies.length === 1 ? currencies[0] : undefined

      return {
        liveSubagentUsageBySession: {
          ...s.liveSubagentUsageBySession,
          [sessionId]: {
            usage: {
              input_tokens: input,
              output_tokens: output,
              total_tokens: total,
              cache_read_tokens: cacheRead,
              cache_write_tokens: cacheWrite,
              reasoning_tokens: reasoning,
            },
            ...(anyCost ? { costUsd: cost } : {}),
            ...(costCurrency !== undefined ? { costCurrency } : {}),
            ...(currencies.length > 0 ? { costByCurrency } : {}),
            estimated: anyEstimated,
            byCall,
          },
        },
      }
    }),

  dropDetachedToolCalls: (sessionId, callIds) =>
    set((s) => {
      const sessionParts = s.partsBySession[sessionId]
      if (!sessionParts) return s
      const targets = callIds && callIds.length > 0 ? new Set(callIds) : null
      let changed = false
      const nextSession: Record<string, Record<string, LivePart>> = {}
      for (const [messageId, messageParts] of Object.entries(sessionParts)) {
        const nextMessage: Record<string, LivePart> = {}
        for (const [partId, part] of Object.entries(messageParts)) {
          const call = partToToolCall(part)
          const isDetachable =
            call != null &&
            call.status === 'running' &&
            (call.name === 'task' || call.name === 'execute_shell')
          if (isDetachable && (!targets || targets.has(call.callId))) {
            changed = true
            continue
          }
          nextMessage[partId] = part
        }
        if (Object.keys(nextMessage).length > 0) nextSession[messageId] = nextMessage
      }
      if (!changed) return s
      return { partsBySession: { ...s.partsBySession, [sessionId]: nextSession } }
    }),

  setPendingMessages: (sessionId, pending) =>
    set((s) => ({
      pendingBySession: { ...s.pendingBySession, [sessionId]: pending },
    })),

  setQueueStalled: (sessionId, pendingCount) =>
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId]: { pendingCount, steerCount: 0, isStalled: true },
      },
    })),

  clearQueueState: (sessionId) =>
    set((s) => {
      const queueBySession = { ...s.queueBySession }
      delete queueBySession[sessionId]
      const pendingBySession = { ...s.pendingBySession }
      delete pendingBySession[sessionId]
      return { queueBySession, pendingBySession }
    }),

  resetQueueStalled: (sessionId) =>
    set((s) => {
      const prev = s.queueBySession[sessionId]
      if (!prev) return s
      return {
        queueBySession: {
          ...s.queueBySession,
          [sessionId]: { ...prev, isStalled: false },
        },
      }
    }),

  updateQueueCount: (sessionId, pendingCount) =>
    set((s) => {
      const prev = s.queueBySession[sessionId]
      return {
        queueBySession: {
          ...s.queueBySession,
          [sessionId]: {
            pendingCount,
            steerCount: prev?.steerCount ?? 0,
            isStalled: prev?.isStalled ?? false,
          },
        },
      }
    }),

  setQueueCounts: (sessionId, pendingCount, steerCount) =>
    set((s) => {
      const prev = s.queueBySession[sessionId]
      return {
        queueBySession: {
          ...s.queueBySession,
          [sessionId]: {
            pendingCount,
            steerCount,
            isStalled: prev?.isStalled ?? false,
          },
        },
      }
    }),

  setQueueItems: (sessionId, items) =>
    set((s) => {
      const current = s.pendingBySession[sessionId]
      if (!current || current.length === 0) return s
      const statusById = new Map<string, QueueItemStatus>()
      for (const item of items) {
        const id = typeof item?.id === 'string' ? item.id : ''
        if (!id) continue
        statusById.set(id, item.status === 'starting' ? 'starting' : 'queued')
      }
      let changed = false
      const pending = current.map((msg) => {
        const status: QueueItemStatus = (msg.id ? statusById.get(msg.id) : undefined) ?? 'queued'
        if (msg.status === status) return msg
        changed = true
        return { ...msg, status }
      })
      if (!changed) return s
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  addPendingMessage: (sessionId, msg) =>
    set((s) => {
      const pending = [...(s.pendingBySession[sessionId] || []), msg]
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  upsertPendingMessage: (sessionId, msg) =>
    set((s) => {
      const current = s.pendingBySession[sessionId] || []
      // Дедup: оптимистичная строка (id = id отправки) и серверное `message.accepted`
      // с тем же `message_id` — одна строка, а не две.
      const at = msg.id ? current.findIndex((item) => item.id === msg.id) : -1
      const pending = at >= 0
        ? current.map((item, i) => (i === at ? { ...item, ...msg, sending: false } : item))
        : [...current, msg]
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  removePendingById: (sessionId, id) =>
    set((s) => {
      const current = s.pendingBySession[sessionId]
      if (!current) return s
      const pending = current.filter((item) => item.id !== id)
      if (pending.length === current.length) return s
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  removeFirstPending: (sessionId) =>
    set((s) => {
      const pending = [...(s.pendingBySession[sessionId] || [])]
      pending.shift()
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  reorderPending: (sessionId, ids) =>
    set((s) => {
      const current = s.pendingBySession[sessionId]
      if (!current || current.length === 0) return s
      if (ids.length === 0) return s
      // Новый порядок: сначала id из списка (в его порядке), затем всё, чего в
      // списке нет (оптимистичные строки без серверного id) — в прежнем порядке.
      const byId = new Map<string, QueuedMessage>()
      for (const item of current) {
        if (item.id) byId.set(item.id, item)
      }
      const ordered: QueuedMessage[] = []
      const placed = new Set<QueuedMessage>()
      for (const id of ids) {
        const item = byId.get(id)
        if (!item || placed.has(item)) continue
        ordered.push(item)
        placed.add(item)
      }
      for (const item of current) {
        if (!placed.has(item)) ordered.push(item)
      }
      if (ordered.length !== current.length) return s
      if (ordered.every((item, index) => item === current[index])) return s
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: ordered } }
    }),

  clearSession: (sessionId) =>
    set((s) => {
      const messagesBySession = { ...s.messagesBySession }
      delete messagesBySession[sessionId]
      const partsBySession = { ...s.partsBySession }
      delete partsBySession[sessionId]
      const turnBySession = { ...s.turnBySession }
      delete turnBySession[sessionId]
      const queueBySession = { ...s.queueBySession }
      delete queueBySession[sessionId]
      const pendingBySession = { ...s.pendingBySession }
      delete pendingBySession[sessionId]
      const retryBySession = { ...s.retryBySession }
      delete retryBySession[sessionId]
      const subagentRetryBySession = { ...s.subagentRetryBySession }
      delete subagentRetryBySession[sessionId]
      const subagentResumingBySession = { ...s.subagentResumingBySession }
      delete subagentResumingBySession[sessionId]
      const finalErrorBySession = { ...s.finalErrorBySession }
      delete finalErrorBySession[sessionId]
      const liveSubagentUsageBySession = { ...s.liveSubagentUsageBySession }
      delete liveSubagentUsageBySession[sessionId]
      return {
        messagesBySession,
        partsBySession,
        turnBySession,
        queueBySession,
        pendingBySession,
        retryBySession,
        subagentRetryBySession,
        subagentResumingBySession,
        finalErrorBySession,
        liveSubagentUsageBySession,
      }
    }),

  setStickyNotes: (sessionId, notes) =>
    set((s) => ({
      stickyNotesBySession: { ...s.stickyNotesBySession, [sessionId]: notes },
    })),

  addStickyNote: (sessionId, note) =>
    set((s) => {
      const notes = [...(s.stickyNotesBySession[sessionId] || [])]
      if (notes.find((n) => n.id === note.id)) return s
      return {
        stickyNotesBySession: { ...s.stickyNotesBySession, [sessionId]: [...notes, note] },
      }
    }),

  updateStickyNote: (sessionId, noteId, changes) =>
    set((s) => {
      const notes = [...(s.stickyNotesBySession[sessionId] || [])]
      const idx = notes.findIndex((n) => n.id === noteId)
      if (idx === -1) return s
      notes[idx] = { ...notes[idx]!, ...changes }
      return { stickyNotesBySession: { ...s.stickyNotesBySession, [sessionId]: notes } }
    }),

  deleteStickyNote: (sessionId, noteId) =>
    set((s) => {
      const notes = (s.stickyNotesBySession[sessionId] || []).filter((n) => n.id !== noteId)
      return { stickyNotesBySession: { ...s.stickyNotesBySession, [sessionId]: notes } }
    }),

  openDebugModal: (sessionId, messageId) =>
    set({ debugModalSessionId: sessionId, debugModalMessageId: messageId }),

  closeDebugModal: () =>
    set({ debugModalSessionId: null, debugModalMessageId: null }),

  setSummarizationPending: (sessionId, pending) =>
    set((s) => ({
      summarizationPendingBySession: { ...s.summarizationPendingBySession, [sessionId]: pending },
    })),

  setRetryInput: (sessionId, text) =>
    set((s) => ({
      retryInputBySession: { ...s.retryInputBySession, [sessionId]: text },
    })),

  clearRetryInput: (sessionId) =>
    set((s) => {
      const retryInputBySession = { ...s.retryInputBySession }
      delete retryInputBySession[sessionId]
      return { retryInputBySession }
    }),

  toggleSelectionMode: (sessionId) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (current?.mode) {
        // Exiting selection mode: clear everything
        const selectionBySession = { ...s.selectionBySession }
        delete selectionBySession[sessionId]
        return { selectionBySession }
      }
      // Entering selection mode
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, ids: new Set<string>() },
        },
      }
    }),

  toggleMessageSelection: (sessionId, messageId) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current?.mode) return s
      const next = new Set(current.ids)
      if (next.has(messageId)) {
        next.delete(messageId)
      } else {
        next.add(messageId)
      }
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, ids: next },
        },
      }
    }),

  selectMessageRange: (sessionId, fromMessageId, toMessageId) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current?.mode) return s
      const next = new Set(current.ids)
      // Границы диапазона — позиции в отсортированной ленте (по `ord`), само
      // выделение по-прежнему хранит `id`.
      const msgs = s.messagesBySession[sessionId] || []
      const from = msgs.findIndex((m) => m.id === fromMessageId)
      const to = msgs.findIndex((m) => m.id === toMessageId)
      if (from < 0 || to < 0) return s
      const start = Math.min(from, to)
      const end = Math.max(from, to)
      for (let i = start; i <= end; i++) {
        const id = msgs[i]?.id
        if (id) next.add(id)
      }
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, ids: next },
        },
      }
    }),

  selectAllMessages: (sessionId) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current?.mode) return s
      const msgs = s.messagesBySession[sessionId] || []
      const next = new Set<string>()
      for (const m of msgs) if (m.id) next.add(m.id)
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, ids: next },
        },
      }
    }),

  clearSelection: (sessionId) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current) return s
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { ...current, ids: new Set<string>() },
        },
      }
    }),
}))

/**
 * ADR-070 §2.6: селектор live-вклада саб-агентов сессии (для StatsTab).
 * Использование: `useChatStore(selectLiveSubagentUsage(sessionId))`.
 */
export function selectLiveSubagentUsage(sessionId: string) {
  return (s: { liveSubagentUsageBySession: Record<string, LiveSubagentSessionUsage> }):
    LiveSubagentSessionUsage | undefined => s.liveSubagentUsageBySession[sessionId]
}

/**
 * ADR-118 §5: сообщение сессии со статусом `streaming` — «живой» черновик
 * (единственный источник live-контента).
 */
export function selectStreamingMessage(sessionId: string) {
  return (s: { messagesBySession: Record<string, MessageData[]> }): MessageData | undefined =>
    s.messagesBySession[sessionId]?.find((m) => m.status === 'streaming')
}
