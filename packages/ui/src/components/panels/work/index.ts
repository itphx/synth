// UI-фундамент «план/ToDo/журнал/инварианты» (PROP-054, волна 1).
//
// Компоненты переиспользуемые: правую панель («Проект»/«Сессия») и модальное
// рабочее окно собирает из них волна 2 (интеграция). Здесь — только сами
// компоненты и их общие типы.

export { MarkdownText } from './MarkdownText'
export type { MarkdownTextProps } from './MarkdownText'
export { MarkdownEditor, applyMarkdownAction } from './MarkdownEditor'
export type { MarkdownEditorProps, MarkdownEditorAction, MarkdownActionResult } from './MarkdownEditor'
export { TaskRow } from './TaskRow'
export type { TaskRowProps } from './TaskRow'
export { TaskGroup } from './TaskGroup'
export type { TaskGroupProps } from './TaskGroup'
export { PlanBoard } from './PlanBoard'
export type { PlanBoardProps } from './PlanBoard'
export { JournalList } from './JournalList'
export type { JournalListProps } from './JournalList'
export { InvariantsEditor } from './InvariantsEditor'
export type { InvariantsEditorProps } from './InvariantsEditor'
export { WorkStats } from './WorkStats'
export type { WorkStatsProps } from './WorkStats'
export { WorkModal } from './WorkModal'
export type { WorkModalProps, WorkTab } from './WorkModal'
export {
  TODO_STATUS_CLASSES,
  TODO_STATUS_LABEL_KEYS,
  TODO_PRIORITY_CLASSES,
  TODO_PRIORITY_LABEL_KEYS,
  WORK_PRIORITY_CLASSES,
  WORK_PRIORITY_LABEL_KEYS,
} from './labels'
export type { WorkPriority, WorkMoveTarget, JournalFilters, WipCounter } from './types'
