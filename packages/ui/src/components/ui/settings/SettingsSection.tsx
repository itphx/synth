import React from 'react'

import { cn } from '@/lib/utils'
import { FieldTooltip } from './FieldTooltip'
import { useSettingsAdvanced } from './SettingsAdvancedContext'

export interface SettingsSectionProps {
  /** Якорь для поиска/фокуса: `data-settings-section`. */
  id?: string
  title?: string
  description?: string
  /**
   * Подсказка-иконка (ⓘ) в одной строке с заголовком. Показывается только при
   * наличии `title`: для секций без заголовка используйте описание панели/секции.
   */
  tooltip?: string
  actions?: React.ReactNode
  /** Секция относится к продвинутым настройкам. */
  advanced?: boolean
  className?: string
  children: React.ReactNode
}

/** ADR-072: карточка-секция внутри панели настроек. */
export function SettingsSection({
  id,
  title,
  description,
  tooltip,
  actions,
  advanced = false,
  className,
  children,
}: SettingsSectionProps) {
  const { visible, registerAdvanced } = useSettingsAdvanced()

  React.useEffect(() => {
    if (!advanced) return
    return registerAdvanced()
  }, [advanced, registerAdvanced])

  if (advanced && !visible) return null

  const hasHeader = Boolean(title || description || actions)
  return (
    <section
      data-settings-section={id}
      className={cn(
        'w-full min-w-0 rounded-xl border border-border/60 bg-card p-4 space-y-3',
        className,
      )}
    >
      {hasHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between min-w-0">
          <div className="min-w-0 space-y-1">
            {title && (
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="text-sm font-medium text-foreground min-w-0 break-words">{title}</h3>
                {tooltip && <FieldTooltip text={tooltip} />}
              </div>
            )}
            {description && (
              <p className="text-xs text-muted-foreground min-w-0 break-words">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="space-y-3 min-w-0">{children}</div>
    </section>
  )
}
