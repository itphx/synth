import { useState, type ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useDevice } from '@/hooks/useDevice'
import { cn } from '@/lib/utils'

const BADGE_TONES = {
  neutral: 'rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground',
  muted: 'rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground/70',
  primary: 'rounded bg-primary/15 px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-primary',
  danger: 'rounded bg-destructive/15 px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-destructive',
} as const

/** Бейдж строки списка (scope/level/system/untrusted/unavailable). */
export function RowBadge({
  tone,
  children,
  className,
}: {
  tone: keyof typeof BADGE_TONES
  children: ReactNode
  /** Дополнительные классы (например, компактный размер бейджа). */
  className?: string
}) {
  return <span className={cn(BADGE_TONES[tone], className)}>{children}</span>
}

/**
 * Унифицированная строка списка в правой панели: имя + бейджи, управление (aside)
 * и необязательное содержимое под катом (details).
 *
 * Раскладка адаптивная: на десктопе — одна строка (имя, `aside`, шеврон). На
 * телефоне/планшете — две строки: имя + бейджи на всю ширину с шевроном у правого
 * края, а `aside` (тумблеры с подписями) — второй строкой справа. Так имя не
 * сжимается и не «отрывается» шеврон из-за широкого `aside`.
 */
export function ExpandableListRow({
  testId,
  name,
  badges,
  aside,
  details,
  detailsTestId,
  defaultExpanded = false,
}: {
  testId: string
  name: string
  badges?: ReactNode
  aside?: ReactNode
  details?: ReactNode
  detailsTestId?: string
  defaultExpanded?: boolean
}) {
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const stacked = deviceType !== 'desktop'
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasDetails = details !== undefined && details !== null

  const chevron = hasDetails ? (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? t('common.hide') : t('common.details')}
      aria-label={expanded ? t('common.hide') : t('common.details')}
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
      data-testid={detailsTestId ?? `${testId}-details-toggle`}
    >
      <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
    </button>
  ) : null

  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid={testId}
        data-layout={stacked ? 'stacked' : 'inline'}
        className={cn(
          'rounded-lg border border-border/60 bg-input px-2.5 py-1.5',
          stacked ? 'flex flex-col gap-1.5' : 'flex items-center gap-2',
        )}
      >
        <div className={cn('flex min-w-0 items-center gap-2', stacked ? 'w-full' : 'flex-1')}>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span className="truncate text-xs text-foreground">{name}</span>
            {badges}
          </div>
          {stacked && chevron}
        </div>
        {aside !== undefined && aside !== null && (
          <div className={cn('flex items-center gap-2', stacked ? 'w-full justify-end' : 'shrink-0')}>
            {aside}
          </div>
        )}
        {!stacked && chevron}
      </div>
      {hasDetails && expanded && (
        <div
          className="px-1 text-[0.625rem] text-muted-foreground/70 break-words"
          data-testid={`${testId}-details-content`}
        >
          {details}
        </div>
      )}
    </div>
  )
}
