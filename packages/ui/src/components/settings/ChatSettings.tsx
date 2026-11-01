import { useMemo } from 'react'
import { useUIStore, type ChatDensity, type ChatViewMode } from "../../stores/useUIStore"
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
  chatViewMode: ChatViewMode
  intermediateTextDisplay: IntermediateTextDisplay
  chatDensity: ChatDensity
}

const CHAT_SETTINGS_DEFAULTS: ChatSettingsDraft = {
  chatViewMode: 'detailed',
  intermediateTextDisplay: 'inline',
  chatDensity: 'normal',
}

export const ChatSettings = () => {
  const { t } = useI18n()
  const chatViewMode = useUIStore((s) => s.chatViewMode)
  const setChatViewMode = useUIStore((s) => s.setChatViewMode)
  const intermediateTextDisplay = useUIStore((s) => s.intermediateTextDisplay)
  const setIntermediateTextDisplay = useUIStore((s) => s.setIntermediateTextDisplay)
  const chatDensity = useUIStore((s) => s.chatDensity)
  const setChatDensity = useUIStore((s) => s.setChatDensity)

  // Объект значения мемоизирован: `useSettingsDraft` синхронизирует черновик по
  // идентичности `value`, новая ссылка на каждом рендере зациклила бы эффект.
  const value = useMemo<ChatSettingsDraft>(
    () => ({
      chatViewMode: chatViewMode === 'feed' ? 'feed' : 'detailed',
      intermediateTextDisplay: intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline',
      chatDensity: chatDensity === 'compact' ? 'compact' : 'normal',
    }),
    [chatViewMode, intermediateTextDisplay, chatDensity],
  )

  // ADR-072 (фидбек): без автосохранения — выбор меняет черновик, стор
  // обновляется и персистится только по кнопке Save.
  const draft = useSettingsDraft<ChatSettingsDraft>({
    value,
    defaultValue: CHAT_SETTINGS_DEFAULTS,
    onSave: async (next) => {
      setChatViewMode(next.chatViewMode === 'feed' ? 'feed' : 'detailed')
      setIntermediateTextDisplay(next.intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline')
      setChatDensity(next.chatDensity === 'compact' ? 'compact' : 'normal')
      return next
    },
  })

  const current: ChatSettingsDraft = draft.draft ?? CHAT_SETTINGS_DEFAULTS
  const viewMode: ChatViewMode = current.chatViewMode === 'feed' ? 'feed' : 'detailed'
  const display: IntermediateTextDisplay =
    current.intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline'
  const density: ChatDensity = current.chatDensity === 'compact' ? 'compact' : 'normal'

  const viewModeOptions: SegmentedControlOption<ChatViewMode>[] = [
    { value: 'detailed', label: t('chatSettings.viewModeDetailed') },
    { value: 'feed', label: t('chatSettings.viewModeFeed') },
  ]
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
      description={t('chatSettings.description')}
    >
      {/* Вид важнее плотности — первой секцией панели. */}
      <SettingsSection
        id="chat-view-mode"
        title={t('chatSettings.viewMode')}
        description={t('chatSettings.viewModeDescription')}
      >
        <SettingsItem>
          <SegmentedControl<ChatViewMode>
            value={viewMode}
            options={viewModeOptions}
            onChange={(value) => draft.update({ chatViewMode: value })}
            ariaLabel={t('chatSettings.viewMode')}
          />
        </SettingsItem>
      </SettingsSection>

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
