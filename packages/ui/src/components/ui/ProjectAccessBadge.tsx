import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { ProjectVisibility } from '@/lib/api/synthApi'

/**
 * PROP-133 §4: компактный бейдж режима доступа к проекту в списке.
 *
 * Показывается только для не-авторского режима (`selected`/`all`) — «Только
 * автору» это состояние по умолчанию, и бейдж на каждом проекте шумил бы.
 * Иконка + `title`/`aria-label`: подпись не занимает место в строке дерева,
 * но доступна с клавиатуры и по наведению.
 *
 * ADR-140 Ф2: для режима «Только выбранным» подпись зависит от **состава**
 * грантов — только группам («выбранным группам»), группам и пользователям
 * («группам и пользователям») или пользователям (как раньше).
 */
export function ProjectAccessBadge({
  visibility,
  groupMembers,
  members,
  className,
}: {
  visibility?: ProjectVisibility
  /** Гранты группам (`группа → роль`) — из DTO проекта. */
  groupMembers?: Record<string, string> | null
  /** Гранты пользователям (`пользователь → роль`) — из DTO проекта. */
  members?: Record<string, string> | null
  className?: string
}) {
  const { t } = useI18n()
  if (visibility !== 'selected' && visibility !== 'all') return null

  // Владелец записан в `members` ролью `owner` — грантом он не считается.
  const hasUserGrants = Object.values(members ?? {}).some((role) => role !== 'owner')
  const hasGroupGrants = Object.keys(groupMembers ?? {}).length > 0

  const label =
    visibility === 'all'
      ? t('project.access.badge.all')
      : hasGroupGrants
        ? hasUserGrants
          ? t('project.access.badge.groupsAndUsers')
          : t('project.access.badge.selectedGroups')
        : t('project.access.badge.selected')

  const icon =
    visibility === 'all' ? 'global' : hasGroupGrants && !hasUserGrants ? 'group' : 'user-3'

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
      <Icon name={icon} className="size-3" aria-hidden />
    </span>
  )
}
