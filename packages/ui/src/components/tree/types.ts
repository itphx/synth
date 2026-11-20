import type { IconName } from '@/components/icon/icons'
import type { ContextMenuItem } from '@/components/ui/contextMenu'
import type { SessionLabelTone } from '@/lib/sessionBadgeState'
import type { GitFileStatusKind } from '@itphx/synth-shared/types'

export type ContextMenuEntry = ContextMenuItem | 'separator'

/**
 * Статус узла дерева (точка-индикатор в правом конце строки).
 *
 * - `busy-live` — работа идёт и подтверждена живым ходом; точка мигает;
 * - `busy` — сервер сообщает о работе, живого подтверждения нет: точка
 *   информационная, **без** анимации;
 * - `attention` — работа стоит и ждёт «Продолжить» (статичная);
 * - `streaming` — legacy-алиас `busy-live` (внешние вызовы дерева);
 * - `blocked` — сессия заблокирована;
 * - `stalled` — legacy-алиас мигающей «очередь зависла»; модель бейджа его
 *   больше не отдаёт (`attention` вместо него);
 * - `pending` — в очереди есть сообщения;
 * - `approval` — ждёт подтверждения прав (запрос `permission.asked`).
 *
 * Правило мигания: анимируются только `busy-live` (есть живое подтверждение),
 * `approval` (нужен человек) и legacy-алиасы. «Работа стоит» и «сервер говорит
 * busy» — статичные: иначе индикатор мигает бесконечно (репорт владельца).
 */
export type TreeStatus =
  | 'busy-live'
  | 'busy'
  | 'attention'
  | 'streaming'
  | 'blocked'
  | 'stalled'
  | 'pending'
  | 'approval'

export interface TreeAction {
  id: string
  icon: IconName
  title: string
  /** Мгновенное действие по клику (используется, если menuItems не задан). */
  onClick?: () => void
  /** Альтернатива onClick: кнопка раскрывает меню с пунктами (например, «создать локально/на сервере»). */
  menuItems?: ContextMenuItem[]
  variant?: 'default' | 'primary' | 'destructive'
  alwaysVisible?: boolean
}

export interface TreeNodeBase {
  id: string
  label: string
  labelMuted?: boolean
  depth?: number

  icon?: IconName
  iconColor?: string
  iconSize?: 'sm' | 'md'

  isExpanded?: boolean
  hasChildren?: boolean
  onToggle?: () => void

  subtitle?: string
  count?: number
  suffix?: string
  /** Компактный бейдж рядом с label (например, OriginBadge для удалённых сущностей). */
  badge?: React.ReactNode
  /** Тултип на строке узла (например, «недоступен» для remote-сущностей при offline). */
  title?: string

  isActive?: boolean
  isTabOpen?: boolean
  isSelected?: boolean
  selectionMode?: boolean

  isRenaming?: boolean
  renameValue?: string
  onRenameStart?: () => void
  onRenameChange?: (v: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void

  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void

  status?: TreeStatus
  /**
   * Непрочитанные уведомления сессии.
   *
   * Цвет названия/иконки он больше **не** задаёт: тон берётся из модели
   * `sessionBadgeState` (`labelTone`, ADR-118 §1), а непрочитанное копится
   * только у событий «требуется действие» (`notifyMessage` в
   * `hooks/useNotification.tsx`) — так же, как в самой модели. Поле остаётся
   * источником счётчика для потребителей узла.
   */
  unreadCount?: number
  /**
   * Тон названия сессии из модели `sessionBadgeState` (ADR-118 §1).
   *
   * `neutral` — прежнее поведение (VCS/мутность/обычный текст); `caution` —
   * требуется действие или работа стоит; `error` — критическая ошибка
   * последнего хода; `success` — работа завершена. Значение не вычисляется в
   * дереве: единственный источник — чистая модель, иначе правила расходятся.
   */
  labelTone?: SessionLabelTone
  /**
   * Ключ локализации подписи названия — `ariaKey` из модели (пустая строка —
   * подписи нет). Нужен тонам **без точки** (`error`/`success`): у них нет
   * визуального дубля, и подпись (`title`) вешается на сам текст названия,
   * чтобы смысл не был только в цвете.
   */
  labelAriaKey?: string

  /**
   * ADR-076 (этап 1): вид изменения файла в рабочем дереве. Даёт точку перед
   * названием и цвет названия; иконка открытого файла остаётся акцентной.
   */
  vcsStatus?: GitFileStatusKind

  actions?: TreeAction[]
  contextItems?: ContextMenuEntry[]

  onClick?: () => void

  className?: string
  rowClassName?: string
}

export interface TreeChildrenProps {
  indent?: boolean
  borderOnHover?: boolean
  dynamicIndent?: number
  maxVisible?: number
  totalCount: number
  expanded?: boolean
  showMoreLabel?: string
  collapseLabel?: string
  onShowMore?: () => void
  onCollapse?: () => void
  emptyText?: string
  emptyIcon?: IconName
  children: React.ReactNode
}
