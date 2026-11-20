import { useCallback } from 'react'
import { toast } from 'react-toastify'
import { useNotificationStore, type NotifyOptions } from '@/stores/notificationStore'
import { useUIStore } from '@/stores/useUIStore'
import { i18nText } from '@/lib/i18n/text'

function ToastContent({ text, sessionId }: { text: string; sessionId?: string }) {
  return (
    <div className="min-w-0">
      {sessionId && <div className="text-[0.6875rem] opacity-50 mb-0.5 truncate">{sessionId}</div>}
      <div className="text-sm">{text}</div>
    </div>
  )
}

/** Открыта ли сессия в **активной** центральной вкладке. */
function isSessionActive(sessionId: string): boolean {
  const state = useUIStore.getState()
  const activeTab = state.centerTabs.find((t) => t.id === state.activeCenterTabId)
  return activeTab?.data?.sessionId === sessionId
}

/**
 * Standalone-реализация уведомления (toast + история + непрочитанные счётчики).
 * Не зависит от React-хуков, поэтому может вызываться из zustand-сторов
 * (например, transportStore при stream.error).
 *
 * Правило: **unread ⇒ требует действия**. Оранжевый цвет названия сессии в
 * дереве означает «требуется действие пользователя», а не «есть новое
 * сообщение»: счётчик инкрементится только при `requiresAction: true`
 * (вопрос агента, подтверждение прав, остановленная очередь). Всё остальное —
 * «просто тост»: запись в историю и всплывающее уведомление остаются, счётчик
 * и цвет не трогаются (фоновый прогон завершён, служебное сообщение, успешная
 * операция, терминальная ошибка хода — её цвет даёт durable `status.last_turn`).
 */
export function notifyMessage(opts: NotifyOptions): void {
  const { addToHistory, incSessionUnread, isCategoryEnabled, isUnreadSuppressed } =
    useNotificationStore.getState()

  addToHistory(opts)

  if (isCategoryEnabled(opts.category)) {
    const content = <ToastContent text={opts.text} sessionId={opts.sessionId} />
    const baseOptions = { autoClose: 5000, closeButton: true }
    switch (opts.type) {
      case 'success':
        toast.success(content, baseOptions)
        break
      case 'warning':
        toast.warning(content, baseOptions)
        break
      case 'error':
        toast.error(content, { ...baseOptions, autoClose: 8000 })
        break
      case 'info':
      case 'stream':
        toast.info(content, baseOptions)
        break
    }
  }

  if (!opts.sessionId) return
  // Единственная точка инкремента: «unread ⇒ требует действия».
  if (opts.requiresAction !== true) return
  // Подавленная сессия (открыт док «Спросить агента») не подсвечивается
  // непрочитанным: человек и так видит ответ.
  if (isUnreadSuppressed(opts.sessionId)) return
  // Уже открытая сессия непрочитанного не накапливает.
  if (isSessionActive(opts.sessionId)) return
  incSessionUnread(opts.sessionId)
}

/**
 * Минимум полей сессии, нужный для сводного тоста «требуется действие».
 *
 * Берём только срез, а не весь `SessionData`: тост не должен зависеть от
 * остального DTO, а `queue_stopped` — аддитивное поле `status`.
 */
export interface SessionActionProbe {
  id: string
  pending_approvals?: number
  status?: { blocked?: string | null; queue_stopped?: boolean } | null
}

/**
 * Сводные тосты «требуется действие» по загруженному списку сессий.
 *
 * Второй путь доставки того же правила: страница была закрыта, и ожидание
 * (`permission.asked` / остановленная очередь) уже висело — живого события
 * клиент не увидит вовсе. Вызывается на загрузке списка сессий
 * (`stores/sessionsStore.ts`).
 *
 * Один тост на сессию: метка «уже уведомляли» живёт в `notificationStore`
 * (`actionNotified`) и снимается, когда ожидание исчезло — тогда следующее
 * ожидание снова даст ровно один тост. Открытая сессия не уведомляется: в ней
 * карточка подтверждения/баннер остановки и так на экране.
 */
export function notifyPendingActionSessions(sessions: readonly SessionActionProbe[]): void {
  const notif = useNotificationStore.getState()

  for (const session of sessions) {
    const pendingApprovals = session.pending_approvals ?? 0
    const queueStopped = session.status?.queue_stopped === true
    if (pendingApprovals <= 0 && !queueStopped) {
      // Ожидание снято — метка сбрасывается (следующее ожидание снова уведомит).
      notif.clearActionNotified(session.id)
      continue
    }
    if (isSessionActive(session.id)) continue
    if (notif.isActionNotified(session.id)) continue
    notif.markActionNotified(session.id)
    notifyMessage({
      text:
        pendingApprovals > 0
          ? i18nText('notify.action.pendingApprovals', { count: pendingApprovals })
          : i18nText('notify.action.queueStopped'),
      type: 'info',
      category: 'system',
      sessionId: session.id,
      requiresAction: true,
    })
  }
}

export function useNotification() {
  const notify = useCallback(
    (opts: NotifyOptions) => {
      notifyMessage(opts)
    },
    []
  )

  return { notify }
}
