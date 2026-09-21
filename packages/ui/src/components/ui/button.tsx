import React from 'react'
import { cn } from '@/lib/utils'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'outline-primary' | 'danger'
export type ButtonSize = 'sm' | 'md'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  ghost: 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
  outline: 'border border-border text-foreground hover:bg-interactive-hover',
  'outline-primary': 'border border-primary text-primary hover:bg-primary/10',
  danger: 'border border-destructive/30 text-destructive hover:bg-destructive/10',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'sm', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    />
  ),
)

Button.displayName = 'Button'
