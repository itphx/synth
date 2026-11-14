// TerminalFloatingButton: плавающая кнопка «Терминал» в чате (PROP-132, Ф4б).
//
// Показывается, только если у активной сессии есть **живой** привязанный
// терминал (реестр терминалов + live-события `terminal.*`). Клик открывает
// вкладку терминала.

import React from 'react'

import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useTerminalLauncher } from '@/hooks/useTerminalLauncher'

export interface TerminalFloatingButtonProps {
  /** Сессия активного чата. */
  sessionId: string | undefined
  /** Проект сессии (нужен, если терминал придётся создавать). */
  projectId: string | undefined
  /** Позиция по горизонтали, как у кнопки промотки (left). */
  left?: number
}

export const TerminalFloatingButton: React.FC<TerminalFloatingButtonProps> = ({
  sessionId,
  projectId,
  left,
}) => {
  const { t } = useI18n()
  const { liveTerminal, open } = useTerminalLauncher(sessionId, projectId)

  if (!liveTerminal) return null

  return (
    <button
      type="button"
      data-testid="terminal-fab"
      className={`pointer-events-auto absolute bottom-[3.625rem] z-20 rounded-full border border-border bg-card p-2 text-muted-foreground shadow-md transition-colors hover:bg-interactive-hover hover:text-foreground animate-in fade-in slide-in-from-bottom-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:p-2.5 ${left == null ? 'right-6' : ''}`}
      style={left != null ? { left } : undefined}
      onClick={() => void open()}
      title={t('terminal.open')}
      aria-label={t('terminal.open')}
    >
      <Icon name="terminal-box" className="size-4" />
    </button>
  )
}
