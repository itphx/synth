import { create } from 'zustand'
import type { StickyNoteData } from '@/lib/api/synthApi'
import { costCurrencyKey } from '@/lib/currency'

export type DebugData = Record<string, unknown>;

export interface ReasoningBlockData {
  text: string
  iteration: number
}

export interface IntermediateTextBlockData {
  text: string
  iteration: number
}

/** ADR-070 §2.6: статус ответа ассистента (metadata.status), определяет префикс статистики. */
export type MessageStatus = 'completed' | 'cancelled' | 'stopped' | 'error' | 'limit' | 'interrupted'

export interface MessageData {
  index: number
  id?: string
  seq?: number
  origin?: string
  source_msg_id?: string | null
  parts?: Array<{
    id: string
    type: string
    data: unknown
  }> | null
  role: string
  content: string
  tool_calls?: Array<{
    name: string
    args: Record<string, unknown>
    id?: string
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

/** ADR-070 §2.6: usage в snake_case (как в MessageData/StreamState). */
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

/** ADR-070 §2.6: вклад одного вызова саб-агента (по parent_call_id) в родителе. */
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
  /** C2a: валюта агрегата; не задаётся, если вызовы в разных валютах. */
  costCurrency?: string
  /** C2b: разбивка стоимости агрегата по валютам (код → сумма). */
  costByCurrency?: Record<string, number>
  estimated: boolean
  byCall: Record<string, LiveSubagentCallUsage>
}

export interface StreamState {
  streamId: string
  agentRole: string | null
  content: string
  reasoningBlocks: ReasoningBlockData[]
  intermediateTextBlocks: IntermediateTextBlockData[]
  isStreaming: boolean
  /** true, когда пришёл первый непустой chunk (content/reasoning) или начался вызов инструмента — признак, что провайдер начал отвечать */
  hasContent: boolean
  isRetrying?: boolean
  model?: string
  provider?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number }
  /** ADR-070 §2.6: live-стоимость ответа (из stream.usage/subagent.progress). */
  costUsd?: number
  /** C2a: валюта `costUsd` (из stream.usage/subagent.progress). */
  costCurrency?: string
  costBreakdown?: CostBreakdown
  /** ADR-070 §2.6: usage — best-effort оценка, а не точные токены провайдера. */
  usageEstimated?: boolean
  toolCalls: LiveToolCall[]
  toolIteration: number
  _lastContentLen: number
}

export interface StreamDoneMetadata {
  model?: string
  content?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number }
  debug_info?: Record<string, unknown> | null
  message_index?: number
  /** ADR-046 §7.1: id сохранённого assistant-сообщения (stream.done.message_id). */
  message_id?: string
  cancelled?: boolean
  pending_count?: number
  /** ADR-070 §2.6: статус завершения стрима (stream.done.status). */
  status?: MessageStatus
  metadata?: { type?: string; indices?: number[]; [key: string]: unknown }
  reasoning_blocks?: ReasoningBlockData[]
  intermediate_text_blocks?: IntermediateTextBlockData[]
  /** ADR-070 §2.6: длительность прогона (stream.done.duration_ms). */
  duration_ms?: number
  /** ADR-070 §2.6: стоимость хода (stream.done.cost_usd). */
  cost_usd?: number
  /** C2a: валюта `cost_usd` (stream.done.cost_currency). */
  cost_currency?: string
  /** ADR-070 §2.6: разбивка стоимости (stream.done.cost_breakdown). */
  cost_breakdown?: CostBreakdown
  /** ADR-070 §2.6: usage — best-effort оценка (stream.done.usage_estimated). */
  usage_estimated?: boolean
  /** ADR-070 §2.6: провайдер финального ответа (stream.done.provider). */
  provider?: string
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
  isStalled: boolean
}

export interface QueuedMessage {
  content: string
  agentRole?: string | null
}

/**
 * Сигнал завершения стрима для сессии: инкрементируется в `finishStream`/`cancelStream`.
 * Нужен панели «Статистика» — `finishStream` часто обновляет существующее
 * assistant-сообщение на месте (id не меняется), поэтому `lastAssistantMsg?.id`
 * не срабатывает как триггер перезапроса.
 */
function bumpStreamFinishTick(
  ticks: Record<string, number>,
  sessionId: string,
): Record<string, number> {
  return { ...ticks, [sessionId]: (ticks[sessionId] ?? 0) + 1 }
}

