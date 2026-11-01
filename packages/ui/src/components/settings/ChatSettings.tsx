import { useMemo } from 'react'
import { useUIStore, type ChatDensity } from "../../stores/useUIStore"
import { useI18n } from "@/lib/i18n"
import {
  SegmentedControl,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  SettingsItem,
  useSettingsDraft,
  type SegmentedControlOption,
} from '../ui/settings'

type IntermediateTextDisplay = 'inline' | 'bottom'

/** Черновик панели «Чат»: обе настройки сохраняются одной кнопкой Save. */
interface ChatSettingsDraft {
  intermediateTextDisplay: IntermediateTextDisplay
  chatDensity: ChatDensity
}

const CHAT_SETTINGS_DEFAULTS: ChatSettingsDraft = {
  intermediateTextDisplay: 'inline',
  chatDensity: 'normal',
}

export const ChatSettings = () => {
  const { t } = useI18n()
  const intermediateTextDisplay = useUIStore((s) => s.intermediateTextDisplay)
  const setIntermediateTextDisplay = useUIStore((s) => s.setIntermediateTextDisplay)
  const chatDensity = useUIStore((s) => s.chatDensity)
  const setChatDensity = useUIStore((s) => s.setChatDensity)

  // Объект значения мемоизирован: `useSettingsDraft` синхронизирует черновик по
  // идентичности `value`, новая ссылка на каждом рендере зациклила бы эффект.
  const value = useMemo<ChatSettingsDraft>(
    () => ({
      intermediateTextDisplay: intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline',
      chatDensity: chatDensity === 'compact' ? 'compact' : 'normal',
    }),
    [intermediateTextDisplay, chatDensity],
  )

  // ADR-072 (фидбек): без автосохранения — выбор меняет черновик, стор
  // обновляется и персистится только по кнопке Save.
  const draft = useSettingsDraft<ChatSettingsDraft>({
    value,
    defaultValue: CHAT_SETTINGS_DEFAULTS,
    onSave: async (next) => {
      setIntermediateTextDisplay(next.intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline')
      setChatDensity(next.chatDensity === 'compact' ? 'compact' : 'normal')
      return next
    },
  })

  const current: ChatSettingsDraft = draft.draft ?? CHAT_SETTINGS_DEFAULTS
  const display: IntermediateTextDisplay =
    current.intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline'
  const density: ChatDensity = current.chatDensity === 'compact' ? 'compact' : 'normal'

  const options: SegmentedControlOption<IntermediateTextDisplay>[] = [
    { value: 'inline', label: t('chatSettings.intermediateTextInline') },
    { value: 'bottom', label: t('chatSettings.intermediateTextBottom') },
  ]
  const densityOptions: SegmentedControlOption<ChatDensity>[] = [
    { value: 'normal', label: t('chatSettings.densityNormal') },
    { value: 'compact', label: t('chatSettings.densityCompact') },
  ]

  return (
    <SettingsPanel
      title={t('settings.category.chat')}
      description={t('chatSettings.intermediateTextDescription')}
    >
      <SettingsSection
        id="chat-intermediate-text"
        title={t('chatSettings.intermediateTextDisplay')}
      >
        <SettingsItem>
          <SegmentedControl<IntermediateTextDisplay>
            value={display}
            options={options}
            onChange={(value) => draft.update({ intermediateTextDisplay: value })}
            ariaLabel={t('chatSettings.intermediateTextDisplay')}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection
        id="chat-density"
        title={t('chatSettings.density')}
        description={t('chatSettings.densityDescription')}
      >
        <SettingsItem>
          <SegmentedControl<ChatDensity>
            value={density}
            options={densityOptions}
            onChange={(value) => draft.update({ chatDensity: value })}
            ariaLabel={t('chatSettings.density')}
          />
        </SettingsItem>
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
        saveTestId="chat-save"
        cancelTestId="chat-cancel"
        resetTestId="chat-reset"
      />
    </SettingsPanel>
  )
}
