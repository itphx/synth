export interface InfoFieldProps {
  label: string
  value: string
  mono?: boolean
}

/** Строка «лейбл — значение» для компактных информационных секций панелей. */
export function InfoField({ label, value, mono }: InfoFieldProps) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-[0.6875rem]' : ''}>{value}</span>
    </div>
  )
}
