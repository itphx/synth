import { useState } from 'react'

import type { PlanColumn, PlanItem, ProjectPlan } from '@itphx/synth-shared/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { MarkdownText } from './MarkdownText'
import { WORK_PRIORITY_CLASSES, WORK_PRIORITY_LABEL_KEYS } from './labels'
import { usePlanCardDrag } from './usePlanCardDrag'

export interface PlanBoardProps {
  /** План проекта (`null` — плана нет). */
  plan: ProjectPlan | null
  /** Только чтение: карточки не перетаскиваются, действия скрыты. */
  readOnly?: boolean
  /**
   * Разрешить перетаскивание карточек (Pointer Events).
   *
   * На тач-устройствах drag отключён (ADR-044) — перемещение через меню
   * (кнопка «Переместить» на карточке); хук сам пропускает touch. По умолчанию
   * drag включён, а выключать его должен вызывающий (он знает про права).
   */
  dragEnabled?: boolean
  /** Пункт перемещён в колонку. */
  onMoveItem?: (itemId: string, columnId: string) => void
  /** Пункт изменён (правка заголовка/описания). */
  onEditItem?: (itemId: string) => void
  /** Пункт удалён. */
  onDeleteItem?: (itemId: string) => void
  /** Быстрое добавление пункта в колонку. */
  onAddItem?: (columnId: string, title: string) => void
  /** Колонка переименована. */
  onRenameColumn?: (columnId: string, name: string) => void
  /** Колонка удалена (пункты удаляются вместе с ней — подтверждение у вызывающего). */
  onDeleteColumn?: (columnId: string) => void
  /** Добавлена колонка. */
  onAddColumn?: () => void
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
 * Kanban-доска плана (PROP-054): колонки горизонтально, карточки перетаскиваются
 * на Pointer Events через `usePlanCardDrag` (preview — точный DOM-клон карточки;
 * нативного drag-image с прямоугольными углами нет). На тач-устройствах
 * перемещение — через меню «Переместить» (ADR-044).
 *
 * Новых зависимостей нет.
 */
export function PlanBoard({
  plan,
  readOnly = false,
  dragEnabled = true,
  onMoveItem,
  onEditItem,
  onDeleteItem,
  onAddItem,
  onRenameColumn,
  onDeleteColumn,
  onAddColumn,
  testId,
}: PlanBoardProps) {
  const { t } = useI18n()
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null)
  const [renamingColumn, setRenamingColumn] = useState<string | null>(null)
  const [columnNameDraft, setColumnNameDraft] = useState('')
  const [quickAddColumn, setQuickAddColumn] = useState<string | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const { onPointerDown, draggingCardId } = usePlanCardDrag({
    enabled: dragEnabled && !readOnly,
    onColumnChange: setDragOverColumn,
    onDrop: (itemId, columnId) => onMoveItem?.(itemId, columnId),
  })

  const columns = [...(plan?.columns ?? [])].sort((a, b) => a.order - b.order)
  const items = plan?.items ?? []

  if (!plan || columns.length === 0) {
    return (
      <div
        className="rounded-lg border border-border bg-surface-inset px-3 py-2"
        data-testid={testId ? `${testId}-empty` : 'plan-board-empty'}
      >
        <div className="text-xs text-muted-foreground">{t('work.board.empty')}</div>
      </div>
    )
  }

  const submitQuickAdd = (columnId: string) => {
    const title = quickTitle.trim()
    if (!title) {
      setQuickAddColumn(null)
      return
    }
    onAddItem?.(columnId, title)
    setQuickTitle('')
    setQuickAddColumn(null)
  }

