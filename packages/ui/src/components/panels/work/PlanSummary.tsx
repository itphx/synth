import { useState } from 'react'

import type { PlanItem, ProjectPlan } from '@itphx/synth-shared/types'

import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { TaskGroup } from './TaskGroup'
import { TaskRow } from './TaskRow'

/**
 * Сколько пунктов группы показываем в панели до «показать ещё».
 *
 * Полный список — в модальном окне (`WorkModal`, вкладка «Доска»): в панели
 * нет ни вложенного скролла, ни `max-h-*` (PROP-054: «Убрать фиксированный
 * max-h-48»).
 */
export const PLAN_PREVIEW_ITEMS = 5

export interface PlanSummaryProps {
  /** План проекта (`null` — плана нет). */
  plan: ProjectPlan | null
  /** Право правки (owner/EDITOR/LEAD/ADMIN). */
  canEdit?: boolean
  /** Создать пункт в колонке. */
  onAddItem?: (columnId: string, title: string) => void
  /** Удалить пункт. */
  onDeleteItem?: (itemId: string) => void
  /** Создать план с дефолтными колонками (пустое состояние). */
  onCreatePlan?: () => void
  /** Открыть полную доску (модальное окно). */
  onOpenBoard?: () => void
  /** Маркер для тестов. */
  testId?: string
}

/** Пункты колонки в порядке `order`. */
function itemsOfColumn(items: PlanItem[], columnId: string): PlanItem[] {
  return items
    .filter((item) => item.columnId === columnId)
    .sort((a, b) => a.order - b.order)
}

/**
 * Компактный план проекта для правой панели (PROP-054).
 *
 * Группы по колонкам (`TaskGroup`): имя, счётчик, WIP, collapse, «+ пункт»;
 * внутри — строки `TaskRow` (статус-колонка, заголовок, приоритет, plain-
 * превью описания). Показаны первые {@link PLAN_PREVIEW_ITEMS} пунктов
 * группы, дальше — «показать ещё»; полный список — в модальном окне.
 */
