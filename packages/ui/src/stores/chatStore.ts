import { create } from 'zustand'
import type { StickyNoteData } from '@/lib/api/synthApi'

export type DebugData = Record<string, unknown>;

export interface ReasoningBlockData {
  text: string
  iteration: number
}

export interface IntermediateTextBlockData {
  text: string
  iteration: number
}

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

export interface StreamState {
  streamId: string
  agentRole: string | null
  content: string
  reasoningBlocks: ReasoningBlockData[]
  intermediateTextBlocks: IntermediateTextBlockData[]
  isStreaming: boolean
  /** true, когда пришёл первый непустой chunk (content или reasoning) — признак, что провайдер начал отвечать */
  hasContent: boolean
  isRetrying?: boolean
  model?: string
  provider?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number }
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
  cancelled?: boolean
  pending_count?: number
  metadata?: { type?: string; indices?: number[]; [key: string]: unknown }
  reasoning_blocks?: ReasoningBlockData[]
  intermediate_text_blocks?: IntermediateTextBlockData[]
}

export interface StreamError {
  streamId: string
  error: string
  errorType: string
  retryIn?: number
  retryCount: number
  maxRetries: number
  canRetry: boolean
  userCanRetry?: boolean
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

interface ChatStore {
  messagesBySession: Record<string, MessageData[]>
  streamingBySession: Record<string, Record<string, StreamState>>
  queueBySession: Record<string, QueueState>
  pendingBySession: Record<string, QueuedMessage[]>
  errorBySession: Record<string, StreamError | null>
  retryBySession: Record<string, StreamRetry | null>
  subagentRetryBySession: Record<string, SubagentRetryState | null>
  subagentResumingBySession: Record<string, SubagentResumeState | null>
  finalErrorBySession: Record<string, FinalStreamError | null>
  stickyNotesBySession: Record<string, StickyNoteData[]>
  summarizationPendingBySession: Record<string, boolean>
  debugModalSessionId: string | null
  debugModalMessageIndex: number | null

  selectionBySession: Record<string, { mode: boolean; indices: Set<number> }>

  setMessages: (sessionId: string, messages: MessageData[]) => void
  updateMessage: (sessionId: string, index: number, changes: Partial<MessageData>) => void
  startStream: (sessionId: string, streamId: string, agentRole: string | null, model?: string, provider?: string) => void
  updateStreamChunk: (sessionId: string, streamId: string, content: string, reasoning: string, model?: string, provider?: string, iteration?: number) => void
  addToolCall: (sessionId: string, streamId: string, tc: LiveToolCall) => void
  updateToolCallResult: (sessionId: string, streamId: string, callId: string, result: { content: string; isError?: boolean; metadata?: Record<string, unknown> }) => void
  updateToolCallSubagentProgress: (sessionId: string, streamId: string, callId: string, patch: { reasoning?: string; content?: string; iteration?: number }) => void
  finishStream: (sessionId: string, streamId: string, metadata: StreamDoneMetadata) => void
  cancelStream: (sessionId: string, streamId: string) => void
  addStreamError: (sessionId: string, error: StreamError) => void
  clearStreamError: (sessionId: string) => void
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
  streamingBySession: {},
  queueBySession: {},
  pendingBySession: {},
  errorBySession: {},
  retryBySession: {},
  subagentRetryBySession: {},
  subagentResumingBySession: {},
  finalErrorBySession: {},
  stickyNotesBySession: {},
  summarizationPendingBySession: {},
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
      let nextBlocks = existing.reasoningBlocks
      if (reasoning && reasoning.trim()) {
        const iter = iteration ?? existing.toolIteration
        if (nextBlocks.length === 0) {
          nextBlocks = [{ text: reasoning, iteration: iter }];
        } else {
          const last = nextBlocks[nextBlocks.length - 1]!;
          if (last.iteration === iter && reasoning.length >= last.text.length) {
            nextBlocks = [...nextBlocks.slice(0, -1), { ...last, text: reasoning }];
          } else {
            nextBlocks = [...nextBlocks, { text: reasoning, iteration: iter }];
          }
        }
      }
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

      // Размышления саб-агента: накапливаем по итерациям (как reasoningBlocks основного стрима).
      let reasoningBlocks = tc.subagentReasoningBlocks ? [...tc.subagentReasoningBlocks] : []
      if (patch.reasoning && patch.reasoning.trim()) {
        const iter = patch.iteration ?? 0
        if (reasoningBlocks.length === 0) {
          reasoningBlocks = [{ text: patch.reasoning, iteration: iter }]
        } else {
          const last = reasoningBlocks[reasoningBlocks.length - 1]!
          if (last.iteration === iter && patch.reasoning.length >= last.text.length) {
            reasoningBlocks = [...reasoningBlocks.slice(0, -1), { ...last, text: patch.reasoning }]
          } else {
            reasoningBlocks = [...reasoningBlocks, { text: patch.reasoning, iteration: iter }]
          }
        }
      }

      // Промежуточный текст саб-агента.
      let intermediateTextBlocks = tc.subagentIntermediateTextBlocks ? [...tc.subagentIntermediateTextBlocks] : []
      if (patch.content && patch.content.trim()) {
        const iter = patch.iteration ?? 0
        const lastText = intermediateTextBlocks[intermediateTextBlocks.length - 1]
        if (lastText && lastText.iteration === iter) {
          intermediateTextBlocks = [...intermediateTextBlocks.slice(0, -1), { ...lastText, text: patch.content }]
        } else {
          intermediateTextBlocks = [...intermediateTextBlocks, { text: patch.content, iteration: iter }]
        }
      }

