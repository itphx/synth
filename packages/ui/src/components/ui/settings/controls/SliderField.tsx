import React from 'react'

import { cn } from '@/lib/utils'

import { SettingsField } from '../SettingsField'

export interface SliderFieldProps {
  label?: string
  description?: string
  min?: number
  max?: number
  step?: number
  value: number
  onValueChange: (value: number) => void
  disabled?: boolean
  /** Форматирование подписи текущего значения (например, `v => v.toFixed(2)`). */
  formatValue?: (v: number) => string
  /** Дополнительные классы контейнера `SettingsField`. */
  className?: string
}

/** AD-072: слайдер (`input[type=range]`) с подписью текущего значения. */
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
  className,
}: SliderFieldProps) {
  const displayValue = formatValue ? formatValue(value) : String(value)

  return (
    <SettingsField label={label} description={description} className={className}>
      <div className="flex flex-col gap-1 min-w-0">
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
            'w-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        />
        <span className="text-xs text-muted-foreground tabular-nums min-w-0" data-testid="slider-value">
          {displayValue}
        </span>
      </div>
    </SettingsField>
  )
}
