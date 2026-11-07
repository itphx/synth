// Общие типы UI-слоя «план/ToDo/журнал/инварианты» (PROP-054, волна 1).
//
// План и ToDo — **один визуальный язык** (`TaskRow`/`TaskGroup`), поэтому
// приоритет и цель перемещения описаны здесь, а не в каждом компоненте.

/** Приоритет пункта (план/ToDo): `high`/`medium`/`low`. */
export type WorkPriority = 'high' | 'medium' | 'low'

/** Цель перемещения пункта (тач-меню — альтернатива drag & drop). */
export interface WorkMoveTarget {
  /** id колонки/группы. */
  id: string
  /** Подпись цели (имя колонки). */
  label: string
}

/** Фильтры журнала проекта (автор/сессия/дата). */
export interface JournalFilters {
  /** Автор записи (id/роль агента). */
  author?: string
  /** Сессия, в которой создана запись. */
  sessionId?: string
  /** Дата (YYYY-MM-DD). */
  date?: string
}

/** Счётчик WIP колонки: `текущее/лимит`. */
export interface WipCounter {
  current: number
  limit: number
}
