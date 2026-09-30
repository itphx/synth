import { cn } from '@/lib/utils'

interface ToggleProps {
  enabled: boolean
  onToggle: () => void
  ariaLabel?: string
  /** Реально недоступен (system/project): серый без «запрета», клики не проходят. */
  disabled?: boolean
  /** Запрос в полёте: визуально «занят» (лёгкое затемнение, cursor-progress), но остаётся кликабельным
   * (повторы гасит обработчик). */
  pending?: boolean
}

export function Toggle({ enabled, onToggle, ariaLabel, disabled = false, pending = false }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
      aria-busy={pending || undefined}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-default',
        disabled ? 'cursor-default' : pending ? 'cursor-progress opacity-60' : 'cursor-pointer',
        enabled ? 'bg-primary' : 'bg-muted-foreground/20',
      )}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full bg-card shadow-sm transition-transform ${
          enabled ? 'translate-x-[1.1875rem]' : 'translate-x-[0.1875rem]'
        }`}
      />
    </button>
  )
}
