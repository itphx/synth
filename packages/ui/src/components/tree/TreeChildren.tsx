import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import type { IconName } from '@/components/icon/icons'

interface TreeChildrenProps {
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
  className?: string
}

const VIRTUAL_THRESHOLD = 100
const ITEM_HEIGHT = 28

function VirtualChildren({ children, totalCount }: { children: React.ReactNode[]; totalCount: number }) {
  const containerRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 5,
  })

  const items = virtualizer.getVirtualItems()
  const childrenArray = Array.isArray(children) ? children : [children]

  return (
    <div
      ref={containerRef}
      style={{ maxHeight: '60vh', overflow: 'auto' }}
      className="virtual-scroll-container"
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {items.map((vr) => (
          <div
            key={vr.key}
            data-index={vr.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vr.start}px)`,
            }}
          >
            {childrenArray[vr.index] ?? null}
          </div>
        ))}
      </div>
    </div>
  )
}

export function TreeChildren({
  indent = true,
  borderOnHover,
  dynamicIndent,
  maxVisible,
  totalCount,
  expanded,
  showMoreLabel,
  collapseLabel,
  onShowMore,
  onCollapse,
  emptyText,
  emptyIcon = 'folder-3',
  children,
  className,
}: TreeChildrenProps) {
  const { t } = useI18n()

  const indentClass = indent ? 'ml-[15px] border-l border-sidebar-border pl-4' : ''
  const borderClass = borderOnHover ? 'ml-[15px] border-l border-transparent hover:border-sidebar-border pl-[4px]' : ''

  if (totalCount === 0) {
    return (
      <div className={cn(indentClass, borderClass, className)}>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Icon name={emptyIcon} className="h-3 w-3 shrink-0" />
          <span>{emptyText ?? t('common.empty')}</span>
        </div>
      </div>
    )
  }

  const truncated = maxVisible !== undefined && maxVisible > 0 && totalCount > maxVisible
  const hiddenCount = truncated ? totalCount - maxVisible : 0
  const isFullyExpanded = expanded && totalCount > (maxVisible ?? 0)
  const useVirtual = expanded && totalCount >= VIRTUAL_THRESHOLD

  const paginationRowClass = cn(
    'w-full text-left rounded px-2 py-0.5 text-xs text-muted-foreground',
    'hover:text-foreground hover:bg-interactive-hover transition-colors',
  )

  const childrenArray = Array.isArray(children) ? children : [children]

  return (
    <div
      className={cn(indentClass, borderClass, className)}
      style={dynamicIndent ? { paddingLeft: `${dynamicIndent}px` } : undefined}
    >
      {useVirtual ? (
        <VirtualChildren totalCount={totalCount}>{childrenArray as React.ReactNode[]}</VirtualChildren>
      ) : (
        children
      )}

      {truncated && !expanded && hiddenCount > 0 && onShowMore && (
        <button onClick={onShowMore} className={paginationRowClass}>
          {showMoreLabel ?? t('common.showMore', { count: String(hiddenCount) })}
        </button>
      )}

      {isFullyExpanded && onCollapse && (
        <button onClick={onCollapse} className={paginationRowClass}>
          {collapseLabel ?? t('common.showFewer')}
        </button>
      )}
    </div>
  )
}
