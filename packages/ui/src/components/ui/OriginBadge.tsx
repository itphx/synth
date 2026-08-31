import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { EntityOrigin } from '@/lib/api/synthApi'

/**
 * Компактный бейдж происхождения сущности (гибридный режим).
 * remote — всегда показывается («удалённо», синий); local — скрыт по умолчанию,
 * показывается только с showLocal (нейтральный серый).
 */
export function OriginBadge({
  origin,
  showLocal = false,
  className,
}: {
  origin?: EntityOrigin
  showLocal?: boolean
  className?: string
}) {
  const { t } = useI18n()
  if (!origin) return null
  if (origin === 'local' && !showLocal) return null

  return (
    <span
      className={cn(
        'ml-1 inline-flex shrink-0 items-center rounded px-1 py-px text-[0.6rem] font-medium leading-none',
        origin === 'remote'
          ? 'border border-sky-500/30 bg-sky-500/15 text-sky-500'
          : 'border border-border bg-interactive text-muted-foreground',
        className,
      )}
    >
      {origin === 'remote' ? t('hybrid.remote') : t('hybrid.local')}
    </span>
  )
}