/**
 * ADR-070 §2.6: StreamState, созданный только live-usage дочерней сессии саб-агента
 * (без stream.start/контента/тулов). Такой плейсхолдер удаляется терминальным
 * событием `stream.ended`, чтобы не задевать настоящий стрим родителя.
 */
function isUsageOnlyStream(st: StreamState | undefined): boolean {
  return !!st && !st.hasContent && st.content.length === 0 && st.toolCalls.length === 0
}

/**
 * ADR-070 §2.6: накопление reasoning-блоков по итерациям. Внутри одной итерации
 * более длинный текст заменяет предыдущий; новая итерация — отдельный блок.
 */
function appendReasoningBlock(
  blocks: ReasoningBlockData[],
  text: string,
  iteration: number,
): ReasoningBlockData[] {
  if (!text || !text.trim()) return blocks
  if (blocks.length === 0) return [{ text, iteration }]
  const last = blocks[blocks.length - 1]!
  if (last.iteration === iteration && text.length >= last.text.length) {
    return [...blocks.slice(0, -1), { ...last, text }]
  }
  return [...blocks, { text, iteration }]
}

/** ADR-070 §2.6: накопление промежуточного текста; в итерации текст перезаписывается. */
function appendIntermediateBlock(
  blocks: IntermediateTextBlockData[],
  text: string,
  iteration: number,
): IntermediateTextBlockData[] {
  if (!text || !text.trim()) return blocks
  const last = blocks[blocks.length - 1]
  if (last && last.iteration === iteration) {
    return [...blocks.slice(0, -1), { ...last, text }]
  }
  return [...blocks, { text, iteration }]
}

type MessageToolCall = NonNullable<MessageData['tool_calls']>[number]

/** Live-вызовы (`LiveToolCall`) → сохраняемая форма сообщения (`tool_calls`). */
function mapLiveToolCalls(toolCalls: LiveToolCall[]): MessageToolCall[] | null {
  if (toolCalls.length === 0) return null
  return toolCalls.map((tc) => ({
    name: tc.name,
    args: tc.args,
    id: tc.callId,
    result: tc.result,
    started_at: tc.startedAt,
    completed_at: tc.completedAt,
    iteration: tc.iteration,
  }))
}

interface ChatStore {
  messagesBySession: Record<string, MessageData[]>
  streamFinishTickBySession: Record<string, number>
  streamingBySession: Record<string, Record<string, StreamState>>
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
  debugModalMessageIndex: number | null

  selectionBySession: Record<string, { mode: boolean; indices: Set<number> }>

