import React from 'react'
import { cn } from '@/lib/utils'

export type ButtonVariant =
  | 'primary'
  | 'ghost'
  | 'outline'
  | 'outline-primary'
  | 'outline-muted'
  | 'danger'
export type ButtonSize = 'sm' | 'md' | 'icon'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // У `primary`/`ghost` бордер прозрачный: без него высота `sm` была бы 28px,
  // а у вариантов с бордером — 30px. Канон — единая высота контрола (ADR-072).
  primary: 'border border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
  ghost: 'border border-transparent text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
  outline: 'border border-border text-foreground hover:bg-interactive-hover',
  'outline-primary': 'border border-primary text-primary hover:bg-primary/10',
  'outline-muted': 'border border-muted-foreground text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
  danger: 'border border-destructive/30 text-destructive hover:bg-destructive/10',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  // Иконочная кнопка: квадрат 32px без текстовых паддингов (иконка 16px).
  // На тач-устройствах — 40px (ADR-044): глобальное правило
  // `html.pointer-coarse .mobile-drawer-panel button…` покрывает только мобильный
  // дровер, а панель может быть и в десктопной раскладке (планшет в ландшафте).
  icon: 'size-8 pointer-coarse:size-10',
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
