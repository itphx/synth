import { useI18n } from '@/lib/i18n'
import { useNotificationStore, type NotifyCategory } from '@/stores/notificationStore'
import { Toggle } from '@/components/ui/Toggle'
import { SettingsPage, SettingsCard } from './settings-layout'

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
  const prefs = useNotificationStore(s => s.prefs)
  const setCategoryEnabled = useNotificationStore(s => s.setCategoryEnabled)

  return (
    <SettingsPage title={t('notifications.title')} description={t('notifications.description')}>
      <SettingsCard>
        <div className="grid gap-4 sm:grid-cols-2">
          {CATEGORIES.map((cat) => (
            <div key={cat.id} className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{t(cat.labelKey)}</div>
                <div className="text-xs text-muted-foreground">{t(cat.descKey)}</div>
              </div>
              <Toggle
                enabled={prefs.enabledCategories[cat.id]}
                onToggle={() => setCategoryEnabled(cat.id, !prefs.enabledCategories[cat.id])}
                ariaLabel={t(cat.labelKey)}
              />
            </div>
          ))}
        </div>
      </SettingsCard>
    </SettingsPage>
  )
}
