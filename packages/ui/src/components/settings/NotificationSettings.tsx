import { useI18n } from '@/lib/i18n'
import { useNotificationStore, type NotifyCategory } from '@/stores/notificationStore'
import { SettingsPanel, SettingsSection, ToggleField } from '../ui/settings'

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
    <SettingsPanel title={t('notifications.title')} description={t('notifications.description')}>
      <SettingsSection>
        {CATEGORIES.map((cat) => (
          <ToggleField
            key={cat.id}
            label={t(cat.labelKey)}
            description={t(cat.descKey)}
            enabled={prefs.enabledCategories[cat.id]}
            onToggle={() => setCategoryEnabled(cat.id, !prefs.enabledCategories[cat.id])}
          />
        ))}
      </SettingsSection>
    </SettingsPanel>
  )
}
