/**
 * Ряд спец-клавиш терминала для мобильных устройств (PROP-132, Ф4a).
 *
 * На тач-устройствах физических клавиш нет, а терминал без `Esc`/`Tab`/`Ctrl`
 * практически бесполезен. Ряд показывается **только** на touch/узких
 * экранах (ADR-044: зоны ≤768 px и coarse-указатель) — на десктопе он
 * лишний.
 *
 * `Ctrl`/`Alt` работают как «взведённый модификатор»: нажали — следующая
 * клавиша уходит с модификатором, потом состояние сбрасывается.
 */

import { useCallback, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'

export interface TerminalQuickKeysProps {
  /** Отправить последовательность в терминал (уже с учётом модификаторов). */
  onKey: (sequence: string) => void
  /** Запретить ввод (терминал только для просмотра). */
  disabled?: boolean
}

/** Базовые последовательности спец-клавиш (терминальные escape-последовательности). */
const SEQUENCES = {
  escape: '\x1b',
  tab: '\t',
  enter: '\r',
  arrowUp: '\x1b[A',
  arrowDown: '\x1b[B',
  arrowRight: '\x1b[C',
  arrowLeft: '\x1b[D',
} as const

export function TerminalQuickKeys({ onKey, disabled = false }: TerminalQuickKeysProps) {
  const { t } = useI18n()
  const { deviceType, isTouch } = useDevice()
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)

  const visible = deviceType !== 'desktop' || isTouch

  const send = useCallback(
    (base: string, withCtrl = ctrl, withAlt = alt) => {
      let sequence = base
      if (withCtrl) sequence = `\x10${base}`
      else if (withAlt) sequence = `\x1b${base}`
      onKey(sequence)
      setCtrl(false)
      setAlt(false)
    },
    [alt, ctrl, onKey],
  )

  if (!visible) return null

  const buttonClass =
    'min-w-9 shrink-0 rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs font-medium text-foreground'

  return (
    <div
      data-testid="terminal-quick-keys"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border px-2 py-1.5"
    >
      <button
        type="button"
        className={cn(buttonClass, ctrl && 'border-primary text-primary')}
        disabled={disabled}
        aria-pressed={ctrl}
        onClick={() => setCtrl((value) => !value)}
      >
        {t('terminal.quickKeys.ctrl')}
      </button>
      <button
        type="button"
        className={cn(buttonClass, alt && 'border-primary text-primary')}
        disabled={disabled}
        aria-pressed={alt}
        onClick={() => setAlt((value) => !value)}
      >
        {t('terminal.quickKeys.alt')}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.escape)}
      >
        {t('terminal.quickKeys.escape')}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.tab)}
      >
        {t('terminal.quickKeys.tab')}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.arrowUp)}
        aria-label={t('terminal.quickKeys.arrowUp')}
      >
        ↑
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.arrowLeft)}
        aria-label={t('terminal.quickKeys.arrowLeft')}
      >
        ←
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.arrowDown)}
        aria-label={t('terminal.quickKeys.arrowDown')}
      >
        ↓
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.arrowRight)}
        aria-label={t('terminal.quickKeys.arrowRight')}
      >
        →
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled}
        onClick={() => send(SEQUENCES.enter)}
      >
        {t('terminal.quickKeys.enter')}
      </button>
    </div>
  )
}
