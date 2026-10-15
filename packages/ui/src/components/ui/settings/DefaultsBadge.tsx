import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface DefaultsBadgeProps {
  className?: string
}

/** ADR-072: пилюля «По умолчанию» рядом с настройкой на дефолтном значении. */
export function DefaultsBadge({ className }: DefaultsBadgeProps) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'shrink-0 rounded-full bg-interactive-hover px-2 py-0.5 text-[0.6875rem] text-muted-foreground',
        className,
      )}
    >
      {t('settings.kit.defaultsBadge')}
    </span>
  )
}
