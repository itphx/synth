import { useRef, useEffect, useCallback, useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { ContextMenu } from '@/components/ui/contextMenu'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { TreeNodeBase, TreeAction, TreeStatus } from './types'

const iconSizeMap = { sm: 'h-3.5 w-3.5', md: 'h-4 w-4' } as const

const statusConfig: Record<TreeStatus, { className: string; title: string }> = {
  streaming: { className: 'bg-status-info animate-notification-blink', title: '' },
  blocked: { className: 'bg-destructive', title: '' },
  stalled: { className: 'bg-status-warning animate-notification-blink', title: '' },
  pending: { className: 'bg-muted-foreground', title: '' },
}

function ActionButton({ action, alwaysVisible }: { action: TreeAction; alwaysVisible: boolean }) {
  // Меню рендерится в портале: когда курсор уходит со строки в попап, строка
  // теряет :hover. Держим открытое меню в состоянии, чтобы триггер не пропадал
  // (иначе Radix Popper теряет якорь и попап «убегает» вверх/в угол).
  const [menuOpen, setMenuOpen] = useState(false)

  const variantClass = action.variant === 'destructive'
    ? 'hover:bg-status-error/10 hover:text-status-error'
    : action.variant === 'primary'
      ? 'bg-primary/10 text-primary hover:bg-primary/20'
      : 'bg-interactive-hover/40 text-muted-foreground hover:bg-interactive-hover hover:text-foreground'

  const visibilityClass = alwaysVisible
    ? ''
    : menuOpen
      ? 'inline-flex'
      : 'hidden group-hover:inline-flex'
  const buttonClass = cn(
    'h-4 w-4 items-center justify-center rounded transition-colors',
    visibilityClass,
    variantClass,
  )

  // Действие с пунктами меню (гибрид: «создать локально / на сервере») — кнопка
  // становится триггером контекстного меню, а не мгновенным действием.
  if (action.menuItems && action.menuItems.length > 0) {
    return (
      <ContextMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <button
            onClick={(e) => e.stopPropagation()}
            className={buttonClass}
            title={action.title}
          >
            <Icon name={action.icon} className="h-3.5 w-3.5" />
          </button>
        }
        items={action.menuItems}
        align="end"
      />
    )
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); action.onClick?.() }}
      className={buttonClass}
      title={action.title}
    >
      <Icon name={action.icon} className="h-3.5 w-3.5" />
    </button>
  )
}

