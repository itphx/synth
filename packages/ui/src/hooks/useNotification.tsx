import { useCallback } from 'react'
import { toast } from 'react-toastify'
import { useNotificationStore, type NotifyOptions } from '@/stores/notificationStore'
import { useUIStore } from '@/stores/useUIStore'

function ToastContent({ text, sessionId }: { text: string; sessionId?: string }) {
  return (
    <div className="min-w-0">
      {sessionId && <div className="text-[11px] opacity-50 mb-0.5 truncate">{sessionId}</div>}
      <div className="text-sm">{text}</div>
    </div>
  )
}

/**
 * Standalone-реализация уведомления (toast + история + непрочитанные счётчики).
 * Не зависит от React-хуков, поэтому может вызываться из zustand-сторов
 * (например, transportStore при stream.error).
 */
export function notifyMessage(opts: NotifyOptions): void {
  const { addToHistory, incSessionUnread, isCategoryEnabled } = useNotificationStore.getState()

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

  if (opts.sessionId) {
    const state = useUIStore.getState()
    const activeTab = state.centerTabs.find((t) => t.id === state.activeCenterTabId)
    const isActiveSession = activeTab?.data?.sessionId === opts.sessionId
    if (!isActiveSession) {
      incSessionUnread(opts.sessionId)
    }
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
