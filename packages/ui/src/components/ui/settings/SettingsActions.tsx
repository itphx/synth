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
  saveDisabled?: boolean
  cancelDisabled?: boolean
  resetDisabled?: boolean
  /** Текущие значения равны дефолтным: Reset становится серым (`outline-muted`) и неактивным. */
  isDefault?: boolean
  saveLabel?: string
  cancelLabel?: string
  resetLabel?: string
  /** `data-testid` соответствующих кнопок. */
  saveTestId?: string
  cancelTestId?: string
  resetTestId?: string
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
 * Порядок визуально: `Reset` (слева) — `Save` — `Cancel`.
 * `mr-auto` на Reset отделяет его от основных действий.
 * Правило цвета Reset: цветная (`outline-primary`) — только когда текущие
 * значения отличаются от дефолтных; при дефолтных (`isDefault`) — серая
 * (`outline-muted`) и неактивна.
 * Cancel — контурная кнопка в цвете своего текста (`outline-muted`),
 * рядом с Reset (`outline-primary`) и Save (`primary`).
 */
export function SettingsActions({
  onSave,
  onCancel,
  onReset,
  saving = false,
  saveDisabled = false,
  cancelDisabled = false,
  resetDisabled = false,
  isDefault = false,
  saveLabel,
  cancelLabel,
  resetLabel,
  saveTestId,
  cancelTestId,
  resetTestId,
  align = 'end',
  className,
}: SettingsActionsProps) {
  const { t } = useI18n()

  if (!onSave && !onCancel && !onReset) {
    return null
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2 min-w-0', ALIGN_CLASSES[align], className)}>
      {onReset && (
        <Button
          variant={isDefault ? 'outline-muted' : 'outline-primary'}
          size="sm"
          className="mr-auto shrink-0"
          onClick={onReset}
          disabled={resetDisabled || isDefault}
          data-testid={resetTestId}
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
          disabled={saveDisabled || saving}
          data-testid={saveTestId}
        >
          {saving ? t('common.saving') : saveLabel ?? t('common.save')}
        </Button>
      )}
      {onCancel && (
        <Button
          variant="outline-muted"
          size="sm"
          className="shrink-0"
          onClick={onCancel}
          disabled={cancelDisabled}
          data-testid={cancelTestId}
        >
          {cancelLabel ?? t('common.cancel')}
        </Button>
      )}
    </div>
  )
}
