import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useChatStore, type MessageData, type QueuedMessage } from '@/stores/chatStore'
import { useAuthStore } from '@/stores/authStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTransportStore, applyHistoryPage, restoreLiveTurnFromSession } from '@/stores/transportStore'
import { synthApi, type AgentInfo, type StickyNoteData } from '@/lib/api/synthApi'
import { MESSAGES_PAGE_LIMIT } from '@/lib/api/messages'
import { stickyNoteErrorKey, useStickyNotesLimits } from '@/lib/api/stickyNotesLimits'
import { restorePendingPermissions, restorePendingQuestions } from '@/lib/pendingRestore'
import { isQueueChangedError } from '@/lib/api/queue'
import { attachmentThumbnailUrl } from '@/lib/api/attachments'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { copyMessageText } from '@/lib/messageCopy'
import { resolveLiveParts } from '@/lib/messageParts'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { DebugModal } from './DebugModal'
import { QueuePanel } from './QueuePanel'
import { mediaPartsOf } from './attachments/MessageAttachments'
import { PermissionRequestBar } from './PermissionRequestBar'
import { QuestionDock } from './QuestionDock'
import { StickyNotesPanel } from './StickyNotesPanel'
import { StreamErrorPanel } from './StreamErrorPanel'
import { SendBlockedPanel, sendBlockedFromError, type SendBlockedState } from './SendBlockedPanel'
import { ContextWarningPanel } from './ContextWarningPanel'
import {
  useContextWindowUsage,
  useContextWindowWarning,
} from '@/hooks/useContextWindowUsage'
import { SubagentResumeBar, type SubagentSessionError } from './SubagentResumeBar'
import { useBackgroundHotkey } from './useBackgroundHotkey'
import type { CenterTab } from '@/stores/useUIStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAttachmentsStore, type RestorableAttachment } from '@/stores/attachmentsStore'
import { DEFAULT_STEER_MODE, type MediaPartData, type Part, type SteerMode } from '@itphx/synth-shared/types'

interface ChatTabProps {
  tab: CenterTab
}

// Стабильные пустые референсы: иначе каждый рендер создаёт новые []/{}/Set,
// ломая мемоизацию memo-детей (MessageList и пр.).
const EMPTY_MESSAGES: MessageData[] = []
const EMPTY_PENDING: QueuedMessage[] = []
const EMPTY_STICKY: StickyNoteData[] = []
const EMPTY_SELECTED_IDS: Set<string> = new Set()

/**
 * ADR-115: восстановить вложения сообщения в композер («Повторить»).
 *
 * У медиа-части есть `blobPath` (серверный id вложения) и метаданные; исходного
 * `File` в истории нет, поэтому элементы сразу `ready`. Для изображений
 * `previewUrl` — **миниатюра** (`?variant=thumb`, ADR-115): превью 64×64 в
 * композере не должно тянуть полноразмерный оригинал (локального object URL
 * уже не существует). Нет миниатюры — `AttachedFilesList` один раз подставит
 * оригинал.
 */
function restoreAttachmentsFromMessage(
  sessionId: string,
  parts: Part[] | null | undefined,
): void {
  if (!parts || parts.length === 0) return
  const items: RestorableAttachment[] = []
  for (const part of parts) {
    if (
      part.type !== 'image' &&
      part.type !== 'audio' &&
      part.type !== 'video' &&
      part.type !== 'file'
    ) {
      continue
    }
    const data = part.data as MediaPartData | undefined
    if (!data || typeof data.blobPath !== 'string' || data.blobPath === '') continue
    const mimeType = typeof data.mime === 'string' && data.mime !== '' ? data.mime : 'application/octet-stream'
    items.push({
      blobPath: data.blobPath,
      mimeType,
      size: typeof data.size === 'number' ? data.size : 0,
      name: data.name,
      partId: part.id,
      previewUrl: mimeType.toLowerCase().startsWith('image/')
        ? attachmentThumbnailUrl(sessionId, part.id)
        : undefined,
    })
  }
  if (items.length > 0) useAttachmentsStore.getState().restore(sessionId, items)
}

/**
 * `pending_messages` сессии → строка очереди (`QueuedMessage`).
 * ADR-115: число вложений считаем по медиа-частям сообщения.
 */
export function toQueuedMessage(pm: MessageData): QueuedMessage {
  return {
    id: pm.id,
    content: pm.content,
    agentRole: pm.agent_role || null,
    attachmentCount: mediaPartsOf(pm.parts).length,
  }
}

