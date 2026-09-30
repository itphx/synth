import { useState, type ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

const BADGE_TONES = {
  neutral: 'rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground',
  muted: 'rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground/70',
  primary: 'rounded bg-primary/15 px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-primary',
  danger: 'rounded bg-destructive/15 px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-destructive',
} as const

/** Бейдж строки списка (scope/level/system/untrusted/unavailable). */
export function RowBadge({ tone, children }: { tone: keyof typeof BADGE_TONES; children: ReactNode }) {
  return <span className={BADGE_TONES[tone]}>{children}</span>
}

/**
 * Унифицированная строка списка в правой панели: имя + бейджи, управление (aside)
 * и необязательное содержимое под катом (details).
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
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasDetails = details !== undefined && details !== null

  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid={testId}
        className="flex items-center gap-2 rounded-lg border border-border/60 bg-input px-2.5 py-1.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="truncate text-xs text-foreground">{name}</span>
            {badges}
          </div>
        </div>
        {aside !== undefined && aside !== null && (
          <div className="flex shrink-0 items-center gap-2">{aside}</div>
        )}
        {hasDetails && (
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
        )}
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
