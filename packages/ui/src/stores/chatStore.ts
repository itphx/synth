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
}

export interface StreamState {
  streamId: string
  agentRole: string | null
  content: string
  reasoningBlocks: ReasoningBlockData[]
  intermediateTextBlocks: IntermediateTextBlockData[]
  isStreaming: boolean
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
  metadata?: { type?: string; indices?: number[] }
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
  stickyNotesBySession: Record<string, StickyNoteData[]>
  summarizationPendingBySession: Record<string, boolean>
  debugModalSessionId: string | null
  debugModalMessageIndex: number | null

  setMessages: (sessionId: string, messages: MessageData[]) => void
  updateMessage: (sessionId: string, index: number, changes: Partial<MessageData>) => void
  startStream: (sessionId: string, streamId: string, agentRole: string | null, model?: string, provider?: string) => void
  updateStreamChunk: (sessionId: string, streamId: string, content: string, reasoning: string, model?: string, provider?: string, iteration?: number) => void
  addToolCall: (sessionId: string, streamId: string, tc: LiveToolCall) => void
  updateToolCallResult: (sessionId: string, streamId: string, callId: string, result: { content: string; isError?: boolean; metadata?: Record<string, unknown> }) => void
  finishStream: (sessionId: string, streamId: string, metadata: StreamDoneMetadata) => void
  cancelStream: (sessionId: string, streamId: string) => void
  addStreamError: (sessionId: string, error: StreamError) => void
  clearStreamError: (sessionId: string) => void
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
}

export const useChatStore = create<ChatStore>((set) => ({
  messagesBySession: {},
  streamingBySession: {},
  queueBySession: {},
  pendingBySession: {},
  errorBySession: {},
  stickyNotesBySession: {},
  summarizationPendingBySession: {},
  debugModalSessionId: null,
  debugModalMessageIndex: null,
  retryInputBySession: {},

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
      sessionStreams[streamId] = {
        ...existing,
        content: existing.content + content,
        reasoningBlocks: nextBlocks,
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
      sessionStreams[streamId] = {
        ...existing,
        toolCalls: [...existing.toolCalls, tc],
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
      return { messagesBySession, streamingBySession, queueBySession, pendingBySession, errorBySession }
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
}))
