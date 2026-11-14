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
}

export const TerminalFloatingButton: React.FC<TerminalFloatingButtonProps> = ({
  sessionId,
  projectId,
}) => {
  const { t } = useI18n()
  const { liveTerminal, open } = useTerminalLauncher(sessionId, projectId)

  if (!liveTerminal) return null

  return (
    <button
      type="button"
      data-testid="terminal-fab"
      className="pointer-events-auto absolute bottom-24 right-3 z-20 flex size-10 items-center justify-center rounded-full border border-border bg-surface-card text-foreground shadow-lg transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
      onClick={() => void open()}
      title={t('terminal.open')}
      aria-label={t('terminal.open')}
    >
      <Icon name="terminal-box" className="size-4" />
    </button>
  )
}
