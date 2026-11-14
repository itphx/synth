import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { ProjectVisibility } from '@/lib/api/synthApi'

/**
 * PROP-133 §4: компактный бейдж режима доступа к проекту в списке.
 *
 * Показывается только для не-авторского режима (`selected`/`all`) — «Только
 * автору» это состояние по умолчанию, и бейдж на каждом проекте шумел бы.
 * Иконка + `title`/`aria-label`: подпись не занимает место в строке дерева,
 * но доступна с клавиатуры и по наведению.
 */
export function ProjectAccessBadge({
  visibility,
  className,
}: {
  visibility?: ProjectVisibility
  className?: string
}) {
  const { t } = useI18n()
  if (visibility !== 'selected' && visibility !== 'all') return null

  const label =
    visibility === 'all' ? t('project.access.badge.all') : t('project.access.badge.selected')

  return (
    <span
      className={cn(
        'ml-1 inline-flex shrink-0 items-center rounded border border-border bg-interactive px-1 py-px text-muted-foreground',
        className,
      )}
      title={label}
      aria-label={label}
      data-testid={`project-access-badge-${visibility}`}
    >
      <Icon name={visibility === 'all' ? 'global' : 'user-3'} className="size-3" aria-hidden />
    </span>
  )
}
