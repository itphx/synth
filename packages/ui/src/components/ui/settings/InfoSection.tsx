import type { ReactNode } from 'react'

export interface InfoSectionProps {
  title: ReactNode
  children: ReactNode
}

/**
 * Компактная информационная секция для панелей: мелкий заголовок + содержимое.
 * Не путать с `SettingsSection` (AD-072) — это не карточка панели настроек.
 */
export function InfoSection({ title, children }: InfoSectionProps) {
  return (
    <div>
      <div className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}
