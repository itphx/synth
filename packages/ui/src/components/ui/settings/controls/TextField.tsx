import React from 'react'

import { cn } from '@/lib/utils'

import { SettingsField } from '../SettingsField'

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  description?: string
  error?: string
  mono?: boolean
  /** Дополнительные классы контейнера `SettingsField`. */
  containerClassName?: string
}

/** AD-072: управляемое текстовое поле в стиле панели настроек. */
export function TextField({
  label,
  description,
  error,
  mono,
  containerClassName,
  className,
  ...props
}: TextFieldProps) {
  return (
    <SettingsField
      label={label}
      description={description}
      error={error}
      htmlFor={props.id}
      className={containerClassName}
    >
      <input
        {...props}
        className={cn(
          'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground',
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          mono && 'font-mono',
          error && 'border-destructive',
          className,
        )}
      />
    </SettingsField>
  )
}
