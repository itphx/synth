import { Fragment, useState } from 'react'

import type { TodoItem, TodoPriority, TodoStatus } from '@itphx/synth-shared/types'

import { useI18n } from '@/lib/i18n'
import { markdownToPlain } from '@/lib/markdown/plain'
import { Icon } from '@/components/icon/Icon'
import { TaskGroup } from './TaskGroup'
import { TaskRow } from './TaskRow'
import { TODO_STATUS_LABEL_KEYS } from './labels'
import type { WorkMoveTarget } from './types'

/** Порядок групп ToDo и их подписи (общий словарь статусов). */
const TODO_STATUS_ORDER: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/** Статусы, которые в панели свёрнуты по умолчанию. */
const TODO_COLLAPSED_BY_DEFAULT: TodoStatus[] = ['completed', 'cancelled']

/** Длина plain-заголовка пункта ToDo. */
const TODO_TITLE_LENGTH = 80

export interface TodoSummaryProps {
  /** Пункты ToDo сессии. */
  todos: TodoItem[]
  /** Право правки (write-доступ к сессии). */
  canEdit?: boolean
  /** Названия пунктов плана по `planItemId` (связь ADR-039). */
  planItemTitles?: Record<string, string>
  /** Переход к пункту плана проекта. */
  onOpenPlanItem?: (planItemId: string) => void
  /** Создать пункт. */
  onAdd?: (content: string, status: TodoStatus) => void
  /** Изменить пункт (текст/статус/приоритет). */
  onUpdate?: (
    todoId: string,
    patch: { content?: string; status?: TodoStatus; priority?: TodoPriority },
  ) => void
  /** Удалить пункт. */
  onDelete?: (todoId: string) => void
  /** Очистить выполненные (и отменённые). */
  onClearCompleted?: () => void
  /** Переупорядочивание (модальное окно): сдвиг пункта вверх/вниз. */
  onMoveUp?: (todoId: string) => void
  onMoveDown?: (todoId: string) => void
  /** Маркер для тестов. */
  testId?: string
}

/**
 * Компактный список ToDo сессии для правой панели (PROP-054).
 *
 * Тот же визуальный язык, что у плана (`TaskGroup`/`TaskRow`): группы по
 * статусам, счётчики, свёрнутые «выполнено»/«отменено», «+ пункт» и
 * «очистить выполненные». Связь `planItemId` показывается бейджем с
 * названием пункта плана.
 */