export function PlanSummary({
  plan,
  canEdit = false,
  onAddItem,
  onDeleteItem,
  onCreatePlan,
  onOpenBoard,
  testId = 'plan-summary',
}: PlanSummaryProps) {
  const { t } = useI18n()
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [addingColumnId, setAddingColumnId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const columns = [...(plan?.columns ?? [])].sort((a, b) => a.order - b.order)
  const items = plan?.items ?? []
  const total = items.length
  const active = items.filter((item) => {
    const column = columns.find((col) => col.id === item.columnId)
    return column ? isActiveColumn(column.name) : false
  }).length

  const startAdd = (columnId: string) => {
    setAddingColumnId(columnId)
    setDraft('')
  }

  const submitAdd = (columnId: string) => {
    const title = draft.trim()
    setAddingColumnId(null)
    setDraft('')
    if (!title) return
    onAddItem?.(columnId, title)
  }

  if (!plan || columns.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.625rem] font-medium text-foreground">{t('sessionTab.plan.title')}</span>
          {onOpenBoard && (
            <button
              type="button"
              onClick={onOpenBoard}
              data-testid={`${testId}-board`}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-foreground transition-colors hover:bg-interactive-hover"
            >
              {t('work.modal.tab.board')}
            </button>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
          <div className="text-xs text-muted-foreground">{t('sessionTab.plan.empty')}</div>
          <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60">{t('sessionTab.plan.hint')}</div>
          {canEdit && onCreatePlan && (
            <button
              type="button"
              onClick={onCreatePlan}
              data-testid={`${testId}-create`}
              className="mt-1.5 self-start rounded-lg border border-border px-2 py-1 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-interactive-hover"
            >
              {t('work.plan.create')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-[0.625rem] font-medium text-foreground">{t('sessionTab.plan.title')}</span>
          <span className="text-[0.625rem] text-muted-foreground/60" data-testid={`${testId}-summary`}>
            {t('work.plan.summary', { count: total, active })}
          </span>
        </div>
        {onOpenBoard && (
          <button
            type="button"
            onClick={onOpenBoard}
            data-testid={`${testId}-board`}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-foreground transition-colors hover:bg-interactive-hover"
          >
            <Icon name="layout-masonry" className="size-3" />
            {t('work.modal.tab.board')}
          </button>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2" data-testid={`${testId}-groups`}>
        {columns.map((column) => {
          const columnItems = itemsOfColumn(items, column.id)
          const expanded = expandedGroups[column.id] === true
          const visible = expanded ? columnItems : columnItems.slice(0, PLAN_PREVIEW_ITEMS)
          const hidden = columnItems.length - visible.length
          return (
            <TaskGroup
              key={column.id}
              title={column.name}
              count={columnItems.length}
              wip={column.wipLimit ? { current: columnItems.length, limit: column.wipLimit } : null}
              defaultCollapsed={columnItems.length === 0}
              onAdd={canEdit && onAddItem ? () => startAdd(column.id) : undefined}
              testId={`${testId}-group-${column.id}`}
            >
              {visible.map((item) => (
                <TaskRow
                  key={item.id}
                  title={item.title}
                  priority={item.priority}
                  body={item.description}
                  details={<PlanItemDetails item={item} />}
                  onDelete={canEdit && onDeleteItem ? () => onDeleteItem(item.id) : undefined}
                  testId={`${testId}-item-${item.id}`}
                />
              ))}

              {addingColumnId === column.id && (
                <div className="flex items-center gap-1" data-testid={`${testId}-add-form`}>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitAdd(column.id)
                      if (e.key === 'Escape') {
                        setAddingColumnId(null)
                        setDraft('')
                      }
                    }}
                    placeholder={t('work.board.itemPlaceholder')}
                    aria-label={t('work.board.itemPlaceholder')}
                    data-testid={`${testId}-add-input`}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => submitAdd(column.id)}
                    data-testid={`${testId}-add-submit`}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-foreground transition-colors hover:bg-interactive-hover"
                  >
                    {t('common.create')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingColumnId(null)
                      setDraft('')
                    }}
                    data-testid={`${testId}-add-cancel`}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              )}

              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setExpandedGroups((prev) => ({ ...prev, [column.id]: true }))}
                  data-testid={`${testId}-group-${column.id}-more`}
                  className="self-start rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover"
                >
                  {t('work.plan.showMore', { count: hidden })}
                </button>
              )}

              {expanded && columnItems.length > PLAN_PREVIEW_ITEMS && (
                <button
                  type="button"
                  onClick={() => setExpandedGroups((prev) => ({ ...prev, [column.id]: false }))}
                  data-testid={`${testId}-group-${column.id}-less`}
                  className="self-start rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover"
                >
                  {t('work.plan.showLess')}
                </button>
              )}
            </TaskGroup>
          )
        })}
      </div>
    </div>
  )
}

/** Раскрытые детали пункта плана: id, даты, теги, зависимости. */
function PlanItemDetails({ item }: { item: PlanItem }) {
  const { t } = useI18n()
  const dependencies = item.dependsOn ?? []
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono">{item.id}</span>
      <span>{t('work.plan.updatedAt', { date: item.updatedAt })}</span>
      {item.tags && item.tags.length > 0 && (
        <span>{t('work.plan.tags', { tags: item.tags.join(', ') })}</span>
      )}
      {dependencies.length > 0 && (
        <span>{t('work.plan.dependsOn', { count: dependencies.length })}</span>
      )}
    </div>
  )
}

/**
 * Колонка считается «в работе», если её имя похоже на активную фазу.
 *
 * Названия колонок задаёт пользователь, поэтому сравнение по имени — лишь
 * эвристика для сводки «N в работе»; точное число не критично (полная
 * статистика — в модальном окне).
 */
function isActiveColumn(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return false
  return (
    normalized.includes('в работе') ||
    normalized.includes('progress') ||
    normalized.includes('doing') ||
    normalized.includes('active') ||
    normalized.includes('wip')
  )
}
