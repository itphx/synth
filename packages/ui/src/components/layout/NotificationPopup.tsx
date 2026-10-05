import { useState, useRef, useEffect, useCallback } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useNotificationStore, type NotifyCategory, type NotificationItem } from '@/stores/notificationStore'
import { Icon } from '@/components/icon/Icon'

const STATUS_ICONS: Record<string, string> = {
  info: 'lightbulb',
  warning: 'error-warning',
  error: 'close',
  success: 'check',
  stream: 'refresh',
}

const STATUS_ICON_CLASSES: Record<string, string> = {
  info: 'text-status-info',
  warning: 'text-status-warning',
  error: 'text-status-error',
  success: 'text-status-success',
  stream: 'text-primary animate-spin',
}

const CATEGORY_LABELS: Record<NotifyCategory, string> = {
  connection: 'WS',
  streaming: 'GEN',
  queue: 'QUE',
  message: 'MSG',
  error: 'ERR',
  system: 'SYS',
}

const CATEGORY_COLORS: Record<NotifyCategory, string> = {
  connection: 'bg-status-info/20 text-status-info',
  streaming: 'bg-primary/20 text-primary',
  queue: 'bg-status-warning/20 text-status-warning',
  message: 'bg-status-info/20 text-status-info',
  error: 'bg-status-error/20 text-status-error',
  system: 'bg-muted text-muted-foreground',
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface RowProps {
  item: NotificationItem
  isRead: boolean
  onDismiss: (id: string) => void
  onRead: (id: string) => void
}

function NotificationRow({ item, isRead, onDismiss, onRead }: RowProps) {
  return (
    <div
      onClick={() => { if (!isRead) onRead(item.id) }}
      className={`flex items-start gap-2 rounded px-2 py-1.5 hover:bg-interactive-hover transition-colors group cursor-pointer ${isRead ? 'opacity-40' : ''}`}
    >
      <span
        className="inline-flex shrink-0 text-[0.5rem] font-medium px-1 py-px rounded leading-none mt-0.5"
        style={{ minWidth: 'auto' }}
      >
        <span className={CATEGORY_COLORS[item.category] || ''} style={{ padding: '0 0.1875rem', borderRadius: '0.125rem', lineHeight: '0.875rem' }}>
          {CATEGORY_LABELS[item.category] || '?'}
        </span>
      </span>
      <Icon
        name={STATUS_ICONS[item.type] || 'information'}
        className={`size-3 shrink-0 mt-0.5 ${STATUS_ICON_CLASSES[item.type] || 'text-muted-foreground'}`}
      />
      <span className="flex-1 min-w-0 text-xs leading-snug truncate">
        <span className="text-foreground">{item.text}</span>
        {item.sessionId && (
          <span className="text-muted-foreground/50 ml-1">— {item.sessionId}</span>
        )}
      </span>
      <span className="shrink-0 text-[0.625rem] text-muted-foreground/40 tabular-nums mt-0.5">
        {formatTime(item.timestamp)}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(item.id) }}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Icon name="close" className="size-2.5" />
      </button>
    </div>
  )
}

export function NotificationPopup() {
  const { t } = useI18n()
  const history = useNotificationStore(s => s.history)
  const dismiss = useNotificationStore(s => s.dismiss)
  const dismissAll = useNotificationStore(s => s.dismissAll)
  const markRead = useNotificationStore(s => s.markRead)
  const markAllRead = useNotificationStore(s => s.markAllRead)
  const setSettingsDialogOpen = useUIStore(s => s.setSettingsDialogOpen)
  const setSettingsPage = useUIStore(s => s.setSettingsPage)
  const [isOpen, setIsOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)

  const visible = history.filter((m) => !m.dismissed)
  const unreadCount = visible.filter((m) => m.readAt === 0).length

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handler)
    }
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  const handleOpenSettings = useCallback(() => {
    setIsOpen(false)
    setSettingsPage('notifications')
    setSettingsDialogOpen(true)
  }, [setSettingsDialogOpen, setSettingsPage])

  return (
    <div className="relative" ref={popupRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative rounded-lg p-2 text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors"
        title={t('notifications.popup.title')}
      >
        <Icon name="notification-3" className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0 h-3.5 min-w-[0.875rem] rounded-full bg-primary text-[0.5rem] font-medium text-primary-foreground flex items-center justify-center px-0.5 leading-none pointer-events-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="notifications-popup absolute right-0 top-full mt-1 w-[45rem] max-w-[calc(100vw-1rem)] rounded-lg border bg-card shadow-lg z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium text-foreground">{t('notifications.popup.title')}</span>
            <div className="flex items-center gap-0.5">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                  title={t('notifications.popup.markAllRead')}
                >
                  <Icon name="check" className="size-3.5" />
                </button>
              )}
              {visible.length > 0 && (
                <button
                  onClick={dismissAll}
                  className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-interactive-hover transition-colors"
                  title={t('notifications.popup.clear')}
                >
                  <Icon name="delete-bin" className="size-3.5" />
                </button>
              )}
              <button
                onClick={handleOpenSettings}
                className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                title={t('notifications.popup.openSettings')}
              >
                <Icon name="settings-3" className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto p-1">
            {visible.length === 0 ? (
              <div className="flex items-center justify-center py-1.5 text-xs text-muted-foreground/50">
                {t('notifications.popup.noNotifications')}
              </div>
            ) : (
              <div className="flex flex-col gap-px">
                {visible.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    isRead={item.readAt > 0}
                    onDismiss={dismiss}
                    onRead={markRead}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
