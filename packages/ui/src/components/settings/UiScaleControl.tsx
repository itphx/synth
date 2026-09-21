import React from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { getDefaultUiScale, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP } from '@/lib/uiScale'
import { SliderField } from '@/components/ui/settings'

export interface UiScaleSliderProps {
  value: number
  onChange: (value: number) => void
  label?: string
  onReset?: () => void
  resetDisabled?: boolean
  resetTitle?: string
  stacked?: boolean
}

/**
 * AD-072: обёртка над Kit `SliderField` для масштаба UI.
 * Значение — доля (0.5…1.2), подпись — проценты.
 */
export const UiScaleSlider: React.FC<UiScaleSliderProps> = ({
  value,
  onChange,
  label,
  onReset,
  resetDisabled,
  resetTitle,
  stacked,
}) => (
  <SliderField
    label={label}
    min={UI_SCALE_MIN}
    max={UI_SCALE_MAX}
    step={UI_SCALE_STEP}
    value={value}
    onValueChange={onChange}
    onReset={onReset}
    resetDisabled={resetDisabled}
    resetTitle={resetTitle}
    stacked={stacked}
    formatValue={(v) => `${Math.round(v * 100)}%`}
  />
)

export const UiScaleControl = ({ stacked }: { stacked?: boolean }) => {
  const { t } = useI18n()
  const uiScale = useUIStore((state) => state.uiScale)
  const setUiScale = useUIStore((state) => state.setUiScale)
  const percent = Math.round(uiScale * 100)
  const isDefault = percent === Math.round(getDefaultUiScale() * 100)

  return (
    <UiScaleSlider
      value={uiScale}
      onChange={setUiScale}
      label={t('settings.appearance.uiScale.label')}
      onReset={() => setUiScale(getDefaultUiScale())}
      resetDisabled={isDefault}
      resetTitle={t('settings.appearance.uiScale.reset')}
      stacked={stacked}
    />
  )
}
