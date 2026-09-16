import { useUIStore } from "../../stores/useUIStore"
import { useI18n } from "@/lib/i18n"
import { SettingsPage, SettingsCard, SegmentedControl, type SegmentedControlOption } from './settings-layout'

type IntermediateTextDisplay = 'inline' | 'bottom'

export const ChatSettings = () => {
  const { t } = useI18n()
  const intermediateTextDisplay = useUIStore((s) => s.intermediateTextDisplay)
  const setIntermediateTextDisplay = useUIStore((s) => s.setIntermediateTextDisplay)

  const display: IntermediateTextDisplay = intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline'
  const options: SegmentedControlOption<IntermediateTextDisplay>[] = [
    { value: 'inline', label: t('chatSettings.intermediateTextInline') },
    { value: 'bottom', label: t('chatSettings.intermediateTextBottom') },
  ]

  return (
    <SettingsPage
      title={t('settings.category.chat')}
      description={t('chatSettings.intermediateTextDescription')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsCard title={t('chatSettings.intermediateTextDisplay')}>
          <SegmentedControl<IntermediateTextDisplay>
            value={display}
            options={options}
            onChange={setIntermediateTextDisplay}
            ariaLabel={t('chatSettings.intermediateTextDisplay')}
          />
        </SettingsCard>
      </div>
    </SettingsPage>
  )
}
