// Контроллер композера сессии (UI-1).
//
// Общая логика композера чата: отправка, «Стоп», заметки и всё, что касается
// очереди (панель очереди, «в разрыв», возврат в редактор, удаление, DnD).
// Логика вынесена из `ChatTab` без изменения семантики — чтобы будущий док
// «Спросить агента» в терминале (UI-2) использовал **тот же** контроллер,
// а не вторую копию правил очереди.
//
// Что НЕ здесь: лента, баннеры (ошибка хода, контекст, права, вопросы) и
// разметка — это остаётся у вызывающего (`ChatTab`).

import { useCallback, useEffect, useState } from 'react'
import type { SteerMode } from '@itphx/synth-shared/types'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useChatStore, type MessageData, type QueuedMessage, type QueueState } from '@/stores/chatStore'
import { useTransportStore } from '@/stores/transportStore'
import { synthApi } from '@/lib/api/synthApi'
import type { TerminalPromptContext } from '@/lib/api/sessions'
import { isQueueChangedError } from '@/lib/api/queue'
import { stickyNoteErrorKey, useStickyNotesLimits } from '@/lib/api/stickyNotesLimits'
import { sendBlockedFromError, type SendBlockedState } from './SendBlockedPanel'
import { toQueuedMessage } from './queueMessages'

/** Стабильная пустая очередь: иначе каждый рендер создаёт новый массив. */
const EMPTY_PENDING: QueuedMessage[] = []

/**
 * Отправка сообщения — сигнатура как у `ChatInput.onSend`.
 *
 * Пятый аргумент — **контекст терминала** (PROP-132, Ф4б): сервер сохраняет
 * его отдельным сообщением **до** вопроса, поэтому текст остаётся чистым.
 * Чат его не передаёт — там пятым аргументом ничего нет.
 */
export type SessionComposerSend = (
  text: string,
  agentRole?: string,
  mode?: SteerMode,
  attachmentIds?: string[],
  context?: TerminalPromptContext,
) => Promise<void>

/** Контроллер композера: состояние + обработчики. */
export interface SessionComposerController {
  /** Сессия, к которой относится композер. */
  sessionId: string
  /** Строки очереди (pending-сообщения сессии). */
  pending: QueuedMessage[]
  /** Счётчики/статусы очереди (`null` — очереди нет). */
  queue: QueueState | null
  /** Плашка «отправка заблокирована» (`null` — отправка разрешена). */
  sendBlocked: SendBlockedState | null
  /** Отправка сообщения (ошибка пробрасывается композеру). */
  handleSend: SessionComposerSend
  /** «Стоп»: отмена ретрая либо активного хода. */
  handleStop: () => Promise<void>
  /** «Стоп» + очистка очереди. */
  handleStopAll: () => Promise<void>
  /** Создание липкой заметки. */
  handleCreateNote: (text: string) => Promise<void>
  /** «Продолжить» — возобновление обработки очереди. */
  handleResumeQueue: () => Promise<void>
  /** «Очистить очередь». */
  handleClearQueue: () => Promise<void>
  /** «Вернуть в редактор» — все сообщения очереди. */
  handleReturnQueue: () => Promise<void>
  /** «Вернуть в редактор» — одно сообщение очереди (по индексу в панели). */
  handleReturnMsg: (uiIndex: number) => Promise<void>
  /** «В разрыв» — отправить сообщение очереди в текущий ход. */
  handleSteerMsg: (uiIndex: number) => Promise<void>
  /** «Удалить» — снять сообщение очереди (текст выбрасывается). */
  handleRemoveMsg: (uiIndex: number) => Promise<void>
  /** DnD-переупорядочивание очереди (серверные id в желаемом порядке). */
  handleReorderQueue: (ids: string[]) => Promise<void>
}

/**
 * Контроллер композера сессии.
 *
 * Состояние очереди берётся из `chatStore`, отправка — из `transportStore`,
 * провайдер/модель/агент — из их сторов. Хук не монтирует транспорт и не
 * знает про разметку — только правила отправки и очереди.
 */
