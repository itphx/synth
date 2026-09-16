import React from 'react'
import { cn } from '@/lib/utils'

export const SettingsPage: React.FC<{
  title: string
  description?: string
  className?: string
  stickyHeader?: boolean
  children: React.ReactNode
}> = ({ title, description, className, stickyHeader = false, children }) => (
  <div className={cn('space-y-6', className)}>
    {stickyHeader ? (
      <header className="sticky -top-6 z-10 -mx-6 -mt-6 mb-6 border-b border-border bg-background/95 px-6 pt-6 pb-4 backdrop-blur">
        <h2 className="text-lg font-semibold mb-1 text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </header>
    ) : (
      <header className="max-w-2xl">
        <h2 className="text-lg font-semibold mb-1 text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </header>
    )}
    {children}
  </div>
)

export const SettingsCard: React.FC<{
  title?: string
  description?: string
  className?: string
  children: React.ReactNode
}> = ({ title, description, className, children }) => (
  <section className={cn('rounded-xl border border-border/60 bg-surface-subtle/30 p-4 space-y-3', className)}>
    {(title || description) && (
      <div className="space-y-1">
        {title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    )}
    <div className="space-y-3">{children}</div>
  </section>
)

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
}

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
      'inline-flex items-center gap-0.5 rounded-lg border border-border/80 bg-background p-0.5',
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
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active
              ? 'bg-interactive-selection text-interactive-selection-foreground'
              : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      )
    })}
  </div>
)
