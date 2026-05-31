interface ToggleProps {
  enabled: boolean
  onToggle: () => void
}

export function Toggle({ enabled, onToggle }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      onClick={onToggle}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? 'bg-primary' : 'bg-muted-foreground/20'
      }`}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full bg-card shadow-sm transition-transform ${
          enabled ? 'translate-x-[19px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}
