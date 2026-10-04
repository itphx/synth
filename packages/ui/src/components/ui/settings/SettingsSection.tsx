import React from 'react'

import { cn } from '@/lib/utils'

export interface SettingsSectionProps {
  title?: string
  description?: string
  actions?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/** AD-072: карточка-секция внутри панели настроек. */
export function SettingsSection({
  title,
  description,
  actions,
  className,
  children,
}: SettingsSectionProps) {
  const hasHeader = Boolean(title || description || actions)
  return (
    <section
      className={cn(
        'w-full min-w-0 rounded-xl border border-border/60 bg-card p-4 space-y-3',
        className,
      )}
    >
      {hasHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between min-w-0">
          <div className="min-w-0 space-y-1">
            {title && (
              <h3 className="text-sm font-medium text-foreground min-w-0 break-words">{title}</h3>
            )}
            {description && (
              <p className="text-xs text-muted-foreground min-w-0 break-words">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="space-y-3 min-w-0">{children}</div>
    </section>
  )
}
