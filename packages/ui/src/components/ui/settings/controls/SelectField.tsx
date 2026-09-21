import React from 'react'

import { Select, SelectTrigger, SelectValue } from '../../select'
import { SettingsField } from '../SettingsField'

export interface SelectFieldProps {
  label?: string
  description?: string
  error?: string
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  ariaLabel?: string
}

/** AD-072: управляемый select; триггер занимает всю ширину. */
export function SelectField({
  label,
  description,
  error,
  value,
  onValueChange,
  children,
  ariaLabel,
}: SelectFieldProps) {
  return (
    <SettingsField label={label} description={description} error={error}>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full min-w-0" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        {children}
      </Select>
    </SettingsField>
  )
}
