import React from 'react'

import { cn } from '@/lib/utils'

export interface SettingsFieldProps {
  label?: string
  description?: string
  error?: string
  htmlFor?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}

/** AD-072: вертикальный лейбл + описание + контрол + ошибка. */
export function SettingsField({
  label,
  description,
  error,
  htmlFor,
  required,
  className,
  children,
}: SettingsFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5 min-w-0', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground min-w-0">
          {label}
          {required && <span className="text-destructive"> *</span>}
        </label>
      )}
      {description && (
        <p className="text-xs text-muted-foreground min-w-0 break-words">{description}</p>
      )}
      {children}
      {error && <p className="text-xs text-destructive min-w-0">{error}</p>}
    </div>
  )
}
