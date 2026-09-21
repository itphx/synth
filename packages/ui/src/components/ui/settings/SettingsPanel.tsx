import React from 'react'

import { cn } from '@/lib/utils'

export interface SettingsPanelProps {
  title: string
  description?: string
  actions?: React.ReactNode
  footer?: React.ReactNode
  /**
   * `fixed` — футер вне scroll-тела (остаётся видимым при прокрутке),
   * `sticky` — футер в конце scroll-тела, «прилипает» к низу.
   */
  footerVariant?: 'fixed' | 'sticky'
  className?: string
  /** Дополнительные классы внутренней центрированной обёртки контента. */
  contentClassName?: string
  children: React.ReactNode
}

const CONTENT_WIDTH = 'mx-auto w-full max-w-3xl min-w-0'

/**
 * AD-072: стандартный каркас панели настроек.
 *
 * Гарантирует один вертикальный скролл, фиксированную шапку и отсутствие
 * горизонтального скролла: весь контент ограничен `max-w-3xl` и центрирован,
 * вложенные элементы получают `min-w-0`/`break-words`.
 */
export function SettingsPanel({
  title,
  description,
  actions,
  footer,
  footerVariant = 'fixed',
  className,
  contentClassName,
  children,
}: SettingsPanelProps) {
  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <header className="shrink-0 mx-auto w-full max-w-3xl flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground min-w-0 break-words">{title}</h2>
          {description && (
            <p className="text-sm text-muted-foreground min-w-0 break-words">{description}</p>
          )}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain mt-4">
        <div className={cn('space-y-4', CONTENT_WIDTH, contentClassName)}>
          {children}
          {footerVariant === 'sticky' && footer && (
            <div className="sticky bottom-0 -mx-1 px-1 pt-3 pb-1 bg-background/95 backdrop-blur border-t border-border">
              {footer}
            </div>
          )}
        </div>
      </div>

      {footerVariant === 'fixed' && footer && (
        <div className="shrink-0 border-t border-border bg-background pt-4 mt-4">
          <div className={CONTENT_WIDTH}>{footer}</div>
        </div>
      )}
    </div>
  )
}
