import { create } from 'zustand'
import { TransportClient, type WSEvent, type TransportKind } from '@/lib/api/transport'
import { useChatStore } from './chatStore'
import { useSessionsStore } from './sessionsStore'
import { useProjectsStore } from './projectsStore'
import { useGitStore } from './gitStore'
import { useFilesStore } from './filesStore'
import { useUIStore } from './useUIStore'
import { usePermissionStore, PERMISSION_ASK_TIMEOUT_MS } from './permissionStore'
import { useSkillsStore } from './skillsStore'
import { useInstructionsStore } from './instructionsStore'
import { usePipelinesStore } from './pipelinesStore'
import type { TransportMode } from './useUIStore'
import type { StreamDoneMetadata, MessageData, MessageStatus, CostBreakdown } from './chatStore'
import { synthApi } from '@/lib/api/synthApi'
import type { SessionData } from '@/lib/api/synthApi'
import { notifyMessage } from '@/hooks/useNotification'
import { i18nText } from '@/lib/i18n/text'
import type { SteerMode } from '@itphx/synth-shared/types'

type EventDispatcher = (event: WSEvent) => void

// Полный refresh сессии с сервера после событий плана/ToDo (plan.approved,
// plan.updated, todos.updated). Гарантирует актуальность todos/mode/plan_approved
// в сторе независимо от содержимого payload события.
function refreshSessionFromApi(sid: string) {
  synthApi.getSession(sid)
    .then((sess) => useSessionsStore.getState().upsertSession(sess))
    .catch(() => {})
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

interface TransportState {
  transportMode: TransportMode
  activeTransport: TransportKind
  connected: boolean
  openSessions: Set<string>

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => void
  disconnect: () => void
  setTransportMode: (mode: TransportMode) => void
  /** `mode` — PROP-098: режим отправки (`queue` по умолчанию, `steer` — вмешательство, `interrupt` — прерывание). */
  sendMessage: (sessionId: string, text: string, agentRole?: string, provider?: string, model?: string, mode?: SteerMode) => Promise<void>
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

    // ADR-101 §2.12.3: события прогона пайплайна (`pipeline.run.*`) публикуются
    // в **инстансный** канал шины — у них нет сессии (`sessionId` = 'instance'
    // или пусто). Обрабатываем ДО проверки `sid`, иначе они отбрасывались бы
    // как «бессессионные» (инвариант 6: новых транспортных каналов не заводим).
    if (type.startsWith('pipeline.')) {
      usePipelinesStore.getState().applyRunEvent(payload)
      return
    }

    const sid = (event.sessionId as string)
      || (event.session_id as string)
      || (payload.session_id as string)
    if (!sid) return

    const {
      addMessage,
      startStream,
      updateStreamChunk,
      updateStreamUsage,
      resetStreamAccumulator,
      clearUsageStream,
      updateLiveSubagentUsage,
      finishStream,
      cancelStream,
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
        // События родителя — плоские поля; события дочерней сессии
        // (`publishMessageAdded` в task.ts) несут сериализованное сообщение во
        // вложенном `message` (+ top-level `index`). Без разворачивания вложенный
        // payload давал фантомное пустое сообщение с index: undefined.
        const nested = payload.message && typeof payload.message === 'object'
          ? payload.message as Record<string, unknown>
          : undefined
        const src = nested ?? payload
        const usage = (src.usage as MessageData['usage']) ?? undefined
        const msg: MessageData = {
          index: (src.index as number) ?? (src.message_index as number) ?? (payload.index as number),
          role: (src.role as string) || 'assistant',
          content: (src.content as string) || '',
          agent_role: (src.agent_role as string) || undefined,
          author: (src.author as string) || undefined,
          model: (src.model as string) || undefined,
          provider: (src.provider as string) || undefined,
          reasoning: (src.reasoning as string) || undefined,
          intermediate_text_blocks: src.intermediate_text_blocks as Array<{ text: string; iteration: number }> | undefined,
          tool_calls: (src.tool_calls as MessageData['tool_calls']) ?? null,
          usage,
          metadata: src.metadata as Record<string, unknown> | undefined,
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: new Date().toISOString(),
        }
        addMessage(sid, msg)
        // ADR-070 §2.6: финальное сообщение дочернего саб-агента несёт usage —
        // подстраховка к stream.ended: снимаем usage-only live-плейсхолдер, чтобы
        // после сохранения сообщения панель показывала его итоговую статистику.
        if (usage) clearUsageStream(sid)
        break
      }

      // PROP-098: инъекция во время активного хода — сообщение пользователя,
      // вброшенное оркестратором на границе шага. Добавляем в ленту с
      // маркером «вмешательство в ход» (metadata.steer).
      case 'message_injected':
      case 'message.injected': {
        const metadata = {
          ...((payload.metadata as Record<string, unknown> | undefined) ?? {}),
          steer: true,
        }
        const msg: MessageData = {
          index: (payload.message_index as number) ?? -1,
          id: (payload.message_id as string) || undefined,
          role: 'user',
          content: (payload.content as string) || '',
          agent_role: (payload.agent_role as string) || undefined,
          author: (payload.author as string) || undefined,
          metadata,
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

      // ADR-070 §2.6: live-статистика стрима (кумулятивный usage, cost, model).
      // Публикуется в родительскую сессию основного стрима и в дочернюю сессию
      // саб-агента (sid = childSessionId) — общий механизм streamingBySession.
      case 'stream_usage':
      case 'stream.usage': {
        const streamId = payload.stream_id as string
        if (!streamId) break
        updateStreamUsage(sid, streamId, {
          usage: mapUsage(payload.usage),
          costUsd: payload.cost_usd as number | undefined,
          costCurrency: payload.cost_currency as string | undefined,
          costBreakdown: mapCostBreakdown(payload.cost_breakdown),
          usageEstimated: payload.estimated as boolean | undefined,
          model: payload.model as string | undefined,
          provider: payload.provider as string | undefined,
          agentRole: payload.agent_role as string | undefined,
        })
        break
      }

      case 'stream_done':
      case 'stream.done': {
        const metadata: StreamDoneMetadata = {
          model: payload.model as string | undefined,
          content: payload.content as string | undefined,
          usage: mapUsage(payload.usage),
          debug_info: payload.debug_info as Record<string, unknown> | undefined,
          message_index: payload.message_index as number | undefined,
          message_id: payload.message_id as string | undefined,
          cancelled: payload.cancelled as boolean | undefined,
          pending_count: payload.pending_count as number | undefined,
          status: payload.status as MessageStatus | undefined,
          metadata: payload.metadata as { type?: string; indices?: number[]; [key: string]: unknown } | undefined,
          reasoning_blocks: (payload.reasoning_blocks as Array<{ text: string; iteration: number }>) || undefined,
          intermediate_text_blocks: (payload.intermediate_text_blocks as Array<{ text: string; iteration: number }>) || undefined,
          // ADR-070 §2.6: top-level финальная статистика — в metadata оптимистичного
          // сообщения, чтобы панель показала финал без перезагрузки.
          provider: payload.provider as string | undefined,
          duration_ms: payload.duration_ms as number | undefined,
          cost_usd: payload.cost_usd as number | undefined,
          cost_currency: payload.cost_currency as string | undefined,
          cost_breakdown: mapCostBreakdown(payload.cost_breakdown),
          usage_estimated: payload.usage_estimated as boolean | undefined,
        }
        finishStream(sid, payload.stream_id as string, metadata)
        setStreamRetry(sid, null)
        setFinalStreamError(sid, null)

        const pendingCount = payload.pending_count as number | undefined
        if (pendingCount !== undefined && pendingCount > 0) {
          updateQueueCount(sid, pendingCount)
        } else if (pendingCount === 0) {
          useChatStore.getState().clearQueueState(sid)
        }
        break
      }

      // ADR-070 §2.6: терминальное live-событие дочерней сессии саб-агента
      // (task.ts). Сообщение ребёнка сохраняется отдельно, поэтому здесь только
      // снимаем usage-only StreamState — без создания/дубля сообщений.
      case 'stream_ended':
      case 'stream.ended': {
        clearUsageStream(sid, payload.stream_id as string | undefined)
        break
      }

      case 'stream_cancelled':
      case 'stream.cancelled': {
        // ADR-070 §2.6: событие отмены несёт usage/cost/usage_estimated —
        // сохраняем их в финализируемом сообщении, а не игнорируем.
        cancelStream(
          sid,
          payload.stream_id as string,
          payload.status as MessageStatus | undefined,
          {
            usage: mapUsage(payload.usage),
            costUsd: payload.cost_usd as number | undefined,
            costCurrency: payload.cost_currency as string | undefined,
            costBreakdown: mapCostBreakdown(payload.cost_breakdown),
            usageEstimated: payload.usage_estimated as boolean | undefined,
          },
        )
        setStreamRetry(sid, null)
        break
      }

      // PROP-098 (этап 2): прерывание текущей генерации (`interrupt`). Ход НЕ
      // завершается и НЕ отменяется («Стоп» — отдельный механизм, ADR-005):
      // следующая итерация Tool Use продолжает ту же генерацию с тем же
      // `stream_id`. Поэтому стрим НЕ закрываем (никаких finishStream/
      // cancelStream) — сбрасываем только аккумулятор: накопленный текст
      // прерванной генерации уже сохранён отдельным сообщением со статусом
      // `interrupted` (приходит отдельным `message.added`).
      case 'stream_interrupted':
      case 'stream.interrupted': {
        const streamId = payload.stream_id as string
        if (streamId) resetStreamAccumulator(sid, streamId)
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
          ? i18nText('chat.error.contextLength')
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
        const parentCallId = (payload.parent_call_id as string) || ''
        updateToolCallSubagentProgress(
          sid,
          streamId,
          parentCallId,
          {
            reasoning: (payload.reasoning as string) || '',
            content: (payload.content as string) || '',
            iteration: (payload.iteration as number) || 0,
          },
        )
        // ADR-070 §2.6: live-вклад саб-агента (для строки статистики в блоке
        // `task` и секции StatsTab). Событие несёт накопленный usage вызова.
        if (parentCallId) {
          updateLiveSubagentUsage(sid, parentCallId, {
            usage: mapUsage(payload.usage),
            costUsd: payload.cost_usd as number | undefined,
            costCurrency: payload.cost_currency as string | undefined,
            estimated: payload.estimated as boolean | undefined,
            model: payload.model as string | undefined,
            provider: payload.provider as string | undefined,
          })
        }
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
  });
}

export const useTransportStore = create<TransportState>()((set, get) => ({
  transportMode: 'auto',
  activeTransport: 'disconnected',
  connected: false,
  openSessions: new Set(),

  connect: (mode: TransportMode, override?: 'ws' | 'sse') => {
    const actualMode = override || (mode === 'sse' ? 'sse' as const : 'ws' as const)

    // Идемпотентность: к тому же эффективному транспорту уже подключаемся или
    // подключены. Раньше это пересоздавало клиент и закрывало CONNECTING-сокет
    // (auto→ws + сохранённый prefs ws = один и тот же транспорт — см. ADR-024).
    if (transport && transport.getTransport() === actualMode && activeKind === actualMode) {
      console.debug('[TransportStore] connect skipped (already', actualMode, ')')
      return
    }

    transport?.disconnect()
    transport = null
    transportReady = false
    activeKind = null

    console.debug('[TransportStore] Connecting:', actualMode, '(mode=', mode, ')')
    const dispatcher = createDispatcher()

    const client = new TransportClient({
      onEvent: dispatcher,
      onConnect: () => {
        activeKind = actualMode
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
        activeKind = actualMode
        transportReady = true
        set({ connected: true, activeTransport: 'ws' })
        console.debug('[TransportStore] Backend ready:', client.getTransport())
      },
      onDisconnect: (reason) => {
        // Обрыв/ручное закрытие: клиент больше не считается «активным» —
        // иначе форс-реконнект (ConnectionGuard) и auto-fallback WS→SSE
        // блокировались бы guard'ом идемпотентности.
        activeKind = null
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
    })

    activeKind = actualMode
    client.connect(actualMode)
    transport = client
  },

  disconnect: () => {
    transport?.disconnect()
    transport = null
    transportReady = false
    activeKind = null
    set({ connected: false, activeTransport: 'disconnected' })
  },

  setTransportMode: (mode: TransportMode) => {
    const state = get()

    console.debug('[TransportStore] Switching mode:', state.transportMode, '→', mode)
    set({ transportMode: mode })
    get().connect(mode)
  },

  sendMessage: async (sessionId, text, agentRole, provider, model, mode) => {
    if (transport && transportReady && transport.getTransport() === 'ws') {
      console.debug('[TransportStore] sendMessage via WS:', sessionId)
      await transport.sendMessage(sessionId, text, agentRole, provider, model, mode)
    } else {
      console.debug('[TransportStore] sendMessage via HTTP POST:', sessionId, `(ready=${transportReady}, transport=${transport?.getTransport()})`)
      await synthApi.enqueueMessage(sessionId, text, { agentRole, model, provider, mode })
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
