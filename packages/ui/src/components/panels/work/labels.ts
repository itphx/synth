// Общие словари статусов/приоритетов для плана и ToDo (PROP-054).
//
// Ключи **те же**, что у панели «Сессия» (`sessionTab.todo.*`) — один словарь
// на весь продукт, дублировать подписей в новых компонентах нельзя.

import type { TodoPriority, TodoStatus } from '@itphx/synth-shared/types'
import type { WorkPriority } from './types'

/** Ключ подписи статуса ToDo. */
export const TODO_STATUS_LABEL_KEYS: Record<TodoStatus, string> = {
  pending: 'sessionTab.todo.status.pending',
  in_progress: 'sessionTab.todo.status.in_progress',
  completed: 'sessionTab.todo.status.completed',
  cancelled: 'sessionTab.todo.status.cancelled',
}

/** Классы бейджа статуса ToDo. */
export const TODO_STATUS_CLASSES: Record<TodoStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  in_progress: 'bg-status-info/15 text-status-info',
  completed: 'bg-status-success/15 text-status-success',
  cancelled: 'bg-destructive/10 text-destructive',
}

/** Ключ подписи приоритета (общий для плана и ToDo). */
export const TODO_PRIORITY_LABEL_KEYS: Record<TodoPriority, string> = {
  high: 'sessionTab.todo.priority.high',
  medium: 'sessionTab.todo.priority.medium',
  low: 'sessionTab.todo.priority.low',
}

/** Классы бейджа приоритета. */
export const TODO_PRIORITY_CLASSES: Record<TodoPriority, string> = {
  high: 'bg-status-error/15 text-status-error',
  medium: 'bg-status-warning/15 text-status-warning',
  low: 'bg-muted text-muted-foreground',
}

/** Ключ подписи приоритета для общего компонента `TaskRow`. */
export const WORK_PRIORITY_LABEL_KEYS: Record<WorkPriority, string> =
  TODO_PRIORITY_LABEL_KEYS

/** Классы бейджа приоритета для общего компонента `TaskRow`. */
export const WORK_PRIORITY_CLASSES: Record<WorkPriority, string> =
  TODO_PRIORITY_CLASSES
