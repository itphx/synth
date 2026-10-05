import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'

/**
 * AD-046 §7.1: служебные сообщения (команда, сводка, отладка, ошибка, инфо) —
 * единый центрированный блок. Текст внутри выровнен по левому краю, у блока
 * всегда есть шапка (иконка + подпись) и кнопка «Копировать».
 */
export type NoticeVariant = 'command' | 'summary' | 'debug' | 'error' | 'info'

interface NoticeVariantStyle {
  /** Иконка по умолчанию. */
  icon: IconName
  /** Стили рамки/фона блока. */
  box: string
  /** Моноширинная подпись (shell-промпт команды). */
  mono?: boolean
  /** Компактный кегль (инфо). */
  compact?: boolean
}

const VARIANT_STYLES: Record<NoticeVariant, NoticeVariantStyle> = {
  command: { icon: 'terminal-box', box: 'bg-surface-inset border-border/40 text-foreground', mono: true },
  summary: { icon: 'subtract', box: 'bg-status-warning/5 border-status-warning/20 text-foreground' },
  debug: { icon: 'bug', box: 'bg-status-warning/5 border-status-warning/30 text-status-warning' },
  error: { icon: 'error-warning', box: 'bg-destructive/10 border-destructive/30 text-destructive' },
  info: { icon: 'information', box: 'bg-surface-inset border-border/30 text-muted-foreground', compact: true },
}

export interface NoticeProps {
  variant: NoticeVariant
  /** Переопределить иконку варианта. */
  icon?: IconName
  /** Подпись в шапке. */
  label?: ReactNode
  /** Дополнение шапки справа (модель/время). */
  meta?: ReactNode
  /** Тело сообщения. */
  children?: ReactNode
  /** Дополнительные действия в футере (в дополнение к «Копировать»). */
  actions?: ReactNode
  /** Копирование тела. Кнопка не показывается, если обработчик не передан. */
  onCopy?: () => void
  disabled?: boolean
  /** aria-label группы (для команды — «Команда»). */
  ariaLabel?: string
}

export function Notice({
  variant,
  icon,
  label,
  meta,
  children,
  actions,
  onCopy,
  disabled,
  ariaLabel,
}: NoticeProps) {
  const { t } = useI18n()
  const style = VARIANT_STYLES[variant]
  const copyLabel = t('chat.notice.copy')

  return (
    <div className="flex flex-col items-center px-4 py-3 group">
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn(
          'w-full max-w-[85%] rounded-lg border px-4 py-3 text-left',
          style.box,
          style.compact && 'text-xs',
          disabled && 'opacity-50',
        )}
      >
        <div
          className={cn(
            'mb-1 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground',
            style.mono && 'font-mono',
          )}
        >
          <Icon name={icon ?? style.icon} className="size-3 shrink-0" />
          {label && <span className="truncate">{label}</span>}
          {meta && <span className="ml-auto inline-flex items-center gap-1.5">{meta}</span>}
        </div>

        {children}

        {(onCopy || actions) && (
          <div className="message-actions mt-2 -mb-1.5 flex flex-wrap items-center gap-0.5 border-t border-border/30 pt-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            {onCopy && (
              <button
                onClick={onCopy}
                title={copyLabel}
                aria-label={copyLabel}
                className="inline-flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="file-copy" className="size-3.5" />
              </button>
            )}
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
