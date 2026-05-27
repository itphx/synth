import { create } from 'zustand'
import type { StickyNoteData } from '@/lib/api/synthApi'

export type DebugData = Record<string, unknown>;

export interface MessageData {
  index: number
  role: string
  content: string
  tool_calls?: Array<{ name: string; args: Record<string, unknown>; id?: string }> | null
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
  source?: string | null
  author?: string | null
  agent_role?: string | null
  summary_of?: number[] | null
  metadata?: Record<string, unknown> | null
  created_at: string
  timestamp?: string
}

export interface StreamState {
  streamId: string
  agentRole: string | null
  content: string
  reasoning: string
  isStreaming: boolean
  model?: string
  provider?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number }
}

export interface StreamDoneMetadata {
  model?: string
  content?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number }
  debug_info?: Record<string, unknown> | null
  message_index?: number
  cancelled?: boolean
  pending_count?: number
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
  debugModalSessionId: string | null
  debugModalMessageIndex: number | null

  setMessages: (sessionId: string, messages: MessageData[]) => void
  updateMessage: (sessionId: string, index: number, changes: Partial<MessageData>) => void
  startStream: (sessionId: string, streamId: string, agentRole: string | null, model?: string, provider?: string) => void
  updateStreamChunk: (sessionId: string, streamId: string, content: string, reasoning: string, model?: string, provider?: string) => void
  finishStream: (sessionId: string, streamId: string, metadata: StreamDoneMetadata) => void
  cancelStream: (sessionId: string, streamId: string) => void
  addStreamError: (sessionId: string, error: StreamError) => void
  clearStreamError: (sessionId: string) => void
  addMessage: (sessionId: string, message: MessageData) => void
  setPendingMessages: (sessionId: string, pending: QueuedMessage[]) => void
  setQueueStalled: (sessionId: string, pendingCount: number) => void
  clearQueueState: (sessionId: string) => void
  clearSession: (sessionId: string) => void
  setStickyNotes: (sessionId: string, notes: StickyNoteData[]) => void
  addStickyNote: (sessionId: string, note: StickyNoteData) => void
  updateStickyNote: (sessionId: string, noteId: string, changes: Partial<StickyNoteData>) => void
  deleteStickyNote: (sessionId: string, noteId: string) => void
  openDebugModal: (sessionId: string, messageIndex: number) => void
  closeDebugModal: () => void

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
        reasoning: '',
        isStreaming: true,
        model,
        provider,
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  updateStreamChunk: (sessionId, streamId, content, reasoning, model, provider) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const existing = sessionStreams[streamId]
      if (!existing) return s
      sessionStreams[streamId] = {
        ...existing,
        content: existing.content + content,
        reasoning: reasoning || existing.reasoning,
        model: model || existing.model,
        provider: provider || existing.provider,
      }
      return { streamingBySession: { ...s.streamingBySession, [sessionId]: sessionStreams } }
    }),

  finishStream: (sessionId, streamId, metadata) =>
    set((s) => {
      const sessionStreams = { ...(s.streamingBySession[sessionId] || {}) }
      const streamState = sessionStreams[streamId]
      if (!streamState) return s

      if (!metadata.cancelled && (streamState.content || metadata.content)) {
        const msgs = [...(s.messagesBySession[sessionId] || [])]
        const nextIndex = metadata.message_index
        const existingIdx = nextIndex != null ? msgs.findIndex((m) => m.index === nextIndex) : -1

        const newMsg: MessageData = {
          index: nextIndex ?? (msgs.length > 0 ? Math.max(...msgs.map((m) => m.index)) + 0 : 0),
          role: 'assistant',
          content: metadata.content || streamState.content,
          agent_role: streamState.agentRole || undefined,
          model: metadata.model,
          provider: streamState.provider || undefined,
          usage: metadata.usage || undefined,
          reasoning: streamState.reasoning || undefined,
          debug_data: metadata.debug_info || undefined,
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }

        if (existingIdx >= 0) {
          // merge: update existing message with server content
          msgs[existingIdx] = { ...msgs[existingIdx]!, content: metadata.content || streamState.content, reasoning: streamState.reasoning || undefined, debug_data: metadata.debug_info || undefined, provider: streamState.provider || msgs[existingIdx]!.provider }
        } else {
          msgs.push(newMsg)
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
      const next = { ...s.queueBySession }
      delete next[sessionId]
      return { queueBySession: next }
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
