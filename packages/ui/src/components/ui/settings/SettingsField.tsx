import React from 'react'

import { cn } from '@/lib/utils'

import { FieldTooltip } from './FieldTooltip'

export interface SettingsFieldProps {
  label?: string
  description?: string
  error?: string
  htmlFor?: string
  required?: boolean
  /** ADR-089: подсказка-иконка (ⓘ) рядом с лейблом. */
  tooltip?: string
  className?: string
  children: React.ReactNode
}

/** ADR-072: вертикальный лейбл + описание + контрол + ошибка. */
export function SettingsField({
  label,
  description,
  error,
  htmlFor,
  required,
  tooltip,
  className,
  children,
}: SettingsFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5 min-w-0', className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="inline-flex w-fit max-w-full items-center gap-1.5 text-sm font-medium text-foreground min-w-0"
        >
          <span className="min-w-0">
            {label}
            {required && <span className="text-destructive"> *</span>}
          </span>
          {tooltip && <FieldTooltip text={tooltip} />}
        </label>
      )}
      {!label && tooltip && (
        <div className="min-w-0">
          <FieldTooltip text={tooltip} />
        </div>
      )}
      {description && (
        <p className="text-xs text-muted-foreground min-w-0 break-words">{description}</p>
      )}
      {children}
      {error && <p className="text-xs text-destructive min-w-0">{error}</p>}
    </div>
  )
}
