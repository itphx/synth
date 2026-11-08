import { useState, type ReactNode } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import type { WipCounter } from './types'

export interface TaskGroupProps {
  /** Название группы (колонка плана / статус ToDo). */
  title: string
  /** Счётчик пунктов в группе. */
  count: number
  /** WIP-индикатор (`3/5`); `null` — не показывать. */
  wip?: WipCounter | null
  /** Группа свёрнута (контролируемый режим). */
  collapsed?: boolean
  /** Группа свёрнута при первом рендере. */
  defaultCollapsed?: boolean
  /** Изменение состояния свёрнутости. */
  onToggle?: (collapsed: boolean) => void
  /** Добавить пункт в группу. */
  onAdd?: () => void
  /** Подпись пустой группы. */
  emptyLabel?: string
  /** Содержимое группы (строки пунктов). */
  children?: ReactNode
  /** Маркер для тестов. */
  testId?: string
}

/**
 * Группа пунктов (колонка плана / статус ToDo) — общая для плана и ToDo.
 *
 * Пустые группы по умолчанию свёрнуты (места не занимают) — это решает
 * проблему прежней доски, где пустая колонка висела отдельным блоком.
 */
export function TaskGroup({
  title,
  count,
  wip,
  collapsed,
  defaultCollapsed = false,
  onToggle,
  onAdd,
  emptyLabel,
  children,
  testId,
}: TaskGroupProps) {
  const { t } = useI18n()
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed)
  const isCollapsed = collapsed ?? internalCollapsed
  const isEmpty = count === 0

  const toggle = () => {
    const next = !isCollapsed
    if (collapsed === undefined) setInternalCollapsed(next)
    onToggle?.(next)
  }

  return (
    <section className="flex min-w-0 flex-col gap-1" data-testid={testId} data-collapsed={isCollapsed ? 'true' : 'false'}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? t('work.group.expand') : t('work.group.collapse')}
          aria-label={isCollapsed ? t('work.group.expand') : t('work.group.collapse')}
          data-testid={testId ? `${testId}-toggle` : undefined}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-3.5" />
        </button>

        <span className="min-w-0 truncate text-[0.625rem] font-medium text-foreground" data-testid={testId ? `${testId}-title` : undefined}>
          {title}
        </span>
        <span className="shrink-0 text-[0.625rem] text-muted-foreground/60" data-testid={testId ? `${testId}-count` : undefined}>
          ({count})
        </span>

        {wip && (
          <span
            className={cn(
              'shrink-0 rounded px-1 py-0.5 text-[0.5625rem]',
              wip.current > wip.limit ? 'bg-status-warning/15 text-status-warning' : 'bg-muted text-muted-foreground',
            )}
            title={t('work.group.wip')}
            data-testid={testId ? `${testId}-wip` : undefined}
          >
            {wip.current}/{wip.limit}
          </span>
        )}

        <div className="flex-1" />

        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            title={t('work.group.add')}
            aria-label={t('work.group.add')}
            data-testid={testId ? `${testId}-add` : undefined}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="add" className="size-3.5" />
          </button>
        )}
      </div>

      {!isCollapsed && (
        <div className="flex min-w-0 flex-col gap-1" data-testid={testId ? `${testId}-body` : undefined}>
          {isEmpty ? (
            <div className="text-[0.625rem] text-muted-foreground/50" data-testid={testId ? `${testId}-empty` : undefined}>
              {emptyLabel ?? t('work.group.empty')}
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  )
}
