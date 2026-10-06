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
  /** Проброс `fluid` в Kit `SliderField` (растянуть слайдер в узком контейнере). */
  fluid?: boolean
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
  fluid,
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
    fluid={fluid}
    formatValue={(v) => `${Math.round(v * 100)}%`}
  />
)

export interface UiScaleControlProps {
  /**
   * Контролируемый режим: значение и обработчик из черновика (без записи в стор).
   * Без них контрол работает с `useUIStore.uiScale`.
   */
  value?: number
  onChange?: (value: number) => void
  stacked?: boolean
  /** Проброс `fluid` (узкий контейнер: поповер быстрых настроек). */
  fluid?: boolean
}

export const UiScaleControl = ({ value, onChange, stacked, fluid }: UiScaleControlProps) => {
  const { t } = useI18n()
  const storeScale = useUIStore((state) => state.uiScale)
  const setStoreScale = useUIStore((state) => state.setUiScale)

  const controlled = value !== undefined && onChange !== undefined
  const uiScale = value !== undefined ? value : storeScale
  const handleChange = (next: number) => {
    if (controlled) {
      onChange?.(next)
    } else {
      setStoreScale(next)
    }
  }
  const percent = Math.round(uiScale * 100)
  const isDefault = percent === Math.round(getDefaultUiScale() * 100)

  return (
    <UiScaleSlider
      value={uiScale}
      onChange={handleChange}
      label={t('settings.appearance.uiScale.label')}
      onReset={() => handleChange(getDefaultUiScale())}
      resetDisabled={isDefault}
      resetTitle={t('settings.appearance.uiScale.reset')}
      stacked={stacked}
      fluid={fluid}
    />
  )
}