  setMessages: (sessionId: string, messages: MessageData[]) => void
  updateMessage: (sessionId: string, index: number, changes: Partial<MessageData>) => void
  startStream: (sessionId: string, streamId: string, agentRole: string | null, model?: string, provider?: string) => void
  updateStreamChunk: (sessionId: string, streamId: string, content: string, reasoning: string, model?: string, provider?: string, iteration?: number) => void
  /**
   * ADR-104 (этап 2): прерывание генерации (`stream.interrupted`) — ход НЕ
   * завершается, стрим остаётся живым (с тем же `stream_id`), но накопленный
   * текст прерванной генерации уже сохранён отдельным сообщением. Сбрасываем
   * только аккумулятор (текст/рассуждения), сам стрим и его tool-вызовы —
   * сохраняем: следующая итерация продолжит ту же генерацию.
   */
  resetStreamAccumulator: (sessionId: string, streamId: string) => void
  updateStreamUsage: (sessionId: string, streamId: string, data: {
    usage?: UsageData
    costUsd?: number
    costCurrency?: string
    costBreakdown?: CostBreakdown
    usageEstimated?: boolean
    model?: string
    provider?: string
    /** ADR-070 §2.6: роль агента (stream.usage.agent_role) — для дочерней сессии. */
    agentRole?: string
  }) => void
  /** ADR-070 §2.6: сброс live-плейсхолдера дочерней сессии (stream.ended). */
  clearUsageStream: (sessionId: string, streamId?: string) => void
  updateLiveSubagentUsage: (sessionId: string, callId: string, data: {
    usage?: UsageData
    costUsd?: number
    costCurrency?: string
    estimated?: boolean
    model?: string
    provider?: string
  }) => void
  addToolCall: (sessionId: string, streamId: string, tc: LiveToolCall) => void
  updateToolCallResult: (sessionId: string, streamId: string, callId: string, result: { content: string; isError?: boolean; metadata?: Record<string, unknown> }) => void
  updateToolCallSubagentProgress: (sessionId: string, streamId: string, callId: string, patch: { reasoning?: string; content?: string; iteration?: number }) => void
  finishStream: (sessionId: string, streamId: string, metadata: StreamDoneMetadata) => void
  cancelStream: (sessionId: string, streamId: string, status?: MessageStatus, extra?: {
    usage?: UsageData
    costUsd?: number
    costCurrency?: string
    costBreakdown?: CostBreakdown
    usageEstimated?: boolean
  }) => void
  setStreamRetry: (sessionId: string, retry: StreamRetry | null) => void
  setStreamRetrying: (sessionId: string, streamId: string, isRetrying: boolean) => void
  setSubagentRetry: (sessionId: string, retry: SubagentRetryState | null) => void
  setSubagentResuming: (sessionId: string, state: SubagentResumeState | null) => void
  setFinalStreamError: (sessionId: string, error: FinalStreamError | null) => void
  addMessage: (sessionId: string, message: MessageData) => void
  setPendingMessages: (sessionId: string, pending: QueuedMessage[]) => void
  setQueueStalled: (sessionId: string, pendingCount: number) => void
  clearQueueState: (sessionId: string) => void
  resetQueueStalled: (sessionId: string) => void
  updateQueueCount: (sessionId: string, pendingCount: number) => void
  addPendingMessage: (sessionId: string, msg: QueuedMessage) => void
  removeFirstPending: (sessionId: string) => void
  clearSession: (sessionId: string) => void
  setStickyNotes: (sessionId: string, notes: StickyNoteData[]) => void
  addStickyNote: (sessionId: string, note: StickyNoteData) => void
  updateStickyNote: (sessionId: string, noteId: string, changes: Partial<StickyNoteData>) => void
  deleteStickyNote: (sessionId: string, noteId: string) => void
  openDebugModal: (sessionId: string, messageIndex: number) => void
  closeDebugModal: () => void
  setSummarizationPending: (sessionId: string, pending: boolean) => void

  retryInputBySession: Record<string, string>
  setRetryInput: (sessionId: string, text: string) => void
  clearRetryInput: (sessionId: string) => void

  toggleSelectionMode: (sessionId: string) => void
  toggleMessageSelection: (sessionId: string, index: number) => void
  selectMessageRange: (sessionId: string, from: number, to: number) => void
  selectAllMessages: (sessionId: string) => void
  clearSelection: (sessionId: string) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  messagesBySession: {},
  streamFinishTickBySession: {},
  streamingBySession: {},
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
  debugModalMessageIndex: null,
  retryInputBySession: {},
  selectionBySession: {},

