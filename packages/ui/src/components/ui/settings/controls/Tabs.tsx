import React, { useCallback, useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

export interface TabsItem {
  value: string
  label: string
  /** Подсказка (и режим усечения текста вкладки). */
  title?: string
}

export interface TabsProps {
  items: TabsItem[]
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  variant?: 'segmented' | 'underline'
  /** Разрешить перенос вкладок на несколько строк вместо горизонтального скролла. */
  wrap?: boolean
  className?: string
}

/**
 * ADR-072: переключатель вкладок.
 *
 * Мобильно-устойчив: вкладки `flex-1 min-w-0`, высота выравнивается
 * (`items-stretch`), текст переносится (`break-words`) или усекается при `title`.
 * При переполнении контейнер скроллится по X с затенением краёв.
 */
export function Tabs({
  items,
  value,
  onChange,
  ariaLabel,
  variant = 'segmented',
  wrap = false,
  className,
}: TabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    const hasLeft = scrollLeft > 1
    const hasRight = scrollWidth - scrollLeft - clientWidth > 1
    if (hasLeft && hasRight) {
      el.setAttribute('data-scroll-shadow', 'left-right')
    } else if (hasLeft) {
      el.setAttribute('data-scroll-shadow', 'left')
    } else if (hasRight) {
      el.setAttribute('data-scroll-shadow', 'right')
    } else {
      el.removeAttribute('data-scroll-shadow')
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    handleScroll()
    el.addEventListener('scroll', handleScroll, { passive: true })
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(handleScroll)
      ro.observe(el)
      Array.from(el.children).forEach((child) => ro!.observe(child))
    }
    return () => {
      el.removeEventListener('scroll', handleScroll)
      ro?.disconnect()
    }
  }, [handleScroll, items.length])

  const isUnderline = variant === 'underline'

  return (
    <div
      ref={scrollRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'tab-scroll-container flex w-full min-w-0 items-stretch gap-1',
        wrap ? 'flex-wrap overflow-visible' : 'overflow-x-auto',
        // Сегментированный вариант — дорожка с внутренним отступом 2px (та же
        // схема, что у `SegmentedControl`): активная вкладка не касается
        // контура, общая высота остаётся `--control-height` (30px).
        isUnderline ? 'border-b border-border' : 'rounded-lg bg-muted p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={item.title}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex-1 min-w-0 px-2 text-xs font-medium text-center leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isUnderline
                ? 'h-[var(--control-height)] rounded-none py-1.5'
                : 'h-[calc(var(--control-height)-0.25rem)] rounded-md',
              wrap && 'min-w-[5rem]',
              item.title ? 'truncate' : 'break-words',
              isUnderline
                ? active
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
                : active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
