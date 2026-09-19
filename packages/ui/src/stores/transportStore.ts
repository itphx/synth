import { create } from 'zustand'
import { TransportClient, type WSEvent, type TransportKind } from '@/lib/api/transport'
import { useChatStore } from './chatStore'
import { useSessionsStore } from './sessionsStore'
import { useUIStore } from './useUIStore'
import { usePermissionStore, PERMISSION_ASK_TIMEOUT_MS } from './permissionStore'
import type { TransportMode } from './useUIStore'
import type { StreamDoneMetadata, MessageData, MessageStatus } from './chatStore'
import { synthApi } from '@/lib/api/synthApi'
import type { SessionData } from '@/lib/api/synthApi'
import { notifyMessage } from '@/hooks/useNotification'

type EventDispatcher = (event: WSEvent) => void

// Полный refresh сессии с сервера после событий плана/ToDo (plan.approved,
// plan.updated, todos.updated). Гарантирует актуальность todos/mode/plan_approved
// в сторе независимо от содержимого payload события.
function refreshSessionFromApi(sid: string) {
  synthApi.getSession(sid)
    .then((sess) => useSessionsStore.getState().upsertSession(sess))
    .catch(() => {})
}

interface TransportState {
  transportMode: TransportMode
  activeTransport: TransportKind
  connected: boolean
  openSessions: Set<string>

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => void
  disconnect: () => void
  setTransportMode: (mode: TransportMode) => void
  sendMessage: (sessionId: string, text: string, agentRole?: string, provider?: string, model?: string) => Promise<void>
  cancel: (sessionId: string) => void
  sendPermissionReply: (sessionId: string, approvalId: string, approved: boolean, once?: boolean) => void
  sendPermissionHold: (sessionId: string, approvalId: string) => void
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
    if (!sid) return

    const {
      addMessage,
      startStream,
      updateStreamChunk,
      finishStream,
      cancelStream,
      clearStreamError,
      setStreamRetry,
      setStreamRetrying,
      setQueueStalled,
      setSummarizationPending,
      updateQueueCount,
      addPendingMessage,
      removeFirstPending,
      addToolCall,
      updateToolCallResult,
      updateToolCallSubagentProgress,
      setSubagentRetry,
      setSubagentResuming,
      setFinalStreamError,
    } = useChatStore.getState()

