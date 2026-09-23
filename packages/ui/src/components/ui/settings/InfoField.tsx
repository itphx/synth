export interface InfoFieldProps {
  label: string
  value: string
  mono?: boolean
}

/** Строка «лейбл — значение» для компактных информационных секций панелей. */
export function InfoField({ label, value, mono }: InfoFieldProps) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-words text-right ${mono ? 'font-mono text-[0.6875rem]' : ''}`}>{value}</span>
    </div>
  )
}
