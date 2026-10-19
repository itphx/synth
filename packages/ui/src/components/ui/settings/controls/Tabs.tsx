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
        'tab-scroll-container flex w-full min-w-0 items-stretch gap-1 overflow-x-auto',
        isUnderline ? 'border-b border-border' : 'rounded-lg bg-muted p-0',
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
              'flex-1 min-w-0 h-[var(--control-height)] px-2 py-1.5 text-xs font-medium text-center leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isUnderline ? 'rounded-none' : 'rounded-md',
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