    switch (type) {
      case 'message_queued':
      case 'message.queued': {
        const content = (payload.message as string) || ''
        const agentRole = payload.agent_role as string | undefined
        const pendingCount = (payload.pending_count as number) || 1
        addPendingMessage(sid, { content, agentRole: agentRole || null })
        updateQueueCount(sid, pendingCount)
        break
      }

      case 'message_added':
      case 'message.added': {
        const msg: MessageData = {
          index: payload.message_index as number,
          role: (payload.role as string) || 'assistant',
          content: (payload.content as string) || '',
          agent_role: payload.agent_role as string | undefined,
          author: payload.author as string | undefined,
          model: payload.model as string | undefined,
          provider: payload.provider as string | undefined,
          reasoning: (payload.reasoning as string) || undefined,
          intermediate_text_blocks: payload.intermediate_text_blocks as Array<{ text: string; iteration: number }> | undefined,
          tool_calls: (payload.tool_calls as MessageData['tool_calls']) ?? null,
          metadata: payload.metadata as Record<string, unknown> | undefined,
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }
        addMessage(sid, msg)
        break
      }

      case 'stream_start':
      case 'stream.start': {
        const agentRole = (payload.agent_role as string) || null
        const metadata = payload.metadata as Record<string, unknown> | undefined
        startStream(sid, payload.stream_id as string, agentRole, payload.model as string | undefined, payload.provider as string | undefined)
        // Новая попытка — сбрасываем статус ретрая предыдущей
        setStreamRetry(sid, null)
        // Новый стрим — плашка финальной ошибки больше не актуальна
        setFinalStreamError(sid, null)
        if (metadata?.type === 'summary') {
          const s = useChatStore.getState()
          const sessionStreams = { ...(s.streamingBySession[sid] || {}) }
          const streamId = payload.stream_id as string
          if (sessionStreams[streamId]) {
            sessionStreams[streamId] = { ...sessionStreams[streamId]!, agentRole: 'summary' }
            useChatStore.setState({ streamingBySession: { ...s.streamingBySession, [sid]: sessionStreams } })
          }
        }

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

      case 'stream_chunk':
      case 'stream.chunk': {
        const streamId = payload.stream_id as string
        // Стрим реально пошёл после ретрая — сбрасываем «зависшую» надпись о
        // повторе (stream.done мог не дойти/быть потерян при разрыве транспорта).
        const retry = useChatStore.getState().retryBySession[sid]
        const streamState = useChatStore.getState().streamingBySession[sid]?.[streamId]
        if (retry && (retry.streamId === streamId || streamState?.isRetrying)) {
          setStreamRetry(sid, null)
          setStreamRetrying(sid, streamId, false)
        }
        // Чанки идут — финальная ошибка прошлой попытки больше не актуальна
        setFinalStreamError(sid, null)
        updateStreamChunk(
          sid,
          streamId,
          (payload.content as string) || '',
          (payload.reasoning as string) || '',
          payload.model as string | undefined,
          payload.provider as string | undefined,
          payload.iteration as number | undefined,
        )
        break
      }

      case 'stream_done':
      case 'stream.done': {
        const metadata: StreamDoneMetadata = {
          model: payload.model as string | undefined,
          content: payload.content as string | undefined,
          usage: payload.usage
            ? {
                input_tokens: (payload.usage as Record<string, number>).inputTokens || 0,
                output_tokens: (payload.usage as Record<string, number>).outputTokens || 0,
                total_tokens: (payload.usage as Record<string, number>).totalTokens || 0,
                cache_read_tokens: (payload.usage as Record<string, number>).cacheReadTokens,
                cache_write_tokens: (payload.usage as Record<string, number>).cacheWriteTokens,
                reasoning_tokens: (payload.usage as Record<string, number>).reasoningTokens,
              }
            : undefined,
          debug_info: payload.debug_info as Record<string, unknown> | undefined,
          message_index: payload.message_index as number | undefined,
          cancelled: payload.cancelled as boolean | undefined,
          pending_count: payload.pending_count as number | undefined,
          status: payload.status as MessageStatus | undefined,
          metadata: payload.metadata as { type?: string; indices?: number[]; [key: string]: unknown } | undefined,
          reasoning_blocks: (payload.reasoning_blocks as Array<{ text: string; iteration: number }>) || undefined,
          intermediate_text_blocks: (payload.intermediate_text_blocks as Array<{ text: string; iteration: number }>) || undefined,
        }
        finishStream(sid, payload.stream_id as string, metadata)
        setStreamRetry(sid, null)
        clearStreamError(sid)
        setFinalStreamError(sid, null)

        const pendingCount = payload.pending_count as number | undefined
        if (pendingCount !== undefined && pendingCount > 0) {
          updateQueueCount(sid, pendingCount)
        } else if (pendingCount === 0) {
          useChatStore.getState().clearQueueState(sid)
        }
        break
      }

      case 'stream_cancelled':
      case 'stream.cancelled': {
        cancelStream(sid, payload.stream_id as string, payload.status as MessageStatus | undefined)
        setStreamRetry(sid, null)
        break
      }

      case 'stream_error':
      case 'stream.error': {
        const streamId = payload.stream_id as string
        const errorType = (payload.error_type as string) || ''
        const rawError = (payload.error as string) || 'Unknown error'
        const canRetry = Boolean(payload.can_retry)

        if (canRetry) {
          // Recoverable-ошибка: бэкенд продолжит ретраи. Стрим НЕ завершаем,
          // ничего пользователю не показываем — статус ретрая придёт событием
          // stream.retry (отобразится в user-сообщении).
          break
        }

        // Ошибка переполнения контекстного окна — показываем дружелюбный текст
        // вместо сырого сообщения провайдера.
        const error = errorType === 'context_length'
          ? 'Контекстное окно модели превышено. Начните новую сессию или сократите историю'
          : rawError

        // Финальная ошибка (неrecoverable / исчерпаны попытки / отменено):
        // завершаем стрим, убираем ретраи и индикатор обработки, показываем
        // стандартное уведомление (toast + история) и плашку над полем ввода
        // с возможностью повторить (для recoverable error_type — см. StreamErrorPanel).
        setStreamRetry(sid, null)
        setStreamRetrying(sid, streamId, false)
        cancelStream(sid, streamId)
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
        setStreamRetrying(sid, streamId, true)
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
          const hasStream = Object.values(useChatStore.getState().streamingBySession[sid] || {}).some((s) => s.isStreaming)
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

        usePermissionStore.getState().addRequest(sid, {
          approvalId,
          toolName,
          params,
          reason,
          askedAt: new Date().toISOString(),
          timeoutMs,
        })
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

      // План утверждён (AD-039): план живёт в проекте (project.plan), событие
      // plan.approved несёт только session_id/project_id — достаточно полного
      // refresh сессии (план проекта рендерится во вкладке «Проект» отдельно).
      case 'plan.approved':
      case 'plan.updated': {
        refreshSessionFromApi(sid)
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
          }))
        }
        break
      }

      case 'session.deleted': {
        const deletedId = (payload.session_id as string) || sid
        useSessionsStore.setState((s) => ({
          sessions: s.sessions.filter((sess) => sess.id !== deletedId),
        }))
        useUIStore.getState().closeTab(`chat-${deletedId}`)
        break
      }

      case 'tool_call.started':
      case 'tool_call_started': {
        const streamId = payload.stream_id as string
        if (!streamId) break
        // Комментарий/текст модели перед вызовом тула (например, «Запускаю сабагента…»)
        // коммитим в intermediateTextBlocks на итерации тула сразу, а не только в
        // tool_call.loop (который срабатывает ПОСЛЕ завершения итерации). Иначе этот
        // текст до конца работы тула висит в displayContent внизу блока и ломает
        // порядок (комментарий оказывается ниже блока сабагента).
        if (!payload.parent_call_id) {
          useChatStore.setState((s) => {
            const sessionStreams = { ...(s.streamingBySession[sid] || {}) }
            const existing = sessionStreams[streamId]
            if (!existing) return s
            const iteration = (payload.iteration as number) || 0
            const segmentText = existing.content.slice(existing._lastContentLen)
            const nextBlocks = segmentText.trim()
              ? [...existing.intermediateTextBlocks, { text: segmentText, iteration }]
              : existing.intermediateTextBlocks
            const prevLen = existing.content.length
            sessionStreams[streamId] = {
              ...existing,
              intermediateTextBlocks: nextBlocks,
              _lastContentLen: prevLen,
            }
            return { streamingBySession: { ...s.streamingBySession, [sid]: sessionStreams } }
          })
        }
        addToolCall(sid, streamId, {
          callId: payload.call_id as string,
          name: payload.name as string,
          args: (payload.arguments as Record<string, unknown>) || {},
          status: 'running',
          startedAt: new Date().toISOString(),
          iteration: (payload.iteration as number) || 0,
          parentCallId: payload.parent_call_id as string | undefined,
        })
        break
      }

      case 'tool_call.result':
      case 'tool_call_result': {
        const streamId = payload.stream_id as string
        if (!streamId) break
        updateToolCallResult(sid, streamId, payload.call_id as string, {
          content: (payload.result as Record<string, unknown>)?.content as string || '',
          isError: (payload.result as Record<string, unknown>)?.isError as boolean,
          metadata: (payload.result as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined,
        })
        // Тул завершён (в т.ч. isError) — статус ожидания ретрая этого саб-агента снят
        const taskRetry = useChatStore.getState().subagentRetryBySession[sid]
        if (taskRetry && taskRetry.callId && taskRetry.callId === (payload.call_id as string)) {
          setSubagentRetry(sid, null)
        }
        break
      }

      case 'subagent.progress':
      case 'subagent_progress': {
        // Стриминг размышлений/промежуточного текста саб-агента родителю —
        // вкладываются в блок `task` (по parent_call_id, т.е. call_id задачи).
        const streamId = payload.stream_id as string
        if (!streamId) break
        updateToolCallSubagentProgress(
          sid,
          streamId,
          (payload.parent_call_id as string) || '',
          {
            reasoning: (payload.reasoning as string) || '',
            content: (payload.content as string) || '',
            iteration: (payload.iteration as number) || 0,
          },
        )
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

      case 'tool_call.loop':
      case 'tool_call_loop': {
        const streamId = payload.stream_id as string
        if (!streamId) break
        const iteration = (payload.iteration as number) || 0
        useChatStore.setState((s) => {
          const sessionStreams = { ...(s.streamingBySession[sid] || {}) }
          const existing = sessionStreams[streamId]
          if (!existing) return s

          const segmentText = existing.content.slice(existing._lastContentLen)
          const nextBlocks = segmentText.trim()
            ? [...existing.intermediateTextBlocks, { text: segmentText, iteration: existing.toolIteration }]
            : existing.intermediateTextBlocks

          const prevLen = existing.content.length
          sessionStreams[streamId] = {
            ...existing,
            content: existing.content + '\n\n',
            intermediateTextBlocks: nextBlocks,
            toolIteration: iteration,
            _lastContentLen: prevLen + 2,
          }
          return { streamingBySession: { ...s.streamingBySession, [sid]: sessionStreams } }
        })
        break
      }

      case 'context.summarization_pending': {
        setSummarizationPending(sid, true)
        break
      }

      case 'context.sliding_window_applied': {
        const indices = payload.disabled_indices as number[] | undefined
        if (indices && Array.isArray(indices) && indices.length > 0) {
          const { updateMessage } = useChatStore.getState()
          for (const idx of indices) {
            updateMessage(sid, idx, { disabled: true })
          }
        } else {
          synthApi.getSessionMessages(sid).then((r) => {
            useChatStore.getState().setMessages(sid, r.messages)
          }).catch(() => {})
        }
        break
      }

      case 'message.quality_check': {
        const msgIndex = payload.message_index as number | undefined
        if (msgIndex != null) {
          useChatStore.getState().updateMessage(sid, msgIndex, {
            qa_pass: payload.qa_pass as boolean | undefined,
            qa_reason: payload.qa_reason as string | undefined,
          })
        }
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

export function isTransportConnected(): boolean {
  return transportReady
}

// Очистка при HMR (hot module replacement)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    transport?.disconnect();
    transport = null;
    transportReady = false;
  });
}

