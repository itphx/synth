import React from 'react'

import { Select, SelectTrigger, SelectValue } from '../../select'
import { SettingsField } from '../SettingsField'

export interface SelectFieldProps {
  label?: string
  description?: string
  error?: string
  /** AD-089: подсказка-иконка (ⓘ) рядом с лейблом. */
  tooltip?: string
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  ariaLabel?: string
  disabled?: boolean
  /** `data-testid` триггера (для тестов и e2e). */
  triggerTestId?: string
  /** Пробрасывается в `Select` для резолва label выбранного значения в триггере. */
  items?: ReadonlyArray<{ label: React.ReactNode; value: string }>
  /** Дополнительные классы контейнера `SettingsField`. */
  containerClassName?: string
}

/** AD-072: управляемый select; триггер занимает всю ширину. */
export function SelectField({
  label,
  description,
  error,
  tooltip,
  value,
  onValueChange,
  children,
  ariaLabel,
  disabled,
  triggerTestId,
  items,
  containerClassName,
}: SelectFieldProps) {
  return (
    <SettingsField
      label={label}
      description={description}
      error={error}
      tooltip={tooltip}
      className={containerClassName}
    >
      <Select value={value} onValueChange={onValueChange} items={items}>
        <SelectTrigger
          className="w-full min-w-0"
          aria-label={ariaLabel}
          disabled={disabled}
          data-testid={triggerTestId}
        >
          <SelectValue />
        </SelectTrigger>
        {children}
      </Select>
    </SettingsField>
  )
}
