import React from 'react'

import { cn } from '@/lib/utils'

export interface SettingsRowProps {
  label: string
  description?: string
  control: React.ReactNode
  htmlFor?: string
  className?: string
}

/**
 * AD-072: строка «лейбл слева — контрол справа».
 * На теле колонка, с `sm` — строка.
 */
export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  className,
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between min-w-0',
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground min-w-0 break-words">
          {label}
        </label>
        {description && (
          <p className="text-xs text-muted-foreground min-w-0 break-words">{description}</p>
        )}
      </div>
      <div className="shrink-0 flex items-center">{control}</div>
    </div>
  )
}
