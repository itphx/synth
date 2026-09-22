import { useUIStore } from "../../stores/useUIStore"
import { useI18n } from "@/lib/i18n"
import {
  SegmentedControl,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  useSettingsDraft,
  type SegmentedControlOption,
} from '../ui/settings'

type IntermediateTextDisplay = 'inline' | 'bottom'

export const ChatSettings = () => {
  const { t } = useI18n()
  const intermediateTextDisplay = useUIStore((s) => s.intermediateTextDisplay)
  const setIntermediateTextDisplay = useUIStore((s) => s.setIntermediateTextDisplay)

  // AD-072 (фидбек): без автосохранения — выбор меняет черновик, стор
  // обновляется и персистится только по кнопке Save.
  const draft = useSettingsDraft<IntermediateTextDisplay>({
    value: intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline',
    defaultValue: 'inline',
    onSave: async (next) => {
      setIntermediateTextDisplay(next)
      return next
    },
  })

  const display: IntermediateTextDisplay = draft.draft === 'bottom' ? 'bottom' : 'inline'
  const options: SegmentedControlOption<IntermediateTextDisplay>[] = [
    { value: 'inline', label: t('chatSettings.intermediateTextInline') },
    { value: 'bottom', label: t('chatSettings.intermediateTextBottom') },
  ]

  return (
    <SettingsPanel
      title={t('settings.category.chat')}
      description={t('chatSettings.intermediateTextDescription')}
    >
      <SettingsSection title={t('chatSettings.intermediateTextDisplay')}>
        <SegmentedControl<IntermediateTextDisplay>
          value={display}
          options={options}
          onChange={(value) => draft.setDraft(value)}
          ariaLabel={t('chatSettings.intermediateTextDisplay')}
        />
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
