import React from 'react'

import { Icon } from '@/components/icon/Icon'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'

export interface SliderFieldProps {
  label?: string
  description?: string
  min: number
  max: number
  step?: number
  value: number
  onValueChange: (value: number) => void
  disabled?: boolean
  /** Форматирование подписи текущего значения (например, `v => v.toFixed(2)`). */
  formatValue?: (v: number) => string
  /** Опциональная компактная кнопка сброса значения по умолчанию. */
  onReset?: () => void
  resetDisabled?: boolean
  resetTitle?: string
  /**
   * Явно задать раскладку: `true` — колонка (слайдер `flex-1`), `false` — строка.
   * По умолчанию — `true` на телефоне/планшете и `false` на десктопе.
   */
  stacked?: boolean
  /** Дополнительные классы контейнера. */
  className?: string
}

/** Процент заполнения трека для `--ui-range-fill` (без деления на ноль). */
function computeSliderFill(value: number, min: number, max: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return '0%'
  }
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)))
  return `${Math.round(ratio * 100)}%`
}

/** AD-072: единый слайдер (`.ui-range`) с подписью значения и опциональным сбросом. */
export function SliderField({
  label,
  description,
  min,
  max,
  step,
  value,
  onValueChange,
  disabled = false,
  formatValue,
  onReset,
  resetDisabled,
  resetTitle,
  stacked,
  className,
}: SliderFieldProps) {
  const { deviceType } = useDevice()
  const isStacked = stacked ?? deviceType !== 'desktop'
  const displayValue = formatValue ? formatValue(value) : String(value)
  const fill = computeSliderFill(value, min, max)

  return (
    <div
      className={cn(
        'min-w-0',
        isStacked ? 'space-y-2' : 'flex items-center justify-between gap-3',
        className,
      )}
    >
      {(label || description) && (
        <div className="min-w-0">
          {label &&
            (isStacked ? (
              <p className="text-xs text-muted-foreground break-words">{label}</p>
            ) : (
              <span className="text-xs text-muted-foreground break-words">{label}</span>
            ))}
          {description && (
            <p className="text-xs text-muted-foreground/80 break-words">{description}</p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 min-w-0">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onValueChange(Number.parseFloat(e.target.value))}
          className={cn(
            'ui-range focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 rounded-full',
            isStacked ? 'flex-1 min-w-0' : 'w-24 sm:w-32',
            disabled && 'cursor-not-allowed opacity-50',
          )}
          style={{ ['--ui-range-fill' as string]: fill }}
        />
        <span
          className="text-xs text-muted-foreground font-mono tabular-nums min-w-[4ch] text-right"
          data-testid="slider-value"
        >
          {displayValue}
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