export const useTransportStore = create<TransportState>()((set, get) => ({
  transportMode: 'auto',
  activeTransport: 'disconnected',
  connected: false,
  openSessions: new Set(),

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => {
    transport?.disconnect()
    transport = null
    transportReady = false

    const actualMode = override || (mode === 'sse' ? 'sse' as const : 'ws' as const)
    console.debug('[TransportStore] Connecting:', actualMode, '(mode=', mode, ')')
    const dispatcher = createDispatcher()

    const client = new TransportClient({
      onEvent: dispatcher,
      onConnect: () => {
        if (actualMode === 'sse') {
          transportReady = true
          set({ connected: true, activeTransport: 'sse' })
          console.debug('[TransportStore] Connected (SSE):', client.getTransport())
        } else {
          // WS: сокет открыт, но backend ещё не зарегистрировал клиента
          set({ connected: true })
          console.debug('[TransportStore] WS socket open, waiting for backend ready...')
        }
      },
      onBackendReady: () => {
        transportReady = true
        set({ connected: true, activeTransport: 'ws' })
        console.debug('[TransportStore] Backend ready:', client.getTransport())
      },
      onDisconnect: (reason) => {
        transportReady = false
        set({ connected: false })
        console.debug('[TransportStore] Disconnected:', reason)

        if (reason === 'manual') {
          return
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
      onTransportSwitch: () => {},
    })

    client.connect(actualMode)
    transport = client
  },

  disconnect: () => {
    transport?.disconnect()
    transport = null
    transportReady = false
    set({ connected: false, activeTransport: 'disconnected' })
  },

  setTransportMode: (mode: TransportMode) => {
    const state = get()

    console.debug('[TransportStore] Switching mode:', state.transportMode, '→', mode)
    set({ transportMode: mode })
    get().connect(mode)
  },

  sendMessage: async (sessionId, text, agentRole, provider, model) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendMessage via WS:', sessionId)
      await transport.sendMessage(sessionId, text, agentRole, provider, model)
    } else {
      console.debug('[TransportStore] sendMessage via HTTP POST:', sessionId, `(ready=${transportReady}, transport=${transport?.getTransport()})`)
      await synthApi.enqueueMessage(sessionId, text, { agentRole, model, provider })
    }
  },

  cancel: (sessionId) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] cancel via WS:', sessionId)
      transport.cancel(sessionId)
    } else {
      console.debug('[TransportStore] cancel via HTTP POST:', sessionId)
      synthApi.stopGeneration(sessionId).catch(() => {})
    }
  },

  sendPermissionReply: (sessionId, approvalId, approved, once) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendPermissionReply via WS:', sessionId, approvalId, approved, once)
      transport.sendPermissionReply(sessionId, approvalId, approved, once)
    } else {
      // Нет WS-соединения: backend сам сбросит ask по таймауту.
      console.warn('[TransportStore] sendPermissionReply: WS not connected, request will time out', sessionId, approvalId)
    }
  },

  sendPermissionHold: (sessionId, approvalId) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendPermissionHold via WS:', sessionId, approvalId)
      transport.sendPermissionHold(sessionId, approvalId)
    } else {
      // Нет WS-соединения: остановить таймер не получится — сохраняем hold локально,
      // бэкенд сбросит ask по таймауту.
      console.warn('[TransportStore] sendPermissionHold: WS not connected', sessionId, approvalId)
    }
  },

  markSessionOpen: (sid) => {
    const next = new Set(get().openSessions)
    next.add(sid)
    set({ openSessions: next })
  },

  markSessionClosed: (sid) => {
    const next = new Set(get().openSessions)
    next.delete(sid)
    set({ openSessions: next })
  },
}))
