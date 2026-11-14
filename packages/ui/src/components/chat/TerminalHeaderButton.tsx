// TerminalHeaderButton: кнопка «Терминал» в шапке сессии (PROP-132, Ф4б).
//
// Работает в обоих состояниях — терминала у сессии нет (создаёт и открывает)
// и есть живой привязанный (открывает его вкладку). Единая точка —
// `useTerminalLauncher`, поэтому правила «найти живой или создать» не
// дублируются. Пока идёт создание — спиннер и `disabled`.

import React from 'react'

import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useTerminalLauncher } from '@/hooks/useTerminalLauncher'

export interface TerminalHeaderButtonProps {
  /** Сессия активной вкладки чата. */
  sessionId: string | undefined
  /** Проект сессии (нужен, если терминал придётся создавать). */
  projectId: string | undefined
  /** Мобильная шапка: тач-таргет 36px вместо компактных 24px. */
  mobile?: boolean
}

export const TerminalHeaderButton: React.FC<TerminalHeaderButtonProps> = ({
  sessionId,
  projectId,
  mobile = false,
}) => {
  const { t } = useI18n()
  const { open, busy } = useTerminalLauncher(sessionId, projectId)

  // Без сессии терминал не к чему привязывать — кнопку не показываем.
  if (!sessionId) return null

  return (
    <button
      type="button"
      data-testid="header-terminal"
      data-busy={busy ? 'true' : undefined}
      className={cn(
        'flex shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        mobile ? 'h-9 w-9 rounded-lg' : 'h-6 w-6',
      )}
      onClick={() => void open()}
      disabled={busy}
      title={t('terminal.openOrCreate')}
      aria-label={t('terminal.headerButton')}
    >
      <Icon
        name={busy ? 'loader-2' : 'terminal-box'}
        className={cn(mobile ? 'size-5' : 'size-3.5', busy && 'animate-spin')}
      />
    </button>
  )
}
