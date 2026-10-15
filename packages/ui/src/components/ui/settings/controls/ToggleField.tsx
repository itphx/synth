import { cn } from '@/lib/utils'

import { Toggle } from '../../Toggle'
import { FieldTooltip } from '../FieldTooltip'

export interface ToggleFieldProps {
  label: string
  description?: string
  /** ADR-089: подсказка-иконка (ⓘ) рядом с лейблом. */
  tooltip?: string
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
  ariaLabel?: string
}

/** ADR-072: строка «лейбл + переключатель». */
export function ToggleField({
  label,
  description,
  tooltip,
  enabled,
  onToggle,
  disabled = false,
  ariaLabel,
}: ToggleFieldProps) {
  return (
    <div className="flex items-start justify-between gap-3 min-w-0">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium text-foreground min-w-0 break-words">{label}</div>
          {tooltip && <FieldTooltip text={tooltip} />}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground min-w-0 break-words">{description}</p>
        )}
      </div>
      <div className={cn('shrink-0', disabled && 'opacity-50 pointer-events-none')}>
        <Toggle
          enabled={enabled}
          onToggle={disabled ? () => undefined : onToggle}
          ariaLabel={ariaLabel ?? label}
        />
      </div>
    </div>
  )
}
