import React from 'react'

import { cn } from '@/lib/utils'

import { SettingsField } from '../SettingsField'
import { SettingsRow } from '../SettingsRow'

export interface NumberFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
  description?: string
  error?: string
  /** Единица измерения справа от поля (%, ms, …). */
  suffix?: string
  /** Дополнительные классы контейнера `SettingsField`. */
  containerClassName?: string
  /** AD-072: строка «подпись слева — поле справа» вместо вертикального лейбла. */
  inline?: boolean
}

/** AD-072: числовое поле с выравниванием вправо; на теле — на всю ширину. */
export function NumberField({
  label,
  description,
  error,
  suffix,
  containerClassName,
  inline = false,
  className,
  ...props
}: NumberFieldProps) {
  const control = (
    <div className="flex items-center gap-2 min-w-0">
      <input
        {...props}
        type="number"
        className={cn(
          'min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-right text-foreground',
          inline ? 'w-24 sm:w-24' : 'w-full sm:w-24',
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-destructive',
          className,
        )}
      />
      {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  )

  if (inline) {
    return (
      <div className={cn('flex flex-col gap-1.5 min-w-0', containerClassName)}>
        <SettingsRow
          label={label ?? ''}
          description={description}
          htmlFor={props.id}
          control={control}
        />
        {error && <p className="text-xs text-destructive min-w-0">{error}</p>}
      </div>
    )
  }

  return (
    <SettingsField
      label={label}
      description={description}
      error={error}
      htmlFor={props.id}
      className={containerClassName}
    >
      {control}
    </SettingsField>
  )
}
