import { useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'

export interface ComposerBannerDetails {
  /** Подпись сворачиваемого блока (заголовок раскрытия). */
  summary: string
  /** Содержимое блока — видно только после раскрытия. */
  content: ReactNode
}

export interface ComposerBannerProps {
  variant: 'error' | 'warning'
  /** Имя иконки реестра `Icon` (по умолчанию — по варианту). */
  icon?: string
  title: ReactNode
  /** Дополнительные строки под заголовком (всегда видимы). */
  children?: ReactNode
  /** Сворачиваемый блок («Что делать») — по умолчанию свёрнут. */
  details?: ComposerBannerDetails
  /** Действие справа в шапке (например, кнопка «Повторить»). */
  action?: ReactNode
  testId?: string
}

const DEFAULT_ICON = {
  error: 'error-warning',
  warning: 'error-warning',
} as const

/** Палитра плашки: error — destructive, warning — жёлтый токен темы. */
const VARIANT_CLASSES = {
  error: {
    container: 'border-destructive/20 bg-destructive/5 text-destructive',
    icon: 'text-destructive',
  },
  warning: {
    container: 'border-status-notice/40 bg-status-notice/10 text-foreground',
    icon: 'text-status-notice',
  },
} as const

/**
 * Плашка над полем ввода (композером): ошибка провайдера, предупреждение о
 * контексте и прочие предупреждения хода. Базовая геометрия — как у
 * `QueuePanel`/`StreamErrorPanel` (`mx-auto w-4/5`), палитра — по варианту.
 *
 * Сворачиваемый блок нужен для длинных советов: заголовок остаётся видимым,
 * подробности не занимают место постоянно.
 */
export function ComposerBanner({
  variant,
  icon,
  title,
  children,
  details,
  action,
  testId,
}: ComposerBannerProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const styles = VARIANT_CLASSES[variant]

  return (
    <div
      className={cn('shrink-0 mx-auto w-4/5 rounded-lg border', styles.container)}
      data-testid={testId}
      data-variant={variant}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon name={icon ?? DEFAULT_ICON[variant]} className={cn('size-3.5 shrink-0', styles.icon)} />
        <div className="flex-1 min-w-0 text-xs">
          <div>{title}</div>
          {children}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {details && (
        <div className="px-3 pb-1.5">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
            data-testid={testId ? `${testId}-details` : undefined}
            className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name={detailsOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
            <span>{details.summary}</span>
          </button>
          {detailsOpen && (
            <div className="pt-1 text-[0.6875rem] text-muted-foreground">{details.content}</div>
          )}
        </div>
      )}
    </div>
  )
}
