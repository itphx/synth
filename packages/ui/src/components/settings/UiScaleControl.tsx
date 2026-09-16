import React from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { getDefaultUiScale, UI_SCALE_MIN, UI_SCALE_MAX } from '@/lib/uiScale'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

export interface UiScaleSliderProps {
  value: number
  onChange: (value: number) => void
  label?: string
  ariaLabel?: string
  onReset?: () => void
  resetDisabled?: boolean
  resetTitle?: string
  stacked?: boolean
}

export const UiScaleSlider: React.FC<UiScaleSliderProps> = ({
  value,
  onChange,
  label,
  ariaLabel,
  onReset,
  resetDisabled,
  resetTitle,
  stacked = false,
}) => {
  const percent = Math.round(value * 100)

  return (
    <div className={cn(stacked ? 'space-y-2' : 'flex items-center justify-between gap-3')}>
      {label &&
        (stacked ? (
          <p className="text-xs text-muted-foreground">{label}</p>
        ) : (
          <span className="text-xs text-muted-foreground">{label}</span>
        ))}
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={50}
          max={120}
          step={5}
          value={percent}
          onChange={(event) => onChange(Number(event.target.value) / 100)}
          aria-label={ariaLabel ?? label}
          className={cn(
            'ui-range focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 rounded-full',
            stacked ? 'flex-1 min-w-0' : 'w-24',
          )}
          style={{
            ['--ui-range-fill' as string]: `${Math.round(((value - UI_SCALE_MIN) / (UI_SCALE_MAX - UI_SCALE_MIN)) * 100)}%`,
          }}
        />
        <span className="text-xs text-muted-foreground font-mono tabular-nums min-w-[4ch] text-right">
          {percent}%
        </span>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={resetDisabled}
            data-compact
            title={resetTitle}
            aria-label={resetTitle}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
          >
            <Icon name="refresh" className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

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
