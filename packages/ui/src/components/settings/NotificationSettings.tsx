import { useI18n } from '@/lib/i18n'
import { DEFAULT_ENABLED, useNotificationStore, type NotifyCategory } from '@/stores/notificationStore'
import {
  SettingsActions,
  SettingsItem,
  SettingsPanel,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

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
  const setAllCategories = useNotificationStore(s => s.setAllCategories)

  // AD-072 (фидбек): без автосохранения. Тумблеры меняют только черновик;
  // стор и persist обновляются по кнопке Save.
  const draft = useSettingsDraft<Record<NotifyCategory, boolean>>({
    value: prefs.enabledCategories,
    defaultValue: DEFAULT_ENABLED,
    onSave: async (next) => {
      setAllCategories(next)
      return next
    },
  })

  const enabled = draft.draft ?? prefs.enabledCategories

  const toggle = (category: NotifyCategory) => {
    draft.setDraft({ ...enabled, [category]: !enabled[category] })
  }

  return (
    <SettingsPanel title={t('notifications.title')} description={t('notifications.description')}>
      <SettingsSection>
        {CATEGORIES.map((cat) => (
          <SettingsItem key={cat.id}>
            <ToggleField
              label={t(cat.labelKey)}
              description={t(cat.descKey)}
              enabled={enabled[cat.id]}
              onToggle={() => toggle(cat.id)}
            />
          </SettingsItem>
        ))}
      </SettingsSection>

      <SettingsActions
        align="start"
        onSave={() => void draft.save()}
        onCancel={() => draft.revert()}
        onReset={() => draft.resetToDefault()}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        isDefault={draft.isDefault}
        saveTestId="notifications-save"
        cancelTestId="notifications-cancel"
        resetTestId="notifications-reset"
      />
    </SettingsPanel>
  )
}