export function TreeNode({
  id,
  label,
  labelMuted,
  depth: _depth = 0,

  icon,
  iconColor,
  iconSize = 'sm',

  isExpanded,
  hasChildren,
  onToggle,

  subtitle,
  count,
  suffix,
  badge,

  title,

  isActive,
  isTabOpen,
  isSelected,
  selectionMode,

  isRenaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,

  draggable,
  onDragStart,
  onDrop,
  onDragOver,

  status,
  unreadCount,

  actions,
  contextItems,

  onClick,

  className,
  rowClassName,
}: TreeNodeBase) {
  const { t } = useI18n()
  const renameRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const hasUnread = (unreadCount ?? 0) > 0

  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          renameRef.current?.focus()
          renameRef.current?.select()
        })
      })
    }
  }, [isRenaming])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onRenameCommit?.()
    if (e.key === 'Escape') onRenameCancel?.()
  }, [onRenameCommit, onRenameCancel])

  const handleRowClick = () => {
    if (isRenaming) return
    onClick?.()
  }

  const resolvedIconSize = iconSizeMap[iconSize]
  const iconClass = cn(resolvedIconSize, 'shrink-0')
  const arrowClass = cn(resolvedIconSize, 'text-muted-foreground')

  const actionButtons = actions?.filter((a) => !a.alwaysVisible) ?? []
  const alwaysVisibleButtons = actions?.filter((a) => a.alwaysVisible) ?? []
  const hasContextMenu = contextItems && contextItems.length > 0
  const hasHoverActions = actionButtons.length > 0 || hasContextMenu
  const hasSubtitle = !!subtitle
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div
      ref={rowRef}
      className={cn(
        'group flex gap-1.5 rounded px-2 py-1 text-sm cursor-pointer transition-colors hover:bg-interactive-hover',
        hasSubtitle ? 'items-start' : 'items-center',
        isSelected && 'bg-primary/15',
        isActive && !isSelected && 'bg-primary/10',
        className,
        rowClassName,
      )}
      title={title}
      draggable={draggable && !selectionMode}
      onDragStart={(e) => { if (!selectionMode) onDragStart?.(e) }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={handleRowClick}
      data-tree-node={id}
    >
      {selectionMode && (
        <Icon
          name={isSelected ? 'checkbox' : 'checkbox-blank'}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      )}

      {hasChildren !== undefined && (
        <span
          className={cn('flex items-center justify-center shrink-0', arrowClass)}
          onClick={(e) => { e.stopPropagation(); onToggle?.() }}
        >
          <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className={resolvedIconSize} />
        </span>
      )}
      {hasChildren === undefined && (
        <span className={cn('flex items-center justify-center shrink-0', arrowClass, 'invisible')}>
          <Icon name="arrow-right-s" className={resolvedIconSize} />
        </span>
      )}

      {icon && (
        <Icon
          name={icon}
          className={cn(
            iconClass,
            hasSubtitle && 'mt-0.5',
            (isActive || isTabOpen) ? 'text-primary' : 'text-muted-foreground',
            hasUnread && 'text-orange-400',
          )}
          style={iconColor ? { color: iconColor } : undefined}
        />
      )}

      <div className="flex flex-col min-w-0 flex-1">
        {isRenaming ? (
          <div className="flex items-center gap-0.5">
            <input
              ref={renameRef}
              type="text"
              value={renameValue}
              onChange={(e) => onRenameChange?.(e.target.value)}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 rounded bg-interactive px-1 py-0 text-sm text-foreground outline-none"
            />
            <button
              onClick={(e) => { e.stopPropagation(); onRenameCommit?.() }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-status-success"
              title={t('leftPanel.confirm')}
            >
              <Icon name="check" className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRenameCancel?.() }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
              title={t('leftPanel.cancel')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1 min-w-0">
              <span
                className={cn(
                  'truncate text-sm leading-tight',
                  hasUnread ? 'text-orange-400' : labelMuted ? 'text-muted-foreground' : 'text-foreground',
                )}
                title={label}
              >
                {label}
              </span>
              {badge}
            </div>
            {subtitle && (
              <span className="text-[0.65rem] text-muted-foreground leading-none truncate">
                {subtitle}
              </span>
            )}
          </>
        )}
      </div>

      {!isRenaming && suffix && (
        <span className="text-xs text-muted-foreground shrink-0 group-hover:hidden">{suffix}</span>
      )}

      {!isRenaming && count !== undefined && (
        <span className="text-xs text-muted-foreground shrink-0 group-hover:hidden">{count}</span>
      )}

      {!selectionMode && !isRenaming && hasHoverActions && (
        <div className="shrink-0 flex items-center gap-1">
          {alwaysVisibleButtons.map((action) => (
            <ActionButton key={action.id} action={action} alwaysVisible />
          ))}
          {actionButtons.map((action) => (
            <ActionButton key={action.id} action={action} alwaysVisible={false} />
          ))}
        </div>
      )}

      {!selectionMode && !isRenaming && hasContextMenu && (
        <div className={cn('shrink-0', menuOpen ? 'block' : 'hidden group-hover:block')}>
          <ContextMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={
              <button
                onClick={(e) => e.stopPropagation()}
                className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Icon name="more-2" className="h-3.5 w-3.5" />
              </button>
            }
            items={contextItems}
            align="end"
          />
        </div>
      )}

      {status && !isRenaming && (
        <span
          className={cn('ml-auto h-2 w-2 shrink-0 rounded-full', statusConfig[status].className)}
          title={statusConfig[status].title}
        />
      )}
    </div>
  )
}
