import type { TodoItem } from '@itphx/synth-shared/types'
import type { ProjectPlan } from '@itphx/synth-shared/types'
import type { ProjectLogEntryDto } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { TODO_STATUS_LABEL_KEYS, WORK_PRIORITY_LABEL_KEYS } from './labels'
import type { WorkPriority } from './types'

export interface WorkStatsProps {
  /** План проекта. */
  plan?: ProjectPlan | null
  /** Пункты ToDo сессии. */
  todos?: TodoItem[] | null
  /** Записи журнала (текущая страница). */
  journalEntries?: ProjectLogEntryDto[]
  /** Всего записей журнала (счётчик берётся из страницы). */
  journalTotal?: number
  /** Маркер для тестов. */
  testId?: string
}

/** Строка счётчика: подпись + значение + доля (0..1). */
function StatRow({
  label,
  value,
  share,
  testId,
}: {
  label: string
  value: number
  /** Доля от общего (для полоски прогресса). */
  share?: number
  testId?: string
}) {
  const percent = share === undefined ? undefined : Math.max(0, Math.min(1, share)) * 100
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <div className="flex min-w-0 items-center justify-between gap-2 text-[0.625rem]">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 font-medium text-foreground">{value}</span>
      </div>
      {percent !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded bg-muted" aria-hidden="true">
          <div className="h-full rounded bg-primary" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  )
}

/** Заголовок секции статистики. */
function StatSection({
  title,
  children,
  testId,
}: {
  title: string
  children: React.ReactNode
  testId?: string
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <h4 className="text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

/**
 * Статистика работы (PROP-054): счётчики и прогресс по плану, ToDo и журналу.
 *
 * Только счётчики — метрик по срокам/стоимости в модели плана нет (due date
 * не заводили).
 */
export function WorkStats({
  plan,
  todos,
  journalEntries,
  journalTotal,
  testId,
}: WorkStatsProps) {
  const { t } = useI18n()

  const planItems = plan?.items ?? []
  const planColumns = [...(plan?.columns ?? [])].sort((a, b) => a.order - b.order)
  const todoItems = todos ?? []
  const entries = journalEntries ?? []

  const planDone = planItems.filter((item) => {
    const column = planColumns.find((col) => col.id === item.columnId)
    return column ? /done|готово/i.test(column.name) : false
  }).length
  const planTotal = planItems.length

  const todoDone = todoItems.filter((todo) => todo.status === 'completed').length
  const todoTotal = todoItems.length

  const journalCount = journalTotal ?? entries.length

  const byPriority = (items: { priority: string }[]) => {
    const map = new Map<string, number>()
    for (const item of items) map.set(item.priority, (map.get(item.priority) ?? 0) + 1)
    return map
  }

  const planPriorities = byPriority(planItems)
  const todoPriorities = byPriority(todoItems)

  const todoStatuses = new Map<string, number>()
  for (const todo of todoItems) todoStatuses.set(todo.status, (todoStatuses.get(todo.status) ?? 0) + 1)

  const authors = new Map<string, number>()
  for (const entry of entries) {
    const key = entry.author ?? t('work.journal.unknownAuthor')
    authors.set(key, (authors.get(key) ?? 0) + 1)
  }

  const days = new Map<string, number>()
  for (const entry of entries) {
    const day = entry.created_at.slice(0, 10)
    days.set(day, (days.get(day) ?? 0) + 1)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={testId ?? 'work-stats'}>
      <StatSection title={t('work.stats.plan')} testId="work-stats-plan">
        <StatRow
          label={t('work.stats.total')}
          value={planTotal}
          testId="work-stats-plan-total"
        />
        <StatRow
          label={t('work.stats.progress')}
          value={planTotal === 0 ? 0 : Math.round((planDone / planTotal) * 100)}
          share={planTotal === 0 ? 0 : planDone / planTotal}
          testId="work-stats-plan-progress"
        />
        <div className="flex min-w-0 flex-col gap-1" data-testid="work-stats-plan-columns">
          {planColumns.map((column) => (
            <StatRow
              key={column.id}
              label={column.name}
              value={planItems.filter((item) => item.columnId === column.id).length}
              testId={`work-stats-plan-column-${column.id}`}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-1" data-testid="work-stats-plan-priorities">
          {(Object.keys(WORK_PRIORITY_LABEL_KEYS) as WorkPriority[]).map((priority) => (
            <StatRow
              key={priority}
              label={t(WORK_PRIORITY_LABEL_KEYS[priority])}
              value={planPriorities.get(priority) ?? 0}
              testId={`work-stats-plan-priority-${priority}`}
            />
          ))}
        </div>
      </StatSection>

      <StatSection title={t('work.stats.todos')} testId="work-stats-todos">
        <StatRow label={t('work.stats.total')} value={todoTotal} testId="work-stats-todos-total" />
        <StatRow
          label={t('work.stats.progress')}
          value={todoTotal === 0 ? 0 : Math.round((todoDone / todoTotal) * 100)}
          share={todoTotal === 0 ? 0 : todoDone / todoTotal}
          testId="work-stats-todos-progress"
        />
        <div className="flex min-w-0 flex-col gap-1" data-testid="work-stats-todos-statuses">
          {Object.keys(TODO_STATUS_LABEL_KEYS).map((status) => (
            <StatRow
              key={status}
              label={t(TODO_STATUS_LABEL_KEYS[status as keyof typeof TODO_STATUS_LABEL_KEYS])}
              value={todoStatuses.get(status) ?? 0}
              testId={`work-stats-todos-status-${status}`}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-1" data-testid="work-stats-todos-priorities">
          {(Object.keys(WORK_PRIORITY_LABEL_KEYS) as WorkPriority[]).map((priority) => (
            <StatRow
              key={priority}
              label={t(WORK_PRIORITY_LABEL_KEYS[priority])}
              value={todoPriorities.get(priority) ?? 0}
              testId={`work-stats-todos-priority-${priority}`}
            />
          ))}
        </div>
      </StatSection>

      <StatSection title={t('work.stats.journal')} testId="work-stats-journal">
        <StatRow label={t('work.stats.total')} value={journalCount} testId="work-stats-journal-total" />
        <div className={cn('flex min-w-0 flex-col gap-1')} data-testid="work-stats-journal-authors">
          {[...authors.entries()].map(([author, count]) => (
            <StatRow key={author} label={author} value={count} testId={`work-stats-journal-author-${author}`} />
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-1" data-testid="work-stats-journal-days">
          {[...days.entries()].map(([day, count]) => (
            <StatRow key={day} label={day} value={count} testId={`work-stats-journal-day-${day}`} />
          ))}
        </div>
      </StatSection>
    </div>
  )
}
