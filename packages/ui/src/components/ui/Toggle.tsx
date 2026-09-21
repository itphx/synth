interface ToggleProps {
  enabled: boolean
  onToggle: () => void
  ariaLabel?: string
  disabled?: boolean
}

export function Toggle({ enabled, onToggle, ariaLabel, disabled = false }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed ${
        enabled ? 'bg-primary' : 'bg-muted-foreground/20'
      }`}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full bg-card shadow-sm transition-transform ${
          enabled ? 'translate-x-[1.1875rem]' : 'translate-x-[0.1875rem]'
        }`}
      />
    </button>
  )
}
