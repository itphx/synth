import React from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export type SettingsActionsAlign = 'end' | 'start' | 'between'

export interface SettingsActionsProps {
  onSave?: () => void
  onCancel?: () => void
  onReset?: () => void
  saving?: boolean
  disabled?: boolean
  saveDisabled?: boolean
  cancelDisabled?: boolean
  resetDisabled?: boolean
  saveLabel?: string
  cancelLabel?: string
  resetLabel?: string
  align?: SettingsActionsAlign
  className?: string
}

const ALIGN_CLASSES: Record<SettingsActionsAlign, string> = {
  end: 'justify-end',
  start: 'justify-start',
  between: 'justify-between',
}

/**
 * AD-072: единый ряд действий формы настроек.
 *
 * Порядок визуально: `Reset` (destructive, слева) — `Save` — `Cancel`.
 * `mr-auto` на Reset отделяет destructive-действие от основных.
 */
export function SettingsActions({
  onSave,
  onCancel,
  onReset,
  saving = false,
  disabled = false,
  saveDisabled = false,
  cancelDisabled = false,
  resetDisabled = false,
  saveLabel,
  cancelLabel,
  resetLabel,
  align = 'end',
  className,
}: SettingsActionsProps) {
  const { t } = useI18n()

  const saveDisabledFinal = disabled || saveDisabled || saving
  const cancelDisabledFinal = disabled || cancelDisabled
  const resetDisabledFinal = disabled || resetDisabled

  if (!onSave && !onCancel && !onReset) {
    return null
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2 min-w-0', ALIGN_CLASSES[align], className)}>
      {onReset && (
        <Button
          variant="danger"
          size="sm"
          className="mr-auto shrink-0"
          onClick={onReset}
          disabled={resetDisabledFinal}
        >
          {resetLabel ?? t('common.reset')}
        </Button>
      )}
      {onSave && (
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          onClick={onSave}
          disabled={saveDisabledFinal}
        >
          {saving ? t('common.saving') : saveLabel ?? t('common.save')}
        </Button>
      )}
      {onCancel && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={onCancel}
          disabled={cancelDisabledFinal}
        >
          {cancelLabel ?? t('common.cancel')}
        </Button>
      )}
    </div>
  )
}