export function TodoSummary({
  todos,
  canEdit = false,
  planItemTitles,
  onOpenPlanItem,
  onAdd,
  onUpdate,
  onDelete,
  onClearCompleted,
  onMoveUp,
  onMoveDown,
  testId = 'todo-summary',
}: TodoSummaryProps) {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftStatus, setDraftStatus] = useState<TodoStatus>('pending')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const items = todos ?? []
  const groups = TODO_STATUS_ORDER.map((status) => ({
    status,
    items: items.filter((todo) => todo.status === status),
  })).filter((group) => group.items.length > 0)

  const moveTargets: WorkMoveTarget[] = TODO_STATUS_ORDER.map((status) => ({
    id: status,
    label: t(TODO_STATUS_LABEL_KEYS[status]),
  }))

  const submitAdd = () => {
    const content = draft.trim()
    setAdding(false)
    setDraft('')
    if (!content) return
    onAdd?.(content, draftStatus)
  }

  const submitEdit = (todoId: string) => {
    const content = editDraft.trim()
    setEditingId(null)
    if (!content) return
    onUpdate?.(todoId, { content })
  }

  const hasCompleted = items.some(
    (todo) => todo.status === 'completed' || todo.status === 'cancelled',
  )

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-[0.625rem] font-medium text-foreground">
          {t('sessionTab.todos.title')}
        </span>
        {canEdit && onClearCompleted && hasCompleted && (
          <button
            type="button"
            onClick={onClearCompleted}
            data-testid={`${testId}-clear`}
            className="min-h-6 shrink-0 rounded border border-border px-2 py-1 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('work.todo.clearCompleted')}
          </button>
        )}
      </div>

      {items.length === 0 && !adding && (
        <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
          <div className="text-xs text-muted-foreground">{t('sessionTab.todos.empty')}</div>
          <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60">
            {t('sessionTab.todos.hint')}
          </div>
        </div>
      )}

      {canEdit && onAdd && !adding && (
        <button
          type="button"
          onClick={() => {
            setAdding(true)
            setDraft('')
            setDraftStatus('pending')
          }}
          data-testid={`${testId}-add`}
          className="self-start rounded-lg border border-border px-2 py-1 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-interactive-hover"
        >
          {t('work.todo.add')}
        </button>
      )}

      {adding && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-input p-2" data-testid={`${testId}-add-form`}>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder={t('work.todo.placeholder')}
            aria-label={t('work.todo.placeholder')}
            data-testid={`${testId}-add-textarea`}
            className="w-full min-w-0 resize-y rounded border border-border bg-background px-2 py-1 text-base text-foreground sm:text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center justify-between gap-2">
            <select
              value={draftStatus}
              onChange={(e) => setDraftStatus(e.target.value as TodoStatus)}
              aria-label={t('work.todo.status')}
              data-testid={`${testId}-add-status`}
              className="min-w-0 rounded border border-border bg-input px-1 py-0.5 text-[0.625rem] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {TODO_STATUS_ORDER.map((status) => (
                <option key={status} value={status}>
                  {t(TODO_STATUS_LABEL_KEYS[status])}
                </option>
              ))}
            </select>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setAdding(false)
                  setDraft('')
                }}
                data-testid={`${testId}-add-cancel`}
                className="rounded-lg border border-border px-2 py-1 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-interactive-hover"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={submitAdd}
                data-testid={`${testId}-add-submit`}
                className="rounded-lg border border-transparent bg-primary px-2 py-1 text-[0.625rem] font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                {t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {groups.map((group) => (
        <TaskGroup
          key={group.status}
          title={t(TODO_STATUS_LABEL_KEYS[group.status])}
          count={group.items.length}
          defaultCollapsed={TODO_COLLAPSED_BY_DEFAULT.includes(group.status)}
          testId={`${testId}-group-${group.status}`}
        >
          {group.items.map((todo) => {
            const planTitle = todo.planItemId ? planItemTitles?.[todo.planItemId] : undefined
            return (
              <Fragment key={todo.id}>
                <TaskRow
                  title={plainTitle(todo.content)}
                  priority={todo.priority}
                  body={todo.content}
                  showPreview={false}
                  badges={
                    <>
                      {planTitle && (
                        <button
                          type="button"
                          onClick={() => onOpenPlanItem?.(todo.planItemId!)}
                          title={t('work.todo.planLink', { title: planTitle })}
                          data-testid={`${testId}-item-${todo.id}-plan`}
                          className="max-w-[10rem] truncate rounded bg-primary/10 px-1 py-0.5 text-[0.5625rem] text-primary transition-colors hover:bg-primary/20"
                        >
                          {t('work.todo.planLink', { title: planTitle })}
                        </button>
                      )}
                      {(onMoveUp || onMoveDown) && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          {onMoveUp && (
                            <button
                              type="button"
                              onClick={() => onMoveUp(todo.id)}
                              aria-label={t('work.todo.moveUp')}
                              data-testid={`${testId}-item-${todo.id}-up`}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <Icon name="arrow-up-s" className="size-3" />
                            </button>
                          )}
                          {onMoveDown && (
                            <button
                              type="button"
                              onClick={() => onMoveDown(todo.id)}
                              aria-label={t('work.todo.moveDown')}
                              data-testid={`${testId}-item-${todo.id}-down`}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <Icon name="arrow-down-s" className="size-3" />
                            </button>
                          )}
                        </span>
                      )}
                    </>
                  }
                  details={<TodoDetails todo={todo} planTitle={planTitle} />}
                  onEdit={
                    canEdit && onUpdate
                      ? () => {
                          setEditingId(todo.id)
                          setEditDraft(todo.content)
                        }
                      : undefined
                  }
                  onMove={undefined}
                  moveTargets={canEdit && onUpdate ? moveTargets : undefined}
                  onMoveTo={
                    canEdit && onUpdate
                      ? (status) => onUpdate(todo.id, { status: status as TodoStatus })
                      : undefined
                  }
                    onDelete={canEdit && onDelete ? () => onDelete(todo.id) : undefined}
                    testId={`${testId}-item-${todo.id}`}
                  />
                {editingId === todo.id && (
                  <div
                    className="flex flex-col gap-1 rounded-lg border border-border bg-input p-2"
                    data-testid={`${testId}-item-${todo.id}-editor`}
                  >
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      aria-label={t('work.todo.edit')}
                      data-testid={`${testId}-item-${todo.id}-textarea`}
                      className="w-full min-w-0 resize-y rounded border border-border bg-background px-2 py-1 text-base text-foreground sm:text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        data-testid={`${testId}-item-${todo.id}-cancel`}
                        className="rounded-lg border border-border px-2 py-1 text-[0.625rem] text-foreground transition-colors hover:bg-interactive-hover"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => submitEdit(todo.id)}
                        data-testid={`${testId}-item-${todo.id}-submit`}
                        className="rounded-lg border border-transparent bg-primary px-2 py-1 text-[0.625rem] font-medium text-primary-foreground transition-opacity hover:opacity-90"
                      >
                        {t('common.save')}
                      </button>
                    </div>
                  </div>
                )}
              </Fragment>
            )
          })}
        </TaskGroup>
      ))}
    </div>
  )
}

/** Plain-заголовок пункта: первая строка Markdown без разметки. */
function plainTitle(content: string): string {
  const plain = markdownToPlain(content ?? '').replace(/\s+/g, ' ').trim()
  if (plain.length <= TODO_TITLE_LENGTH) return plain
  return `${plain.slice(0, TODO_TITLE_LENGTH - 1)}…`
}

/** Раскрытые детали пункта ToDo: id и связь с планом. */
function TodoDetails({ todo, planTitle }: { todo: TodoItem; planTitle?: string }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono">{todo.id}</span>
      {todo.planItemId && (
        <span>
          {t('work.todo.planItem', { id: todo.planItemId, title: planTitle ?? '' })}
        </span>
      )}
    </div>
  )
}