export function ChatTab({ tab }: ChatTabProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const messagesBySession = useChatStore(s => s.messagesBySession)
  const turnBySession = useChatStore(s => s.turnBySession)
  const queueBySession = useChatStore(s => s.queueBySession)
  const pendingBySession = useChatStore(s => s.pendingBySession)
  const retryBySession = useChatStore(s => s.retryBySession)
  const finalErrorBySession = useChatStore(s => s.finalErrorBySession)
  const stickyNotesBySession = useChatStore(s => s.stickyNotesBySession)
  const summarizationPendingBySession = useChatStore(s => s.summarizationPendingBySession)
  const debugModalSessionId = useChatStore(s => s.debugModalSessionId)
  const debugModalMessageId = useChatStore(s => s.debugModalMessageId)
  const updateMessageById = useChatStore(s => s.updateMessageById)
  const clearQueueState = useChatStore(s => s.clearQueueState)
  const resetQueueStalled = useChatStore(s => s.resetQueueStalled)
  const updateQueueCount = useChatStore(s => s.updateQueueCount)
  const setPendingMessages = useChatStore(s => s.setPendingMessages)
  const reorderPending = useChatStore(s => s.reorderPending)
  const setStickyNotes = useChatStore(s => s.setStickyNotes)
  // Лимиты заметок нужны для понятного текста отказа (409/400) вместо общего.
  const stickyNotesLimits = useStickyNotesLimits()
  const setSummarizationPending = useChatStore(s => s.setSummarizationPending)
  const openDebugModal = useChatStore(s => s.openDebugModal)
  const closeDebugModal = useChatStore(s => s.closeDebugModal)
  const setRetryInput = useChatStore(s => s.setRetryInput)
  const setStreamRetry = useChatStore(s => s.setStreamRetry)

  const sessionId = tab.data.sessionId || tab.id
  // Пагинация истории: есть ли сообщения старше загруженной страницы
  // (кнопка «Загрузить старые» над лентой).
  const historyPage = useChatStore(s => s.historyPageBySession[sessionId])
  // Заполнение контекстного окна: тост на 80% (один раз на сессию/порог) и
  // жёлтый блок над композером на 90% (оба выключаются политикой `off`).
  const contextUsage = useContextWindowUsage(sessionId)
  useContextWindowWarning(sessionId, contextUsage.percent)
  const messages = messagesBySession[sessionId] || EMPTY_MESSAGES
  const queue = queueBySession[sessionId]
  const pending = pendingBySession[sessionId] || EMPTY_PENDING
  const stickyNotes = stickyNotesBySession[sessionId] || EMPTY_STICKY
  const streamRetry = retryBySession[sessionId]
  const summarizationPending = summarizationPendingBySession[sessionId] || false
  const finalError = finalErrorBySession[sessionId] || null
  // ADR-118 §1: единственный источник «идёт ход» — активный ход (`turnBySession`).
  const activeTurn = turnBySession[sessionId] ?? null
  const isStreaming = activeTurn?.status === 'streaming'
  const hasActiveStream = isStreaming

  // ADR-111 §detach: `ctrl+b` переводит все блокирующие прогоны активной сессии
  // в фон — только пока ход идёт (вне стрима переводить нечего).
  useBackgroundHotkey(sessionId, isStreaming)
  const isEmpty = messages.length === 0 && !hasActiveStream && pending.length === 0 && !summarizationPending
  const debugMessage = debugModalSessionId && debugModalMessageId
    ? messages.find((m) => m.id === debugModalMessageId) ?? null
    : null

  // B8: последнее сообщение дочерней сессии — ошибка провайдера → плашка «Продолжить»
  const lastSessionError = useMemo<SubagentSessionError | null>(() => {
    const last = messages[messages.length - 1]
    if (!last || !(last.role === 'error' || last.metadata?.error === true)) return null
    return {
      attempts: last.metadata?.attempts as number | undefined,
      maxRetries: last.metadata?.max_retries as number | undefined,
      errorType: last.metadata?.error_type as string | undefined,
      error: (last.metadata?.error as string) || last.content,
    }
  }, [messages])

  const selectionState = useChatStore(s => s.selectionBySession[sessionId])
  const selectionMode = selectionState?.mode ?? false
  // ADR-118 §7: выделение адресуется по `id` (лента сортируется по `ord`).
  const selectedIds = selectionState?.ids ?? EMPTY_SELECTED_IDS

  const [sessionOrigin, setSessionOrigin] = useState<string | null>(null)
  const isSubagent = sessionOrigin === 'subagent'
  const isReadOnly = isSubagent
  const [inputExpanded, setInputExpanded] = useState(false)

  // Отправка заблокирована отключённым провайдером/моделью: понятная плашка над
  // композером (вместо общего тоста). Снимается при успешной отправке, смене
  // модели/провайдера и переключении сессии.
  const selectedProviderName = useProvidersStore(s => s.selectedProviderName)
  const selectedModelName = useProvidersStore(s => s.selectedModelName)
  const [sendBlocked, setSendBlocked] = useState<SendBlockedState | null>(null)
  useEffect(() => {
    setSendBlocked(null)
  }, [sessionId, selectedProviderName, selectedModelName])

  // ADR-104: режим отправки сообщения по умолчанию для композера. Выбор
  // пользователя (`queue`/`steer`/`interrupt`) делает селектор композера — он
  // виден только при активном ходе; без хода сообщение уходит обычной очередью.
  const sendMode: SteerMode = DEFAULT_STEER_MODE

  const agentsRef = useRef<AgentInfo[]>([])
  const forkingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // Загружаем сообщения — нужно первым
        // ADR-118 + пагинация истории: грузим **последнюю** страницу
        // (`limit`), а не всю историю — старые догружаются по кнопке.
        const result = await synthApi.getSessionMessages(sessionId, { limit: MESSAGES_PAGE_LIMIT })
        if (cancelled) return
        // ADR-118 §5: снимок истории сводится с живым состоянием, а не
        // заменяет его — иначе переключение сессий во время хода затирало
        // уже показанный контент более старым снимком («мелькал» и пропадал).
        // Границы идущего хода восстанавливаются внутри мержа. Курсор
        // «Загрузить старые» выставляет сам `applyHistoryPage` (обновляется
        // снимком, пока пользователь не догружал старые страницы).
        applyHistoryPage(sessionId, result)

        // Агенты и данные сессии параллельно (независимы друг от друга)
        const [agentsResp, session] = await Promise.all([
          synthApi.getAgents(sessionId),
          synthApi.getSession(sessionId).catch(() => null),
        ])
        if (cancelled) return

        if (agentsResp) agentsRef.current = agentsResp.agents

        if (session) {
          // Кладём актуальные данные сессии (включая mode) в стор —
          // иначе PlanActModeToggle не увидит mode и покажет дефолт 'act'.
          useSessionsStore.getState().upsertSession(session)
          // ADR-118 §5: признак активного хода из API (`current_stream` /
          // `status.blocked`). Истории может не хватить: идёт длинный
          // инструмент, шаг с текстом уже `completed`, а следующего
          // assistant-сообщения ещё нет — сообщения со статусом `streaming`
          // в истории нет, и без этого ход не восстановить (нет индикатора,
          // «Стоп» и `ctrl+b`).
          restoreLiveTurnFromSession(sessionId, session)
          const s = session?.settings as Record<string, unknown> | undefined
          if (s) {
            const { setSelectedProvider, setSelectedModel } = useProvidersStore.getState()
            const { setActiveAgentId } = useAgentsStore.getState()
            if (typeof s.provider === 'string') setSelectedProvider(s.provider)
            if (typeof s.model === 'string') setSelectedModel(s.model)
            if (typeof s.agentRole === 'string') setActiveAgentId(s.agentRole)
          }
          const sessData = session as unknown as Record<string, unknown>
          setSessionOrigin((sessData.session_origin as string) || null)
          const pendingMsgs = sessData.pending_messages as MessageData[] | undefined
          const hasActiveStream = sessData.current_stream != null || isStreaming
          if (pendingMsgs && pendingMsgs.length > 0) {
            const displayMsgs = hasActiveStream ? pendingMsgs.slice(1) : pendingMsgs
            if (displayMsgs.length > 0) {
              setPendingMessages(sessionId, displayMsgs.map(toQueuedMessage))
              updateQueueCount(sessionId, displayMsgs.length)
            }
          }
          if (session.sticky_notes) {
            setStickyNotes(sessionId, session.sticky_notes)
          }
          // Осознанная остановка обработки (Stop/stall) пережила рестарт:
          // без этого баннер «Обработка остановлена» не появился бы у свежего
          // клиента (событие `queue.stalled` уже опубликовано до подключения).
          const status = sessData.status as Record<string, unknown> | undefined
          if (status?.queue_stopped === true && pendingMsgs && pendingMsgs.length > 0 && !hasActiveStream) {
            useChatStore.getState().setQueueStalled(sessionId, pendingMsgs.length)
          } else {
            resetQueueStalled(sessionId)
          }
        }
      } catch {
        if (!cancelled) {
          notify({ text: t('chat.error.loadSession'), type: 'error', category: 'error', sessionId })
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [sessionId])

  /**
   * Восстановление незакрытых запросов сессии: подтверждения прав
   * (`permission.asked`) и вопросы пользователю (`user_question.asked`)
   * приходят только live-событиями. После перезагрузки страницы (или
   * протухшей аутентификации) эти события уже прошли — клиент о них не
   * знает, и карточка/док пропадают: ход висит до ask-таймаута.
   *
   * Точка восстановления — здесь, а не в `PermissionRequestBar`/`QuestionDock`:
   * оба смонтированы условно (`!inputExpanded && !isSubagent`), поэтому при
   * развёрнутом композере эффект восстановления не выполнялся вовсе.
   *
   * Ошибка загрузки — тихая (запрос покажут live-события).
   */
  useEffect(() => {
    void restorePendingPermissions(sessionId)
    void restorePendingQuestions(sessionId)
  }, [sessionId])

  /**
   * «Загрузить старые»: страница истории **перед** текущей (`before` — курсор
   * `seq`). Старые сообщения добавляются в начало ленты, курсор пагинации
   * обновляется (следующая страница — ещё старше), а признак `expanded`
   * защищает уже догруженный диапазон от «омоложения» снимком.
   *
   * Позицию скролла восстанавливает `MessageList` (он владеет контейнером
   * прокрутки): контент сверху вырос — компенсируем разницу высот.
   */
  const handleLoadOlder = useCallback(async () => {
    const page = useChatStore.getState().historyPageBySession[sessionId]
    if (!page?.hasMore || page.nextBefore == null) return
    try {
      const result = await synthApi.getSessionMessages(sessionId, {
        limit: MESSAGES_PAGE_LIMIT,
        before: page.nextBefore,
      })
      const chat = useChatStore.getState()
      chat.prependMessages(sessionId, result.messages ?? [])
      chat.setHistoryPage(sessionId, {
        hasMore: result.has_more === true,
        nextBefore: typeof result.next_before === 'number' ? result.next_before : null,
        // Пользователь догружал старые страницы: снимок последней страницы
        // больше не должен перезаписывать этот курсор.
        expanded: true,
      })
    } catch {
      notify({ text: t('chat.error.loadOlder'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  const handleFork = useCallback(
    async (msg: MessageData) => {
      if (forkingRef.current) return
      forkingRef.current = true
      try {
        const fork = await useSessionsStore.getState().forkSession(sessionId, {
          message_id: msg.id || undefined,
          message_index: msg.index,
        })
        if (fork) {
          notify({ text: t('chat.message.forked'), type: 'info', category: 'message', sessionId })
          useUIStore.getState().openTab({
            id: `chat-${fork.id}`,
            type: 'chat' as const,
            title: fork.name || fork.id,
            data: { sessionId: fork.id, projectId: fork.project_id || undefined },
          })
          if (msg.role === 'user' && msg.content) {
            useChatStore.getState().setRetryInput(fork.id, msg.content)
          }
        }
      } catch (e) {
        notify({ text: `${t('chat.error.forkFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
      } finally {
        forkingRef.current = false
      }
    },
    [sessionId, notify, t]
  )

  const handleSend = useCallback(
    async (text: string, agentRole?: string, mode?: SteerMode, attachmentIds?: string[]) => {
      const { activeAgentId, defaultAgentId } = useAgentsStore.getState()
      const effectiveAgentRole = agentRole || activeAgentId || defaultAgentId || undefined

      // Сообщение пользователя появляется в чате только когда сервер
      // начинает его обработку (event message.added из QueueProcessor)

      try {
        const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
        useChatStore.getState().setStreamRetry(sessionId, null)
        // ADR-115: id загруженных вложений уходят в тело запроса промпта.
        // ADR-118 §3: ответ — `202 {messageId, mode, position}`; реплика уже
        // показана в ленте оптимистично по `messageId`.
        await useTransportStore.getState().sendMessage(sessionId, text, effectiveAgentRole, selectedProviderName || undefined, selectedModelName || undefined, mode, attachmentIds)
        setSendBlocked(null)
        notify({
          text: t('chat.message.sent'),
          type: 'info',
          category: 'message',
          sessionId,
        })
      } catch (e) {
        const blocked = sendBlockedFromError(e)
        if (blocked) {
          // Отключённая пара: показываем плашку по коду (тост не дублируем).
          setSendBlocked(blocked)
        } else {
          notify({ text: `${t('chat.error.sendFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
        }
        // Ошибку пробрасываем композеру: он не очищает вложения при неудаче.
        throw e
      }
    },
    [sessionId, notify, t]
  )

  const handleStop = useCallback(async () => {
    // Во время ретрая «Стоп» = отмена повторных попыток (иначе abort оставит
    // pending-сообщение и сессия зависнет до queue.stalled).
    const retry = useChatStore.getState().retryBySession[sessionId]
    if (retry) {
      try {
        await synthApi.cancelQueueRetry(sessionId)
        setStreamRetry(sessionId, null)
      } catch {
        // ignore
      }
      return
    }
    try {
      useTransportStore.getState().cancel(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId, setStreamRetry])

  const handleRetryNow = useCallback(async () => {
    try {
      await synthApi.retryQueueNow(sessionId)
      // Стрим снова «работает»: статус ретрая снимем по следующему
      // событию ретрая (если снова упадёт) или по финалу хода.
      setStreamRetry(sessionId, null)
    } catch {
      notify({ text: t('chat.error.retryNow'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, streamRetry, setStreamRetry, notify, t])

  const handleCancelRetry = useCallback(async () => {
    try {
      await synthApi.cancelQueueRetry(sessionId)
      setStreamRetry(sessionId, null)
    } catch {
      notify({ text: t('chat.error.cancelRetry'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStreamRetry, notify, t])

  // B6: повторная отправка user-реплики, упавшей с финальной ошибкой.
  // Существующий POST /messages/:sid/:idx/retry не re-enqueue (он отключает сообщения
  // и возвращает текст в input), поэтому композиция из существующих эндпоинтов:
  // disable «упавшего» сообщения (не дублируем его в контексте) → повторная отправка
  // его текста через prompt (сообщение встаёт в очередь заново).
  //
  // Адресация цели — **реплике упавшего хода**, а не «последней с last_error»:
  // после `stream.error` история в сторе не перечитывается, и у текущей
  // реплики `metadata.last_error` обычно ещё нет — поиск по нему повторял бы
  // давний запрос. Порядок: `message_id` из события → `turn_id` хода →
  // последняя user-реплика ленты.
  const handleRetryLastFailed = useCallback(async () => {
    const chat = useChatStore.getState()
    const msgs = chat.messagesBySession[sessionId] || []
    const finalError = chat.finalErrorBySession[sessionId] ?? null

    let target: MessageData | undefined
    const failedId = finalError?.messageId
    if (failedId) {
      target = msgs.find((m) => m.id === failedId)
      if (!target) {
        // Реплики ещё нет в сторе (лента не перечитана) — точечная загрузка.
        try {
          const detail = await synthApi.getSessionMessage(sessionId, failedId)
          target = detail?.message
        } catch {
          // 404/сеть — пробуем адресовать по ходу, затем по последней реплике.
        }
      }
    }
    if (!target && finalError?.turnId) {
      target = [...msgs].reverse().find(
        (m) => m.role === 'user' && m.turn_id === finalError.turnId,
      )
    }
    if (!target) {
      target = [...msgs].reverse().find((m) => m.role === 'user')
    }
    if (!target) {
      // Цели нет — плашку снимаем, ничего не отправляем.
      chat.setFinalStreamError(sessionId, null)
      return
    }
    try {
      if (target.disabled === false && target.id) {
        await synthApi.toggleMessage(sessionId, target.id)
      }
      const { selectedModelName, selectedProviderName } = useProvidersStore.getState()
      await synthApi.enqueueMessage(sessionId, target.content, {
        agentRole: target.agent_role || undefined,
        provider: selectedProviderName || target.provider || undefined,
        model: selectedModelName || target.model || undefined,
      })
      useChatStore.getState().setFinalStreamError(sessionId, null)
      notify({ text: t('chat.streamError.retrySent'), type: 'info', category: 'message', sessionId })
    } catch (e) {
      notify({ text: `${t('chat.error.retryLast')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  // Гибрид: истекла серверная сессия (`remote_auth_expired`) — повтор запроса
  // бессмысленен, нужен повторный вход. `logout()` отключает гибрид и показывает
  // экран входа с предзаполненным сервером.
  const handleHybridLogin = useCallback(() => {
    void useAuthStore.getState().logout()
  }, [])

  // B8: возобновление дочерней сессии (плашка в дочерней сессии)
  const handleResumeSubagent = useCallback(async () => {
    try {
      await synthApi.resumeSubagent(sessionId)
      // Состояние «Возобновление…» придёт событием subagent.resume.started
    } catch (e) {
      notify({ text: `${t('chat.subagent.resumeFailed')}: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  const handleStopSubagentResume = useCallback(async () => {
    try {
      await synthApi.stopGeneration(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleStopAll = useCallback(async () => {
    try {
      useTransportStore.getState().cancel(sessionId)
      await synthApi.clearQueue(sessionId)
      clearQueueState(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId, clearQueueState])

  const handleCopy = useCallback(
    // Копируем видимый текст, а не legacy-`content`: там reasoning и вызовы
    // инструментов (`buildContentFromParts`) — на экране их блоки отдельные.
    async (msg: MessageData, plain?: boolean) => {
      const liveMap = useChatStore.getState().partsBySession[sessionId]?.[msg.id ?? '']
      // Как в рендере (`ChatMessage`): у финального сообщения «застрявшие»
      // live-тексты шага не используются, сливаются только tool-части.
      const liveParts = resolveLiveParts(liveMap ? Object.values(liveMap) : undefined, {
        isLive: msg.status === 'streaming',
        dtoParts: msg.parts,
      })
      const copied = await copyMessageText(msg, plain ? 'plain' : 'markdown', liveParts)
      if (copied) {
        notify({ text: t('chat.message.copied'), type: 'info', category: 'message', sessionId })
      }
    },
    [notify, t, sessionId]
  )

  const handleToggle = useCallback(
    async (msg: MessageData) => {
      try {
        if (!msg.id) return
        const result = await synthApi.toggleMessage(sessionId, msg.id)
        // ADR-118 §7: локальное состояние адресуется по `id` (индекс нестабилен).
        if (msg.id) updateMessageById(sessionId, msg.id, { disabled: result.disabled })
        notify({
          text: result.disabled ? t('chat.message.disabled') : t('chat.message.enabled'),
          type: 'info',
          category: 'message',
          sessionId,
        })
      } catch {
        notify({ text: t('chat.error.toggleMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, updateMessageById, notify, t]
  )

  const handlePin = useCallback(
    async (msg: MessageData) => {
      try {
        if (!msg.id) return
        const result = await synthApi.pinMessage(sessionId, msg.id)
        if (msg.id) updateMessageById(sessionId, msg.id, { pinned: result.pinned })
        notify({
          text: result.pinned ? t('chat.message.pinned') : t('chat.message.unpinned'),
          type: 'info',
          category: 'message',
          sessionId,
        })
      } catch {
        notify({ text: t('chat.error.pinMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, updateMessageById, notify, t]
  )

  /**
   * ADR-118 §10: pin на **контейнере хода** — пин всех сегментов хода.
   * Серверный вызов — пакетный (`POST /messages/:id/batch`), локальное
   * состояние адресуется по `id` (индекс нестабилен).
   */
  const handlePinTurn = useCallback(
    async (segments: MessageData[]) => {
      const targets = segments.filter((m) => !!m.id)
      if (targets.length === 0) return
      const pinned = !targets.every((m) => m.pinned)
      try {
        await synthApi.batchMessages(
          sessionId,
          'pin',
          targets.map((m) => m.id!),
          pinned,
        )
        for (const m of targets) {
          updateMessageById(sessionId, m.id!, { pinned })
        }
        notify({
          text: pinned ? t('chat.message.pinned') : t('chat.message.unpinned'),
          type: 'info',
          category: 'message',
          sessionId,
        })
      } catch {
        notify({ text: t('chat.error.pinMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, updateMessageById, notify, t]
  )

  const handleDelete = useCallback(
    async (msg: MessageData) => {
      const ok = await confirm({ title: t('chat.actions.deleteConfirm'), variant: 'danger' })
      if (!ok) return
      try {
        if (!msg.id) return
        await synthApi.deleteMessage(sessionId, msg.id)
        // Снимок ниже не увидит удалённое **самое новое** сообщение — защита от
        // гонки `ord > maxOrd` (`mergeServerMessages`) сохранила бы его;
        // удаление адресуем явно по id (multi-client — `message.deleted`).
        useChatStore.getState().removeMessageById(sessionId, msg.id)
        const result = await synthApi.getSessionMessages(sessionId, { limit: MESSAGES_PAGE_LIMIT })
        // ADR-118 §5: мерж с живым состоянием (см. первичную загрузку).
        applyHistoryPage(sessionId, result)
        notify({ text: t('chat.message.deleted'), type: 'info', category: 'message', sessionId })
      } catch {
        notify({ text: t('chat.error.deleteMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, notify, t]
  )

  const handleRetry = useCallback(
    async (msg: MessageData) => {
      const ok = await confirm({ title: t('chat.actions.retryConfirm'), variant: 'warning' })
      if (!ok) return
      try {
        if (!msg.id) return
        const result = await synthApi.retryMessage(sessionId, msg.id)
        const reloadResult = await synthApi.getSessionMessages(sessionId, { limit: MESSAGES_PAGE_LIMIT })
        // ADR-118 §5: мерж с живым состоянием (см. первичную загрузку).
        applyHistoryPage(sessionId, reloadResult)
        // ADR-115: вложения возвращаются в композер вместе с текстом (маркеры
        // уже в `content` — повторной вставки не будет). `restore` — до
        // `setRetryInput`, чтобы к моменту появления текста чипы уже были.
        restoreAttachmentsFromMessage(sessionId, msg.parts)
        setRetryInput(sessionId, result.content)
        notify({ text: t('chat.message.retrying'), type: 'info', category: 'message', sessionId })
      } catch {
        notify({ text: t('chat.error.retryMessage'), type: 'error', category: 'error', sessionId })
      }
    },
    [sessionId, setRetryInput, notify, t]
  )

  const handleDebug = useCallback(
    (msg: MessageData) => {
      if (msg.debug_data && Object.keys(msg.debug_data as object).length > 0 && msg.id) {
        // ADR-118 §7: отладка адресуется по `id` сообщения (индекс нестабилен).
        openDebugModal(sessionId, msg.id)
      } else {
        notify({ text: t('chat.debug.noData'), type: 'info', category: 'system', sessionId })
      }
    },
    [openDebugModal, notify, t, sessionId]
  )

  const handleSummarizeNow = useCallback(async () => {
    try {
      await synthApi.summarizeSession(sessionId)
      setSummarizationPending(sessionId, false)
      notify({ text: t('rightPanel.context.summarizeEnqueued'), type: 'info', category: 'queue', sessionId })
    } catch {
      notify({ text: t('rightPanel.context.summarizeError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setSummarizationPending, notify, t])

  const handleCancelSummarization = useCallback(async () => {
    try {
      await synthApi.cancelSummarization(sessionId)
      setSummarizationPending(sessionId, false)
      notify({ text: t('rightPanel.context.summarizationCancelled'), type: 'info', category: 'system', sessionId })
    } catch {
      // ignore
    }
  }, [sessionId, setSummarizationPending, notify, t])

  /**
   * Полный рефреш очереди с сервера: после отказа steer (409 `NO_ACTIVE_TURN`,
   * 429 лимит инъекций) локальное состояние могло разойтись с серверным.
   * Семантика та же, что у первичной загрузки: при живом стриме первый
   * pending-элемент — текущее сообщение хода, в списке очереди его нет.
   */
  const refreshQueueFromApi = useCallback(async () => {
    try {
      const session = await synthApi.getSession(sessionId)
      const data = session as unknown as Record<string, unknown>
      const pendingMsgs = data.pending_messages as MessageData[] | undefined
      if (!pendingMsgs || pendingMsgs.length === 0) {
        clearQueueState(sessionId)
        return
      }
      const hasActiveStream = data.current_stream != null
        || useChatStore.getState().turnBySession[sessionId]?.status === 'streaming'
      const displayMsgs = hasActiveStream ? pendingMsgs.slice(1) : pendingMsgs
      if (displayMsgs.length === 0) {
        clearQueueState(sessionId)
        return
      }
      setPendingMessages(sessionId, displayMsgs.map(toQueuedMessage))
      updateQueueCount(sessionId, displayMsgs.length)
    } catch {
      // Сеть/сервер недоступны — оставляем UI как есть, ошибку показал вызывающий.
    }
  }, [sessionId, clearQueueState, setPendingMessages, updateQueueCount])

  const handleResumeQueue = useCallback(async () => {
    try {
      await synthApi.resumeQueue(sessionId)
      clearQueueState(sessionId)
      notify({ text: t('chat.queue.resumed'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.resumeQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, clearQueueState, notify, t])

  const handleClearQueue = useCallback(async () => {
    try {
      await synthApi.clearQueue(sessionId)
      clearQueueState(sessionId)
      notify({ text: t('chat.queue.cleared'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.clearQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, clearQueueState, notify, t])

  const handleReturnQueue = useCallback(async () => {
    try {
      const resp = await synthApi.returnQueue(sessionId)
      const data = resp as { texts?: string[] }
      if (data?.texts && data.texts.length > 0) {
        setRetryInput(sessionId, data.texts.join('\n\n'))
        setPendingMessages(sessionId, [])
        clearQueueState(sessionId)
        notify({ text: t('chat.queue.returned'), type: 'success', category: 'queue', sessionId })
      } else {
        notify({ text: t('chat.queue.empty'), type: 'info', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, setPendingMessages, clearQueueState, setRetryInput, notify, t])

  const handleReturnMsg = useCallback(async (uiIndex: number) => {
    const queued = pending[uiIndex]
    // Адресация — только по серверному id: индекс мог сдвинуться (стрим/очередь).
    if (!queued?.id) {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
      void refreshQueueFromApi()
      return
    }
    try {
      const resp = await synthApi.returnQueue(sessionId, { id: queued.id })
      const data = resp as { texts?: string[] }
      if (data?.texts && data.texts.length > 0) {
        setRetryInput(sessionId, data.texts[0])
        const cur = useChatStore.getState().pendingBySession[sessionId] || []
        setPendingMessages(sessionId, cur.filter((_, i) => i !== uiIndex))
        const qs = useChatStore.getState().queueBySession[sessionId]
        if (qs && qs.pendingCount > 0) {
          if (qs.pendingCount <= 1) {
            useChatStore.getState().clearQueueState(sessionId)
          } else {
            useChatStore.getState().updateQueueCount(sessionId, qs.pendingCount - 1)
          }
        }
        notify({ text: t('chat.queue.returned'), type: 'success', category: 'queue', sessionId })
      } else {
        notify({ text: t('chat.queue.empty'), type: 'info', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, setPendingMessages, setRetryInput, notify, t, pending, refreshQueueFromApi])

  /**
   * Локальное снятие элемента очереди после успешного действия (steer/удаление):
   * та же арифметика, что у возврата в редактор (`handleReturnMsg`).
   */
  const dropPendingAt = useCallback((uiIndex: number) => {
    const store = useChatStore.getState()
    const cur = store.pendingBySession[sessionId] || []
    store.setPendingMessages(sessionId, cur.filter((_, i) => i !== uiIndex))
    const qs = store.queueBySession[sessionId]
    if (qs && qs.pendingCount > 0) {
      if (qs.pendingCount <= 1) {
        store.clearQueueState(sessionId)
      } else {
        store.updateQueueCount(sessionId, qs.pendingCount - 1)
      }
    }
  }, [sessionId])

  /** «В разрыв»: принудительный steer сообщения из очереди в текущий ход (ADR-104). */
  const handleSteerMsg = useCallback(async (uiIndex: number) => {
    const queued = pending[uiIndex]
    if (!queued?.id) {
      notify({ text: t('chat.error.steerQueue'), type: 'error', category: 'queue', sessionId })
      void refreshQueueFromApi()
      return
    }
    try {
      await synthApi.steerQueue(sessionId, { id: queued.id })
      dropPendingAt(uiIndex)
      notify({ text: t('chat.queue.steered'), type: 'success', category: 'queue', sessionId })
    } catch {
      // 409 `NO_ACTIVE_TURN`/`CONFLICT` / 429 лимит инъекций / 404: локально
      // ничего не меняем и перечитываем очередь целиком — иначе UI разойдётся.
      notify({ text: t('chat.error.steerQueue'), type: 'error', category: 'queue', sessionId })
      void refreshQueueFromApi()
    }
  }, [sessionId, dropPendingAt, refreshQueueFromApi, notify, t, pending])

  /**
   * DnD-переупорядочивание очереди: локально применяем порядок сразу
   * (перетаскивание не должно «отскакивать»), затем фиксируем на сервере.
   *
   * `409 QUEUE_CHANGED` — очередь на сервере уже другая (элемент увели/добавили):
   * локальный порядок недостоверен, перечитываем состав у сервера и
   * предупреждаем пользователя. Прочие ошибки — перечитываем с тостом ошибки.
   */
  const handleReorderQueue = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    reorderPending(sessionId, ids)
    try {
      await synthApi.reorderQueue(sessionId, ids)
    } catch (err) {
      if (isQueueChangedError(err)) {
        notify({ text: t('chat.queue.changed'), type: 'info', category: 'queue', sessionId })
      } else {
        notify({ text: t('chat.error.reorderQueue'), type: 'error', category: 'queue', sessionId })
      }
      void refreshQueueFromApi()
    }
  }, [sessionId, reorderPending, refreshQueueFromApi, notify, t])

  /** «Удалить»: сообщение снимается с сервера, возвращённый текст выбрасывается. */
  const handleRemoveMsg = useCallback(async (uiIndex: number) => {
    const queued = pending[uiIndex]
    if (!queued?.id) {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
      void refreshQueueFromApi()
      return
    }
    try {
      const resp = await synthApi.returnQueue(sessionId, { id: queued.id })
      const data = resp as { texts?: string[] }
      if (data?.texts && data.texts.length > 0) {
        dropPendingAt(uiIndex)
      } else {
        notify({ text: t('chat.queue.empty'), type: 'info', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, dropPendingAt, refreshQueueFromApi, notify, t, pending])

  // --- Selection mode handlers ---

  const handleToggleSelect = useCallback((messageId: string) => {
    useChatStore.getState().toggleMessageSelection(sessionId, messageId)
  }, [sessionId])

  const handleSelectRange = useCallback((fromMessageId: string, toMessageId: string) => {
    useChatStore.getState().selectMessageRange(sessionId, fromMessageId, toMessageId)
  }, [sessionId])

  // --- Forward confirm ---

  const handleForwardConfirm = useCallback(async (targetSessionId: string, position: 'after' | 'before', summarize: boolean) => {
    const fm = useUIStore.getState().forwardMode
    if (!fm.active || !fm.sourceSessionId) return

    try {
      if (fm.mode === 'forward') {
        const sorted = [...fm.sourceIndices].sort((a, b) => a - b)
        const msgs = messagesBySession[sessionId] || []
        const selectedMsgs = sorted.map(i => msgs[i]).filter(Boolean)
        if (selectedMsgs.length === 0) return
        const lastSelected = selectedMsgs[selectedMsgs.length - 1]
        // Use seq numbers, not indices
        const fromSeq = selectedMsgs[0].seq ?? sorted[0] + 1
        const toSeq = lastSelected.role === 'user' && selectedMsgs.length > 1
          ? selectedMsgs[selectedMsgs.length - 2].seq ?? sorted[sorted.length - 2] + 1
          : lastSelected.seq ?? sorted[sorted.length - 1] + 1

        await synthApi.mergeMessages(targetSessionId, sessionId, {
          sourceRange: [fromSeq, toSeq],
          position,
        })

        if (lastSelected.role === 'user') {
          useChatStore.getState().setRetryInput(targetSessionId, lastSelected.content)
        }

        notify({ text: `Сообщения скопированы в сессию`, type: 'success', category: 'message', sessionId })
      } else {
        await synthApi.addSessionReference(targetSessionId, sessionId, {
          messageRange: [1, messages.length || 9999],
          position,
          autoSummarize: summarize,
        })
        notify({ text: `Ссылка на сессию добавлена`, type: 'success', category: 'message', sessionId })
      }

      useUIStore.getState().cancelForwardMode()
    } catch (e) {
      notify({ text: `Ошибка: ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, messagesBySession, messages.length, notify])

  // Register forward confirm handler in UIStore
  useEffect(() => {
    useUIStore.getState().forwardConfirmAction = handleForwardConfirm
    return () => {
      const state = useUIStore.getState()
      if (state.forwardConfirmAction === handleForwardConfirm) {
        state.forwardConfirmAction = null
      }
    }
  }, [handleForwardConfirm])

  const handleCreateNote = useCallback(async (text: string) => {
    try {
      const result = await synthApi.addStickyNote(sessionId, text)
      setStickyNotes(sessionId, result.notes)
      notify({ text: t('chat.message.sent'), type: 'info', category: 'message', sessionId })
    } catch (err) {
      // Сервер отклонил заметку по лимитам (409 LIMIT_EXCEEDED / 400
      // VALIDATION_ERROR) — показываем причину, а не общий «ошибка сохранения».
      const key = stickyNoteErrorKey(err)
      notify({
        text: key
          ? t(key, {
              maxCount: stickyNotesLimits.maxCount,
              maxChars: stickyNotesLimits.maxChars,
            })
          : t('common.saveError'),
        type: 'error',
        category: 'error',
        sessionId,
      })
    }
  }, [sessionId, setStickyNotes, notify, t, stickyNotesLimits.maxCount, stickyNotesLimits.maxChars])

  const handleUpdateNote = useCallback(async (noteId: string, content: string) => {
    try {
      const result = await synthApi.updateStickyNote(sessionId, noteId, { content })
      setStickyNotes(sessionId, result.notes)
    } catch {
      notify({ text: t('common.saveError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStickyNotes, notify, t])

  const handleToggleNote = useCallback(async (noteId: string, disabled: boolean) => {
    try {
      const result = await synthApi.updateStickyNote(sessionId, noteId, { disabled })
      setStickyNotes(sessionId, result.notes)
    } catch {
      // ignore
    }
  }, [sessionId, setStickyNotes])

  const handleDeleteNote = useCallback(async (noteId: string) => {
    try {
      const result = await synthApi.deleteStickyNote(sessionId, noteId)
      setStickyNotes(sessionId, result.notes)
    } catch {
      notify({ text: t('common.saveError'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, setStickyNotes, notify, t])

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background w-full">
      {summarizationPending && !isSubagent && (
        <div className="flex items-center gap-2 px-4 py-2 bg-status-warning/10 border-b border-status-warning/20">
          <span className="text-xs text-status-warning flex-1">
            {t('rightPanel.context.summarizationPendingBanner')}
          </span>
          <button
            onClick={handleSummarizeNow}
            className="rounded px-2 py-0.5 text-xs font-medium text-status-warning hover:bg-status-warning/10 transition-colors"
          >
            {t('rightPanel.context.summarizeNow')}
          </button>
          <button
            onClick={handleCancelSummarization}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {stickyNotes.length > 0 && (
        <StickyNotesPanel
          notes={stickyNotes}
          onUpdate={handleUpdateNote}
          onToggle={handleToggleNote}
          onDelete={handleDeleteNote}
        />
      )}

      {isEmpty && !isSubagent ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          {sendBlocked && <SendBlockedPanel state={sendBlocked} />}
          <ChatInput
            sessionId={sessionId}
            agents={agentsRef.current}
            isStreaming={isStreaming}
            onSend={handleSend}
            sendMode={sendMode}
            onStop={handleStop}
            onStopQueue={handleStopAll}
            onCreateNote={handleCreateNote}
            expanded={false}
            onToggleExpand={() => setInputExpanded((v) => !v)}
          />
        </div>
      ) : (
        <>
          {!inputExpanded && (
            <MessageList
              messages={messages}
              turn={activeTurn}
              sessionId={sessionId}
              onCopy={handleCopy}
              onToggle={handleToggle}
              onPin={handlePin}
              onPinTurn={handlePinTurn}
              onDelete={handleDelete}
              onRetry={handleRetry}
              onDebug={handleDebug}
              onFork={handleFork}
              readOnly={isReadOnly}
              isSubagent={isSubagent}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onSelectRange={handleSelectRange}
              retry={streamRetry}
              onRetryNow={handleRetryNow}
              onCancelRetry={handleCancelRetry}
              hasOlder={historyPage?.hasMore === true}
              onLoadOlder={handleLoadOlder}
            />
          )}

          {!inputExpanded && !isSubagent && finalError && (
            <StreamErrorPanel
              error={finalError.error}
              errorType={finalError.errorType}
              onRetry={handleRetryLastFailed}
              onHybridLogin={handleHybridLogin}
            />
          )}

          {!inputExpanded && !isSubagent && sendBlocked && (
            <SendBlockedPanel state={sendBlocked} />
          )}

          {!inputExpanded && !isSubagent && (
            <ContextWarningPanel sessionId={sessionId} />
          )}

          {!inputExpanded && !isSubagent && (
            <QueuePanel
              pending={pending}
              isStalled={queue?.isStalled ?? false}
              pendingCount={queue?.pendingCount ?? 0}
              canSteer={isStreaming}
              // «Стоп» оставляет очередь в покое (автозапуска нет) — продолжить
              // обработку можно кнопкой в панели очереди.
              canResume={pending.length > 0 && !isStreaming}
              onResume={handleResumeQueue}
              onClear={handleClearQueue}
              onReturnAll={handleReturnQueue}
              onReturnMsg={handleReturnMsg}
              onSteerMsg={handleSteerMsg}
              onRemoveMsg={handleRemoveMsg}
              onReorder={handleReorderQueue}
            />
          )}

          {!inputExpanded && !isSubagent && (
            <PermissionRequestBar sessionId={sessionId} />
          )}

          {!inputExpanded && !isSubagent && (
            <QuestionDock sessionId={sessionId} />
          )}

          {isSubagent ? (
            <>
              <SubagentResumeBar
                sessionId={sessionId}
                lastError={lastSessionError}
                onResume={handleResumeSubagent}
                onStop={handleStopSubagentResume}
              />
              <div className="shrink-0 mx-auto mt-2 mb-2 w-4/5 rounded-xl border border-border/60 bg-surface-subtle px-4 py-3 text-center">
                <p className="text-xs text-muted-foreground">{t('chat.input.readOnly')}</p>
              </div>
            </>
          ) : (
            <ChatInput
              sessionId={sessionId}
              agents={agentsRef.current}
              isStreaming={isStreaming}
              onSend={handleSend}
              sendMode={sendMode}
              onStop={handleStop}
              onStopQueue={handleStopAll}
              onCreateNote={handleCreateNote}
              expanded={inputExpanded}
              onToggleExpand={() => setInputExpanded((v) => !v)}
            />
          )}
        </>
      )}

      {debugMessage?.debug_data && Object.keys(debugMessage.debug_data).length > 0 && (
        <DebugModal
          debug={debugMessage.debug_data as import('@/stores/chatStore').DebugData}
          onClose={closeDebugModal}
        />
      )}
    </div>
  )
}
