import React from 'react'

import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'

export interface SettingsPanelProps {
  title: string
  description?: string
  /**
   * Счётчики/подпись под заголовком. В отличие от `description`,
   * остаётся видимым при сворачивании шапки.
   */
  meta?: React.ReactNode
  actions?: React.ReactNode
  footer?: React.ReactNode
  /**
   * `fixed` — футер вне scroll-тела (остаётся видимым при прокрутке),
   * `sticky` — футер в конце scroll-тела, «прилипает» к низу.
   */
  footerVariant?: 'fixed' | 'sticky'
  /**
   * На не-десктопе при прокрутке тела сворачивать описание шапки
   * (заголовок, `meta` и `actions` остаются). На десктопе описание видно всегда.
   */
  collapsibleHeader?: boolean
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
  meta,
  actions,
  footer,
  footerVariant = 'fixed',
  collapsibleHeader = true,
  className,
  contentClassName,
  children,
}: SettingsPanelProps) {
  const { deviceType } = useDevice()
  const [collapsed, setCollapsed] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = bodyRef.current
    if (!el) return

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const hasTop = scrollTop > 1
      const hasBottom = scrollHeight - scrollTop - clientHeight > 1
      if (hasTop && hasBottom) {
        el.setAttribute('data-scroll-shadow', 'top-bottom')
      } else if (hasTop) {
        el.setAttribute('data-scroll-shadow', 'top')
      } else if (hasBottom) {
        el.setAttribute('data-scroll-shadow', 'bottom')
      } else {
        el.removeAttribute('data-scroll-shadow')
      }
      setCollapsed(collapsibleHeader && deviceType !== 'desktop' && scrollTop > 8)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update)
      ro.observe(el)
      const content = el.firstElementChild
      if (content) ro.observe(content)
    }
    return () => {
      el.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [collapsibleHeader, deviceType])

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <header className="shrink-0 mx-auto w-full max-w-3xl flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 min-w-0">
          <h2 className="text-lg font-semibold text-foreground min-w-0 break-words">{title}</h2>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </div>
        {meta && (
          <div
            className="text-sm text-muted-foreground min-w-0 break-words"
            data-testid="settings-header-meta"
          >
            {meta}
          </div>
        )}
        {description && (
          <div
            className={cn(
              'grid grid-cols-1 overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
              collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
            )}
            data-testid="settings-header-description"
            aria-hidden={collapsed || undefined}
          >
            <p className="text-sm text-muted-foreground min-w-0 min-h-0 overflow-hidden break-words">{description}</p>
          </div>
        )}
      </header>

      <div
        ref={bodyRef}
        className={cn(
          'settings-scroll-container flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain transition-[margin] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'mt-2' : 'mt-4',
        )}
      >
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