export function useSessionComposer(sessionId: string): SessionComposerController {
  const { t } = useI18n()
  const { notify } = useNotification()

  const pending = useChatStore((s) => s.pendingBySession[sessionId]) || EMPTY_PENDING
  const queue = useChatStore((s) => s.queueBySession[sessionId]) ?? null

  // Отправка заблокирована отключённым провайдером/моделью: понятная плашка
  // над композером (вместо общего тоста). Снимается при успешной отправке,
  // смене модели/провайдера и переключении сессии.
  const selectedProviderName = useProvidersStore((s) => s.selectedProviderName)
  const selectedModelName = useProvidersStore((s) => s.selectedModelName)
  const [sendBlocked, setSendBlocked] = useState<SendBlockedState | null>(null)
  useEffect(() => {
    setSendBlocked(null)
  }, [sessionId, selectedProviderName, selectedModelName])

  // Лимиты заметок нужны для понятного текста отказа (409/400) вместо общего.
  const stickyNotesLimits = useStickyNotesLimits()

  const handleSend = useCallback<SessionComposerSend>(
    async (text, agentRole, mode, attachmentIds, context) => {
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
        // PROP-132: `context` (вывод терминала) — отдельное сообщение-контекст.
        await useTransportStore.getState().sendMessage(sessionId, text, effectiveAgentRole, selectedProviderName || undefined, selectedModelName || undefined, mode, attachmentIds, context)
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
        useChatStore.getState().setStreamRetry(sessionId, null)
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
  }, [sessionId])

  const handleStopAll = useCallback(async () => {
    try {
      useTransportStore.getState().cancel(sessionId)
      await synthApi.clearQueue(sessionId)
      useChatStore.getState().clearQueueState(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleCreateNote = useCallback(async (text: string) => {
    try {
      const result = await synthApi.addStickyNote(sessionId, text)
      useChatStore.getState().setStickyNotes(sessionId, result.notes)
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
  }, [sessionId, notify, t, stickyNotesLimits.maxCount, stickyNotesLimits.maxChars])

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
        useChatStore.getState().clearQueueState(sessionId)
        return
      }
      const hasActiveStream = data.current_stream != null
        || useChatStore.getState().turnBySession[sessionId]?.status === 'streaming'
      const displayMsgs = hasActiveStream ? pendingMsgs.slice(1) : pendingMsgs
      if (displayMsgs.length === 0) {
        useChatStore.getState().clearQueueState(sessionId)
        return
      }
      useChatStore.getState().setPendingMessages(sessionId, displayMsgs.map(toQueuedMessage))
      useChatStore.getState().updateQueueCount(sessionId, displayMsgs.length)
    } catch {
      // Сеть/сервер недоступны — оставляем UI как есть, ошибку показал вызывающий.
    }
  }, [sessionId])

  const handleResumeQueue = useCallback(async () => {
    try {
      await synthApi.resumeQueue(sessionId)
      useChatStore.getState().clearQueueState(sessionId)
      notify({ text: t('chat.queue.resumed'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.resumeQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, notify, t])

  const handleClearQueue = useCallback(async () => {
    try {
      await synthApi.clearQueue(sessionId)
      useChatStore.getState().clearQueueState(sessionId)
      notify({ text: t('chat.queue.cleared'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.clearQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, notify, t])

  const handleReturnQueue = useCallback(async () => {
    try {
      const resp = await synthApi.returnQueue(sessionId)
      const data = resp as { texts?: string[] }
      if (data?.texts && data.texts.length > 0) {
        useChatStore.getState().setRetryInput(sessionId, data.texts.join('\n\n'))
        useChatStore.getState().setPendingMessages(sessionId, [])
        useChatStore.getState().clearQueueState(sessionId)
        notify({ text: t('chat.queue.returned'), type: 'success', category: 'queue', sessionId })
      } else {
        notify({ text: t('chat.queue.empty'), type: 'info', category: 'queue', sessionId })
      }
    } catch {
      notify({ text: t('chat.error.returnQueue'), type: 'error', category: 'queue', sessionId })
    }
  }, [sessionId, notify, t])

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
        useChatStore.getState().setRetryInput(sessionId, data.texts[0])
        const cur = useChatStore.getState().pendingBySession[sessionId] || []
        useChatStore.getState().setPendingMessages(sessionId, cur.filter((_, i) => i !== uiIndex))
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
  }, [sessionId, notify, t, pending, refreshQueueFromApi])

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
    useChatStore.getState().reorderPending(sessionId, ids)
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
  }, [sessionId, refreshQueueFromApi, notify, t])

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

  return {
    sessionId,
    pending,
    queue,
    sendBlocked,
    handleSend,
    handleStop,
    handleStopAll,
    handleCreateNote,
    handleResumeQueue,
    handleClearQueue,
    handleReturnQueue,
    handleReturnMsg,
    handleSteerMsg,
    handleRemoveMsg,
    handleReorderQueue,
  }
}
