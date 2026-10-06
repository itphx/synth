import { cn } from '@/lib/utils'

export interface DividerProps {
  /** Тон: `default` — на обычных поверхностях (bg-border); `raised` — внутри плавающих слоёв на bg-popover. */
  tone?: 'default' | 'raised'
  /** Отступ по бокам, чтобы линия не касалась краёв контейнера. */
  inset?: boolean
  className?: string
}

export function Divider({ tone = 'default', inset = false, className }: DividerProps) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cn('h-px shrink-0', inset && 'mx-3', tone === 'raised' ? 'bg-popover-foreground/25' : 'bg-border', className)}
    />
  )
}
