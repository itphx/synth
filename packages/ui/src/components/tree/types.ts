import type { IconName } from '@/components/icon/icons'
import type { ContextMenuItem } from '@/components/ui/contextMenu'

export type ContextMenuEntry = ContextMenuItem | 'separator'

export type TreeStatus = 'streaming' | 'blocked' | 'stalled' | 'pending'

export interface TreeAction {
  id: string
  icon: IconName
  title: string
  onClick: () => void
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
  unreadCount?: number

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