  const submitRename = (column: PlanColumn) => {
    const name = columnNameDraft.trim()
    setRenamingColumn(null)
    if (!name || name === column.name) return
    onRenameColumn?.(column.id, name)
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-testid={testId ?? 'plan-board'}
      onPointerDown={onPointerDown}
    >
      <div
        className="flex min-w-0 gap-2 overflow-x-auto pb-1"
        data-testid={testId ? `${testId}-columns` : 'plan-board-columns'}
      >
        {columns.map((column) => {
          const columnItems = itemsOfColumn(items, column.id)
          const wipLimit = column.wipLimit
          return (
            <section
              key={column.id}
              className={cn(
                'flex w-60 min-w-[15rem] shrink-0 flex-col gap-1.5 rounded-lg border border-border/60 bg-surface-inset p-2',
                dragOverColumn === column.id && 'border-primary',
              )}
              data-plan-column-id={column.id}
              data-testid={testId ? `${testId}-column-${column.id}` : `plan-board-column-${column.id}`}
            >
              <header className="flex min-w-0 items-center gap-1.5">
                {renamingColumn === column.id ? (
                  <input
                    autoFocus
                    value={columnNameDraft}
                    onChange={(e) => setColumnNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename(column)
                      if (e.key === 'Escape') setRenamingColumn(null)
                    }}
                    aria-label={t('work.board.columnName')}
                    data-testid={testId ? `${testId}-column-${column.id}-name-input` : undefined}
                    className="min-w-0 flex-1 rounded border border-border bg-input px-1 py-0.5 text-base text-foreground sm:text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[0.625rem] font-medium text-foreground" data-testid={testId ? `${testId}-column-${column.id}-name` : undefined}>
                    {column.name}
                  </span>
                )}
                <span className="shrink-0 text-[0.625rem] text-muted-foreground/60">{columnItems.length}</span>
                {wipLimit !== undefined && wipLimit !== null && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0.5 text-[0.5625rem]',
                      columnItems.length > wipLimit ? 'bg-status-warning/15 text-status-warning' : 'bg-muted text-muted-foreground',
                    )}
                    title={t('work.group.wip')}
                    data-testid={testId ? `${testId}-column-${column.id}-wip` : undefined}
                  >
                    {columnItems.length}/{wipLimit}
                  </span>
                )}
                {!readOnly && onRenameColumn && renamingColumn !== column.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingColumn(column.id)
                      setColumnNameDraft(column.name)
                    }}
                    title={t('work.task.action.edit')}
                    aria-label={t('work.task.action.edit')}
                    data-testid={testId ? `${testId}-column-${column.id}-rename` : undefined}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon name="edit-2" className="size-3" />
                  </button>
                )}
                {!readOnly && onDeleteColumn && columns.length > 1 && renamingColumn !== column.id && (
                  <button
                    type="button"
                    onClick={() => onDeleteColumn(column.id)}
                    title={t('work.board.deleteColumn')}
                    aria-label={t('work.board.deleteColumn')}
                    data-testid={testId ? `${testId}-column-${column.id}-delete` : undefined}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon name="trash-2" className="size-3" />
                  </button>
                )}
              </header>

              <div className="flex min-w-0 flex-col gap-1">
                {columnItems.map((item) => (
                  <article
                    key={item.id}
                    data-plan-card-id={item.id}
                    className={cn(
                      'group min-w-0 select-none',
                      draggingCardId === item.id && 'opacity-40',
                    )}
                    data-testid={testId ? `${testId}-item-${item.id}` : `plan-board-item-${item.id}`}
                  >
                    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 bg-input px-2 py-1.5">
                    <div className="flex min-w-0 items-start gap-1.5">
                      <span className="min-w-0 flex-1 break-words text-xs text-foreground">{item.title}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide',
                          WORK_PRIORITY_CLASSES[item.priority],
                        )}
                      >
                        {t(WORK_PRIORITY_LABEL_KEYS[item.priority])}
                      </span>
                    </div>

                    {item.description && (
                      <MarkdownText
                        content={item.description}
                        mode="plain"
                        maxLength={100}
                        className="text-[0.625rem] text-muted-foreground/70"
                      />
                    )}

                    {!readOnly && (
                      <div className="flex items-center gap-0.5">
                        {onEditItem && (
                          <button
                            type="button"
                            onClick={() => onEditItem(item.id)}
                            title={t('work.task.action.edit')}
                            aria-label={t('work.task.action.edit')}
                            data-testid={testId ? `${testId}-item-${item.id}-edit` : undefined}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Icon name="edit-2" className="size-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setMoveMenuFor((v) => (v === item.id ? null : item.id))}
                          title={t('work.task.action.move')}
                          aria-label={t('work.task.action.move')}
                          aria-expanded={moveMenuFor === item.id}
                          data-testid={testId ? `${testId}-item-${item.id}-move` : undefined}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Icon name="expand-up-down" className="size-3" />
                        </button>
                        {onDeleteItem && (
                          <button
                            type="button"
                            onClick={() => onDeleteItem(item.id)}
                            title={t('work.task.action.delete')}
                            aria-label={t('work.task.action.delete')}
                            data-testid={testId ? `${testId}-item-${item.id}-delete` : undefined}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Icon name="trash-2" className="size-3" />
                          </button>
                        )}
                      </div>
                    )}

                    {moveMenuFor === item.id && (
                      <div
                        role="menu"
                        aria-label={t('work.task.moveMenu')}
                        className="flex flex-wrap gap-1 rounded border border-border bg-surface-inset px-1 py-1"
                        data-testid={testId ? `${testId}-item-${item.id}-menu` : undefined}
                      >
                        {columns.map((target) => (
                          <button
                            key={target.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMoveMenuFor(null)
                              onMoveItem?.(item.id, target.id)
                            }}
                            data-testid={testId ? `${testId}-item-${item.id}-move-${target.id}` : undefined}
                            className="min-h-6 rounded border border-border px-2 py-1 text-[0.625rem] text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {target.name}
                          </button>
                        ))}
                      </div>
                    )}
                    </div>
                  </article>
                ))}
              </div>

              {!readOnly && onAddItem && (
                <>
                  {quickAddColumn === column.id ? (
                    <input
                      autoFocus
                      value={quickTitle}
                      onChange={(e) => setQuickTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitQuickAdd(column.id)
                        if (e.key === 'Escape') {
                          setQuickAddColumn(null)
                          setQuickTitle('')
                        }
                      }}
                      placeholder={t('work.board.itemPlaceholder')}
                      aria-label={t('work.board.itemPlaceholder')}
                      data-testid={testId ? `${testId}-column-${column.id}-quick-input` : undefined}
                      className="min-w-0 rounded border border-border bg-input px-1 py-0.5 text-base text-foreground sm:text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setQuickAddColumn(column.id)
                        setQuickTitle('')
                      }}
                      data-testid={testId ? `${testId}-column-${column.id}-add` : undefined}
                      className="self-start rounded px-1 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
                    >
                      {t('work.board.addItem')}
                    </button>
                  )}
                </>
              )}
            </section>
          )
        })}
      </div>

      {!readOnly && onAddColumn && (
        <button
          type="button"
          onClick={onAddColumn}
          data-testid={testId ? `${testId}-add-column` : 'plan-board-add-column'}
          className="self-start rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-interactive-hover"
        >
          {t('work.board.addColumn')}
        </button>
      )}
    </div>
  )
}
