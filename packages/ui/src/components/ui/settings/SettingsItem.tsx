import React from 'react'

import { cn } from '@/lib/utils'

export interface SettingsItemProps {
  children: React.ReactNode
  className?: string
}

/**
 * AD-072: пункт-блок внутри SettingsSection (строка списка/тумблер/чекбокс).
 *
 * Контракт фонов (не нарушать):
 * - `SettingsSection` — контейнер группы, фон `bg-card` (elevated);
 * - каждый пункт внутри — `SettingsItem`, фон `bg-surface-inset` (subtle);
 * - поэтому фон пункта всегда отличается от фона секции;
 * - **секции не вкладывать друг в друга** — вложенную группу выносить
 *   отдельной `SettingsSection`.
 */
export function SettingsItem({ children, className }: SettingsItemProps) {
  return (
    <div className={cn('min-w-0 rounded-lg border border-border bg-surface-inset p-3', className)}>
      {children}
    </div>
  )
}