      updated[idx] = { ...tc, subagentReasoningBlocks: reasoningBlocks, subagentIntermediateTextBlocks: intermediateTextBlocks }
      sessionStreams[streamId] = { ...existing, toolCalls: updated }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  finishStream: (sessionId, streamId, metadata) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const streamState = sessionStreams[streamId]
      if (!streamState) {
        console.warn(`[chatStore] finishStream: no stream state for ${streamId} in session ${sessionId}, adding message from metadata`)
        if (metadata.content && !metadata.cancelled) {
          const msgs = [...(s.messagesBySession[sessionId] || [])]
          const fallbackIndex = metadata.message_index ?? (msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 1 : 0)
          msgs.push({
            index: fallbackIndex,
            role: 'assistant',
            content: metadata.content,
            model: metadata.model || undefined,
            usage: metadata.usage || undefined,
            metadata: metadata.metadata || null,
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
          })
          return {
            messagesBySession: { ...s.messagesBySession, [sessionId]: msgs },
            streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams },
          }
        }
        return s
      }

      if (!metadata.cancelled && (streamState.content || metadata.content)) {
        const msgs = [...(s.messagesBySession[sessionId] || [])]
        const nextIndex = metadata.message_index
        const existingIdx = nextIndex != null ? msgs.findIndex((m) => m.index === nextIndex) : -1

        const reasoningBlocks = metadata.reasoning_blocks
          || (streamState.reasoningBlocks.length > 0 ? streamState.reasoningBlocks : undefined)
        const reasoningJoined = reasoningBlocks
          ? reasoningBlocks.map((r) => r.text).join('\n\n---\n\n')
          : undefined

        const intermediateTextBlocks = metadata.intermediate_text_blocks
          || (streamState.intermediateTextBlocks.length > 0 ? streamState.intermediateTextBlocks : undefined)

        const newMsg: MessageData = {
          index: nextIndex ?? (msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 0 : 0),
          role: metadata.metadata?.type === 'summary' ? 'summary'
            : metadata.metadata?.type === 'debug_system_message' ? 'debug'
            : 'assistant',
          content: metadata.content || streamState.content,
          agent_role: streamState.agentRole || undefined,
          model: metadata.model,
          provider: streamState.provider || undefined,
          usage: metadata.usage || undefined,
          reasoning: reasoningJoined,
          reasoning_blocks: reasoningBlocks || null,
          intermediate_text_blocks: intermediateTextBlocks || null,
          debug_data: metadata.debug_info || undefined,
          summary_of: metadata.metadata?.indices || null,
          metadata: metadata.metadata || null,
          tool_calls: streamState.toolCalls.length > 0
            ? streamState.toolCalls.map((tc) => ({
                name: tc.name,
                args: tc.args,
                id: tc.callId,
                result: tc.result,
                started_at: tc.startedAt,
                completed_at: tc.completedAt,
                iteration: tc.iteration,
              }))
            : null,
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }

        if (existingIdx >= 0) {
          // merge: update existing message with server content
          msgs[existingIdx] = {
            ...msgs[existingIdx]!,
            content: metadata.content || streamState.content,
            reasoning: reasoningJoined,
            reasoning_blocks: reasoningBlocks || msgs[existingIdx]!.reasoning_blocks,
            intermediate_text_blocks: intermediateTextBlocks || msgs[existingIdx]!.intermediate_text_blocks,
            debug_data: metadata.debug_info || undefined,
            model: metadata.model || msgs[existingIdx]!.model,
            provider: streamState.provider || msgs[existingIdx]!.provider,
            usage: metadata.usage || msgs[existingIdx]!.usage,
            summary_of: metadata.metadata?.indices || msgs[existingIdx]!.summary_of,
            metadata: metadata.metadata || msgs[existingIdx]!.metadata,
            tool_calls: streamState.toolCalls.length > 0
              ? streamState.toolCalls.map((tc) => ({
                  name: tc.name,
                  args: tc.args,
                  id: tc.callId,
                  result: tc.result,
                  started_at: tc.startedAt,
                  completed_at: tc.completedAt,
                  iteration: tc.iteration,
                }))
              : msgs[existingIdx]!.tool_calls,
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
        }
      }

      delete sessionStreams[streamId]
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  cancelStream: (sessionId, streamId) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      delete sessionStreams[streamId]
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  addStreamError: (sessionId, error) =>
    set((s) => ({
      errorBySession: { ...s.errorBySession, [sessionId]: error },
    })),

  clearStreamError: (sessionId) =>
    set((s) => ({
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    })),

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
      if (msgs.find((m) => m.index === message.index)) return s
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: [...msgs, message] },
      }
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
      const errorBySession = { ...s.errorBySession }
      delete errorBySession[sessionId]
      const retryBySession = { ...s.retryBySession }
      delete retryBySession[sessionId]
      const subagentRetryBySession = { ...s.subagentRetryBySession }
      delete subagentRetryBySession[sessionId]
      const subagentResumingBySession = { ...s.subagentResumingBySession }
      delete subagentResumingBySession[sessionId]
      const finalErrorBySession = { ...s.finalErrorBySession }
      delete finalErrorBySession[sessionId]
      return { messagesBySession, streamingBySession, queueBySession, pendingBySession, errorBySession, retryBySession, subagentRetryBySession, subagentResumingBySession, finalErrorBySession }
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
