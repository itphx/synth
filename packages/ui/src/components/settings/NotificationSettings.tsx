import { useI18n } from '@/lib/i18n'
import { useNotificationStore, type NotifyCategory } from '@/stores/notificationStore'

const CATEGORIES: { id: NotifyCategory; labelKey: string; descKey: string }[] = [
  { id: 'connection', labelKey: 'notifications.category.connection', descKey: 'notifications.category.connection.desc' },
  { id: 'streaming', labelKey: 'notifications.category.streaming', descKey: 'notifications.category.streaming.desc' },
  { id: 'queue', labelKey: 'notifications.category.queue', descKey: 'notifications.category.queue.desc' },
  { id: 'message', labelKey: 'notifications.category.message', descKey: 'notifications.category.message.desc' },
  { id: 'error', labelKey: 'notifications.category.error', descKey: 'notifications.category.error.desc' },
  { id: 'system', labelKey: 'notifications.category.system', descKey: 'notifications.category.system.desc' },
]

export function NotificationSettings() {
  const { t } = useI18n()
  const { prefs, setCategoryEnabled } = useNotificationStore()

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-1">{t('notifications.title')}</h2>
      <p className="text-sm text-muted-foreground mb-6">{t('notifications.description')}</p>

      <div className="space-y-4">
        {CATEGORIES.map((cat) => (
          <label key={cat.id} className="flex items-start justify-between gap-4 cursor-pointer">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">{t(cat.labelKey)}</div>
              <div className="text-xs text-muted-foreground">{t(cat.descKey)}</div>
            </div>
            <input
              type="checkbox"
              checked={prefs.enabledCategories[cat.id]}
              onChange={(e) => setCategoryEnabled(cat.id, e.target.checked)}
              className="h-4 w-4 shrink-0 self-center rounded border-border bg-interactive accent-primary cursor-pointer"
            />
          </label>
        ))}
      </div>
    </div>
  )
}
