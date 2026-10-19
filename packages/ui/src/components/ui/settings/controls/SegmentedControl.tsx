import React from 'react'

import { Icon } from '@/components/icon/Icon'
import type { IconName } from '@/components/icon/icons'
import { cn } from '@/lib/utils'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  icon?: IconName
}

/**
 * ADR-072: сегментированный переключатель из двух/нескольких вариантов.
 * Унифицирован в Kit (ранее жил в legacy-разметке раздела настроек).
 */
export const SegmentedControl = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className,
}: {
  value: T
  options: SegmentedControlOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element => (
  <div
    role="radiogroup"
    aria-label={ariaLabel}
    className={cn(
      // Дорожка без рамки/внутреннего отступа: сегменты сами задают высоту
      // (канон контрола — 30px), иначе группа была бы выше сегментов.
      // Контур — inset-тень (не влияет на размеры), а не border.
      'inline-flex items-stretch gap-0.5 rounded-lg bg-muted p-0 shadow-[inset_0_0_0_1px_var(--border)]',
      disabled && 'opacity-60',
      className
    )}
  >
    {options.map((option) => {
      const active = value === option.value
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={active}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          aria-label={option.icon ? option.label : undefined}
          title={option.icon ? option.label : undefined}
          className={cn(
            'flex-1 h-[var(--control-height)] whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active
              ? 'bg-surface-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
          )}
        >
          {option.icon ? (
            <Icon name={option.icon} className="size-3.5" aria-hidden />
          ) : (
            <span>{option.label}</span>
          )}
        </button>
      )
    })}
  </div>
)