  setMessages: (sessionId, messages) =>
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: messages },
    })),

  updateMessage: (sessionId, index, changes) =>
    set((s) => {
      const msgs = [...(s.messagesBySession[sessionId] || [])]
      const msgIdx = msgs.findIndex((m) => m.index === index)
      if (msgIdx === -1) return s
      msgs[msgIdx] = { ...msgs[msgIdx]!, ...changes }
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: msgs } }
    }),

  startStream: (sessionId, streamId, agentRole, model, provider) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      sessionStreams[streamId] = {
        streamId,
        agentRole,
        content: '',
        reasoningBlocks: [],
        intermediateTextBlocks: [],
        isStreaming: true,
        hasContent: false,
        model,
        provider,
        toolCalls: [],
        toolIteration: 0,
        _lastContentLen: 0,
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  updateStreamChunk: (sessionId, streamId, content, reasoning, model, provider, iteration) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      if (!existing) return s
      const nextBlocks = appendReasoningBlock(
        existing.reasoningBlocks,
        reasoning,
        iteration ?? existing.toolIteration,
      )
      const nextHasContent = existing.hasContent
        || (typeof content === 'string' && content.length > 0)
        || (typeof reasoning === 'string' && reasoning.trim().length > 0)
      sessionStreams[streamId] = {
        ...existing,
        content: existing.content + content,
        reasoningBlocks: nextBlocks,
        hasContent: nextHasContent,
        model: model || existing.model,
        provider: provider || existing.provider,
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  // ADR-104 (этап 2): прерывание генерации (`stream.interrupted`). Ход
  // продолжается (тот же `stream_id`), а накопленный текст прерванной
  // генерации уже сохранён отдельным сообщением со статусом `interrupted` —
  // сбрасываем аккумулятор, чтобы следующие чанки не дописались к нему.
  // Живой стрим (isStreaming) и его tool-вызовы сохраняем.
  resetStreamAccumulator: (sessionId, streamId) =>
    set((s) => {
      const existing = s.streamingBySession[sessionId]?.[streamId]
      if (!existing) return s
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      sessionStreams[streamId] = {
        ...existing,
        content: '',
        reasoningBlocks: [],
        intermediateTextBlocks: [],
        hasContent: false,
        _lastContentLen: 0,
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  // ADR-070 §2.6: live-статистика стрима (событие stream.usage). Обновляет
  // соответствующий StreamState; точный usage не понижается оценкой.
  // Дочерняя сессия саб-агента не получает stream.start — при первом usage
  // создаём минимальный StreamState (без контента, `hasContent: false`), чтобы
  // открытая дочерняя сессия показывала live. MessageList рисует плейсхолдер
  // только при `hasContent`, поэтому фантомного сообщения не появляется;
  // терминальное `stream.ended` из task.ts удаляет такой StreamState.
  updateStreamUsage: (sessionId, streamId, data) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      const base: StreamState = existing ?? {
        streamId,
        agentRole: data.agentRole ?? null,
        content: '',
        reasoningBlocks: [],
        intermediateTextBlocks: [],
        isStreaming: true,
        hasContent: false,
        model: data.model,
        provider: data.provider,
        toolCalls: [],
        toolIteration: 0,
        _lastContentLen: 0,
      }
      // Не понижаем точность: если уже есть точный usage, оценка его не перезаписывает
      // (равно как и вычисленные по ней cost/usageEstimated).
      const downgrade = base.usage !== undefined
        && base.usageEstimated !== true
        && data.usageEstimated === true
      sessionStreams[streamId] = {
        ...base,
        ...(data.usage && !downgrade ? { usage: data.usage } : {}),
        ...(data.costUsd !== undefined && !downgrade ? { costUsd: data.costUsd } : {}),
        ...(data.costCurrency !== undefined && !downgrade ? { costCurrency: data.costCurrency } : {}),
        ...(data.costBreakdown !== undefined && !downgrade ? { costBreakdown: data.costBreakdown } : {}),
        ...(data.usageEstimated !== undefined && !downgrade ? { usageEstimated: data.usageEstimated } : {}),
        ...(data.model ? { model: data.model } : {}),
        ...(data.provider ? { provider: data.provider } : {}),
        ...(data.agentRole ? { agentRole: data.agentRole } : {}),
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  // ADR-070 §2.6: терминальное событие дочерней сессии саб-агента. Удаляет
  // usage-only StreamState (если streamId не задан — все такие в сессии), не
  // трогая настоящий стрим с контентом/тулами.
  clearUsageStream: (sessionId, streamId) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      let changed = false
      if (streamId) {
        if (isUsageOnlyStream(sessionStreams[streamId])) {
          delete sessionStreams[streamId]
          changed = true
        }
      } else {
        for (const key of Object.keys(sessionStreams)) {
          if (isUsageOnlyStream(sessionStreams[key])) {
            delete sessionStreams[key]
            changed = true
          }
        }
      }
      if (!changed) return s
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  // ADR-070 §2.6: live-вклад саб-агентов (событие subagent.progress в родителе).
  // Событие несёт НАКОПЛЕННЫЙ usage вызова, поэтому вклад вызова перезаписываем,
  // а агрегат сессии пересчитываем суммой по вызовам.
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

  addToolCall: (sessionId, streamId, tc) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      if (!existing) return s
      const idx = existing.toolCalls.findIndex((c) => c.callId === tc.callId)
      let toolCalls: LiveToolCall[]
      if (idx >= 0) {
        // Дедупликация по callId: повторный tool_call.started для того же вызова
        // обновляет узел (статус/итерация), а не создаёт «призрачный» дубль
        // (например, при переизлучении read_file reason-моделью в стриме).
        toolCalls = [...existing.toolCalls]
        toolCalls[idx] = { ...toolCalls[idx]!, ...tc }
      } else {
        toolCalls = [...existing.toolCalls, tc]
      }
      sessionStreams[streamId] = {
        ...existing,
        toolCalls,
        // Вызов инструмента — тоже ответ провайдера (как текст/reasoning). Сразу
        // помечаем стрим содержательным, чтобы плейсхолдер и снятие «processing» в
        // MessageList срабатывали уже по `tool_call.started`, а не после завершения
        // инструмента (регресс c11ece3f: фильтр `isStreaming && hasContent`).
        hasContent: true,
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  updateToolCallResult: (sessionId, streamId, callId, result) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      if (!existing) return s
      const idx = existing.toolCalls.findIndex((tc) => tc.callId === callId)
      if (idx === -1) return s
      const updated = [...existing.toolCalls]
      updated[idx] = {
        ...updated[idx]!,
        status: 'done' as const,
        result,
        completedAt: new Date().toISOString(),
      }
      sessionStreams[streamId] = { ...existing, toolCalls: updated }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  updateToolCallSubagentProgress: (sessionId, streamId, callId, patch) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      if (!existing) return s
      const idx = existing.toolCalls.findIndex((tc) => tc.callId === callId)
      if (idx === -1) return s
      const tc = existing.toolCalls[idx]!
      const updated = [...existing.toolCalls]

      const iter = patch.iteration ?? 0
      // Размышления саб-агента: накапливаем по итерациям (как reasoningBlocks основного стрима).
      const reasoningBlocks = appendReasoningBlock(
        tc.subagentReasoningBlocks ?? [],
        patch.reasoning ?? '',
        iter,
      )
      // Промежуточный текст саб-агента.
      const intermediateTextBlocks = appendIntermediateBlock(
        tc.subagentIntermediateTextBlocks ?? [],
        patch.content ?? '',
        iter,
      )

      updated[idx] = { ...tc, subagentReasoningBlocks: reasoningBlocks, subagentIntermediateTextBlocks: intermediateTextBlocks }
      sessionStreams[streamId] = { ...existing, toolCalls: updated }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  finishStream: (sessionId, streamId, metadata) =>
    set((s) => {
      const streamFinishTickBySession = bumpStreamFinishTick(s.streamFinishTickBySession, sessionId)
      // ADR-070 §2.6: стрим завершён — live-вклад саб-агентов сессии больше не
      // актуален (итог приходит в metadata.subagents финального сообщения).
      const liveSubagentUsageBySession = { ...s.liveSubagentUsageBySession }
      delete liveSubagentUsageBySession[sessionId]
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const streamState = sessionStreams[streamId]
      // ADR-070 §2.6: status и top-level финальная статистика stream.done
      // (duration_ms/cost_usd/cost_breakdown/usage_estimated) доносим до metadata
      // сообщения — «Последний ответ» показывает финал сразу, без refetch.
      const doneMetadata: Record<string, unknown> = { ...(metadata.metadata || {}) }
      if (metadata.status !== undefined) doneMetadata.status = metadata.status
      if (metadata.duration_ms !== undefined) doneMetadata.duration_ms = metadata.duration_ms
      if (metadata.cost_usd !== undefined) doneMetadata.cost_usd = metadata.cost_usd
      if (metadata.cost_currency !== undefined) doneMetadata.cost_currency = metadata.cost_currency
      if (metadata.cost_breakdown !== undefined) doneMetadata.cost_breakdown = metadata.cost_breakdown
      if (metadata.usage_estimated !== undefined) doneMetadata.usage_estimated = metadata.usage_estimated
      const statusMetadata = Object.keys(doneMetadata).length > 0 ? doneMetadata : null
      if (!streamState) {
        console.warn(`[chatStore] finishStream: no stream state for ${streamId} in session ${sessionId}, adding message from metadata`)
        if (metadata.content && !metadata.cancelled) {
          const msgs = [...(s.messagesBySession[sessionId] || [])]
          const freeIndex = msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 1 : 0
          // Не занимаем index, принадлежащий другому сообщению (user-команде):
          // при коллизии уходим на следующий свободный.
          let targetIndex = metadata.message_index ?? freeIndex
          let existingIdx = msgs.findIndex((m) => m.index === targetIndex)
          if (existingIdx >= 0 && msgs[existingIdx]!.role === 'user') {
            existingIdx = -1
            targetIndex = freeIndex
          }
          const patch: MessageData = {
            index: targetIndex,
            id: metadata.message_id || undefined,
            role: 'assistant',
            content: metadata.content,
            model: metadata.model || undefined,
            provider: metadata.provider || undefined,
            usage: metadata.usage || undefined,
            metadata: statusMetadata,
            intermediate_text_blocks: metadata.intermediate_text_blocks || null,
            reasoning_blocks: metadata.reasoning_blocks || null,
            debug_data: metadata.debug_info || undefined,
            tool_calls: (metadata.debug_info?.tool_calls as Array<Record<string, unknown>>)?.map((tc: Record<string, unknown>) => ({
              name: tc.name as string,
              args: (tc.args as Record<string, unknown>) || {},
              id: tc.id as string | undefined,
              result: tc.result as { content: string; isError?: boolean; metadata?: Record<string, unknown> } | undefined,
              started_at: tc.started_at as string | undefined,
              completed_at: tc.completed_at as string | undefined,
              iteration: tc.iteration as number | undefined,
            })) || undefined,
            disabled: false,
            pinned: false,
            hidden: false,
            created_at: new Date().toISOString(),
          }
          if (existingIdx >= 0) {
            msgs[existingIdx] = { ...msgs[existingIdx]!, ...patch }
          } else {
            msgs.push(patch)
          }
          return {
            messagesBySession: { ...s.messagesBySession, [sessionId]: msgs },
            streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams },
            streamFinishTickBySession,
            liveSubagentUsageBySession,
          }
        }
        return { streamFinishTickBySession, liveSubagentUsageBySession }
      }

      if (!metadata.cancelled && (streamState.content || metadata.content)) {
        const msgs = [...(s.messagesBySession[sessionId] || [])]
        const fallbackIndex = msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 1 : 0
        // ADR-046 §7.1: index ответа берём из stream.done; при отсутствии —
        // следующий свободный. Раньше fallback был `+0` и совпадал с index
        // последнего (user-команды) сообщения, сталкивая ключи списка.
        let targetIndex = metadata.message_index ?? fallbackIndex
        const occupant = msgs.find((m) => m.index === targetIndex)
        // Сливать ответ можно только в assistant/summary/debug (message.added уже
        // добавил его). Коллизия с user-сообщением — уводим на свободный index.
        const existingIdx = occupant && occupant.role !== 'user' ? msgs.indexOf(occupant) : -1
        if (occupant && occupant.role === 'user') targetIndex = fallbackIndex

        const reasoningBlocks = metadata.reasoning_blocks
          || (streamState.reasoningBlocks.length > 0 ? streamState.reasoningBlocks : undefined)
        const reasoningJoined = reasoningBlocks
          ? reasoningBlocks.map((r) => r.text).join('\n\n---\n\n')
          : undefined

        const intermediateTextBlocks = metadata.intermediate_text_blocks
          || (streamState.intermediateTextBlocks.length > 0 ? streamState.intermediateTextBlocks : undefined)

        const newMsg: MessageData = {
          index: existingIdx >= 0 ? msgs[existingIdx]!.index : targetIndex,
          id: metadata.message_id || undefined,
          role: metadata.metadata?.type === 'summary' ? 'summary'
            : metadata.metadata?.type === 'debug_system_message' ? 'debug'
            : 'assistant',
          content: metadata.content || streamState.content,
          agent_role: streamState.agentRole || undefined,
          model: metadata.model,
          provider: metadata.provider || streamState.provider || undefined,
          usage: metadata.usage || undefined,
          reasoning: reasoningJoined,
          reasoning_blocks: reasoningBlocks || null,
          intermediate_text_blocks: intermediateTextBlocks || null,
          debug_data: metadata.debug_info || undefined,
          summary_of: metadata.metadata?.indices || null,
          metadata: statusMetadata,
          tool_calls: mapLiveToolCalls(streamState.toolCalls),
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }

        if (existingIdx >= 0) {
          // merge: update existing message with server content
          msgs[existingIdx] = {
            ...msgs[existingIdx]!,
            ...(metadata.message_id ? { id: metadata.message_id } : {}),
            content: metadata.content || streamState.content,
            reasoning: reasoningJoined,
            reasoning_blocks: reasoningBlocks || msgs[existingIdx]!.reasoning_blocks,
            intermediate_text_blocks: intermediateTextBlocks || msgs[existingIdx]!.intermediate_text_blocks,
            debug_data: metadata.debug_info || undefined,
            model: metadata.model || msgs[existingIdx]!.model,
            provider: metadata.provider || streamState.provider || msgs[existingIdx]!.provider,
            usage: metadata.usage || msgs[existingIdx]!.usage,
            summary_of: metadata.metadata?.indices || msgs[existingIdx]!.summary_of,
            // ADR-070 §2.6: не затираем metadata, пришедшую с message.added
            // (subagents/tool_results/secrets), — stream.done добавляет поверх
            // только status и финальную статистику.
            metadata: statusMetadata
              ? { ...(msgs[existingIdx]!.metadata || {}), ...statusMetadata }
              : msgs[existingIdx]!.metadata,
            tool_calls: mapLiveToolCalls(streamState.toolCalls) ?? msgs[existingIdx]!.tool_calls,
          }
        } else {
          msgs.push(newMsg)
        }

        // Disable summarized messages from indices
        if (metadata.metadata?.indices && Array.isArray(metadata.metadata.indices)) {
          for (const idx of metadata.metadata.indices) {
            const msgIdx = msgs.findIndex((m) => m.index === idx)
            if (msgIdx >= 0 && msgs[msgIdx] && !msgs[msgIdx]!.pinned) {
              msgs[msgIdx] = { ...msgs[msgIdx]!, disabled: true }
            }
          }
        }

        delete sessionStreams[streamId]
        return {
          streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams },
          messagesBySession: { ...s.messagesBySession, [sessionId]: msgs },
          streamFinishTickBySession,
          liveSubagentUsageBySession,
        }
      }

      delete sessionStreams[streamId]
      return {
        streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams },
        streamFinishTickBySession,
        liveSubagentUsageBySession,
      }
    }),

  cancelStream: (sessionId, streamId, status, extra) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      delete sessionStreams[streamId]
      // ADR-070 §2.6: stream.cancelled несёт status + usage/cost/usage_estimated —
      // если message.added уже добавил assistant-сообщение, сохраняем статистику
      // в него (по stream_id), чтобы отменённый ответ показывал токены/стоимость.
      const hasExtra = !!extra
        && (extra.usage !== undefined || extra.costUsd !== undefined || extra.usageEstimated !== undefined)
      let messagesBySession = s.messagesBySession
      if (status || hasExtra) {
        const msgs = s.messagesBySession[sessionId]
        if (msgs) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]!
            const meta = m.metadata as Record<string, unknown> | null | undefined
            if (m.role === 'assistant' && meta?.stream_id === streamId) {
              const next = [...msgs]
              next[i] = {
                ...m,
                ...(extra?.usage ? { usage: extra.usage } : {}),
                metadata: {
                  ...(m.metadata || {}),
                  ...(status ? { status } : {}),
                  ...(extra?.costUsd !== undefined ? { cost_usd: extra.costUsd } : {}),
                  ...(extra?.costCurrency !== undefined ? { cost_currency: extra.costCurrency } : {}),
                  ...(extra?.usageEstimated !== undefined ? { usage_estimated: extra.usageEstimated } : {}),
                },
              }
              messagesBySession = { ...s.messagesBySession, [sessionId]: next }
              break
            }
          }
        }
      }
      // ADR-070 §2.6: отмена завершает стрим — live-вклад саб-агентов сбрасываем.
      const liveSubagentUsageBySession = { ...s.liveSubagentUsageBySession }
      delete liveSubagentUsageBySession[sessionId]
      return {
        streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams },
        ...(messagesBySession !== s.messagesBySession ? { messagesBySession } : {}),
        streamFinishTickBySession: bumpStreamFinishTick(s.streamFinishTickBySession, sessionId),
        liveSubagentUsageBySession,
      }
    }),

  setStreamRetry: (sessionId, retry) =>
    set((s) => ({
      retryBySession: { ...s.retryBySession, [sessionId]: retry },
    })),

  setStreamRetrying: (sessionId, streamId, isRetrying) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      if (!existing) return s
      sessionStreams[streamId] = { ...existing, isRetrying }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

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
      // no-op если значение не меняется — иначе лишние перерендеры на каждом chunk
      if (prev === error || (prev === null && error === null)) return s
      if (prev && error && prev.streamId === error.streamId && prev.error === error.error && prev.errorType === error.errorType) return s
      return {
        finalErrorBySession: { ...s.finalErrorBySession, [sessionId]: error },
      }
    }),

  addMessage: (sessionId, message) =>
    set((s) => {
      const msgs = [...(s.messagesBySession[sessionId] || [])]
      // Upsert: повторный `message.added` (например, обновление metadata
      // user-команды после `commandPrompt`) не плодит копии. Ищем по index,
      // при отсутствии — по id (сообщения без index).
      let at = message.index != null ? msgs.findIndex((m) => m.index === message.index) : -1
      if (at === -1 && message.id) at = msgs.findIndex((m) => m.id === message.id)
      if (at === -1) {
        return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...msgs, message] } }
      }
      const prev = msgs[at]!
      msgs[at] = {
        ...prev,
        ...(message.id ? { id: message.id } : {}),
        role: message.role || prev.role,
        // Контент из message.added может быть усечён (500 симв.); не затираем
        // уже известный полный контент (например, после stream.done).
        content: prev.content || message.content,
        agent_role: message.agent_role ?? prev.agent_role,
        author: message.author ?? prev.author,
        model: message.model ?? prev.model,
        provider: message.provider ?? prev.provider,
        // metadata объединяем: сохраняем ранее известные поля (subagents/
        // tool_results/secrets) и добавляем пришедшие (commandPrompt и т.п.).
        metadata: { ...(prev.metadata ?? {}), ...(message.metadata ?? {}) },
      }
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: msgs } }
    }),

  setPendingMessages: (sessionId, pending) =>
    set((s) => ({
      pendingBySession: { ...s.pendingBySession, [sessionId]: pending },
    })),

  setQueueStalled: (sessionId, pendingCount) =>
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId]: { pendingCount, isStalled: true },
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
          [sessionId]: { pendingCount, isStalled: prev?.isStalled ?? false },
        },
      }
    }),

  addPendingMessage: (sessionId, msg) =>
    set((s) => {
      const pending = [...(s.pendingBySession[sessionId] || []), msg]
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  removeFirstPending: (sessionId) =>
    set((s) => {
      const pending = [...(s.pendingBySession[sessionId] || [])]
      pending.shift()
      return { pendingBySession: { ...s.pendingBySession, [sessionId]: pending } }
    }),

  clearSession: (sessionId) =>
    set((s) => {
      const messagesBySession = { ...s.messagesBySession }
      delete messagesBySession[sessionId]
      const streamingBySession = { ...s.streamingBySession }
      delete streamingBySession[sessionId]
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
      return { messagesBySession, streamingBySession, queueBySession, pendingBySession, retryBySession, subagentRetryBySession, subagentResumingBySession, finalErrorBySession, liveSubagentUsageBySession }
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

  openDebugModal: (sessionId, messageIndex) =>
    set({ debugModalSessionId: sessionId, debugModalMessageIndex: messageIndex }),

  closeDebugModal: () =>
    set({ debugModalSessionId: null, debugModalMessageIndex: null }),

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
          [sessionId]: { mode: true, indices: new Set<number>() },
        },
      }
    }),

  toggleMessageSelection: (sessionId, index) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current?.mode) return s
      const next = new Set(current.indices)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, indices: next },
        },
      }
    }),

  selectMessageRange: (sessionId, from, to) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current?.mode) return s
      const next = new Set(current.indices)
      const start = Math.min(from, to)
      const end = Math.max(from, to)
      for (let i = start; i <= end; i++) {
        next.add(i)
      }
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, indices: next },
        },
      }
    }),

  selectAllMessages: (sessionId) =>
    set((s) => {
      const current = s.selectionBySession[sessionId]
      if (!current?.mode) return s
      const msgs = s.messagesBySession[sessionId] || []
      const next = new Set<number>(msgs.map((m) => m.index))
      return {
        selectionBySession: {
          ...s.selectionBySession,
          [sessionId]: { mode: true, indices: next },
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
          [sessionId]: { ...current, indices: new Set<number>() },
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
