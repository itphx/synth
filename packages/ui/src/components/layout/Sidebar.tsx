import React from 'react'
import { ResizeHandle } from './ResizeHandle'
import { Icon } from '../icon/Icon'
import { useUIStore } from '../../stores/useUIStore'
import { useI18n } from '@/lib/i18n'

interface SidebarProps {
  side: 'left' | 'right'
  width: number
  isOpen: boolean
  children: React.ReactNode
  onWidthChange: (width: number) => void
  headerActions?: React.ReactNode
}

export const Sidebar: React.FC<SidebarProps> = ({
  side,
  width,
  isOpen,
  children,
  onWidthChange,
  headerActions,
}) => {
  const { t } = useI18n()
  const [isResizing, setIsResizing] = React.useState(false)
  const { toggleLeftPanel, toggleRightPanel } = useUIStore()
  const togglePanel = side === 'left' ? toggleLeftPanel : toggleRightPanel

  const handleResize = React.useCallback(
    (delta: number) => {
      onWidthChange(width + delta)
    },
    [width, onWidthChange]
  )

  const handleResizeStart = React.useCallback(() => {
    setIsResizing(true)
  }, [])

  const handleResizeEnd = React.useCallback(() => {
    setIsResizing(false)
  }, [])

  const tooltipHide = side === 'left' ? t('header.hideLeftPanel') : t('header.hideRightPanel')

  return (
    <aside
      className={`relative flex h-full overflow-hidden bg-sidebar ${
        isOpen && side === 'left' ? 'border-r border-sidebar-border' : ''
      }${isOpen && side === 'right' ? 'border-l border-sidebar-border' : ''}`}
      style={{
        width: isOpen ? `${width}px` : '0px',
        minWidth: isOpen ? `${width}px` : '0px',
        maxWidth: isOpen ? `${width}px` : '0px',
        transition: isResizing ? 'none' : 'width 300ms ease-in-out',
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className={`flex h-9 shrink-0 items-center gap-1 px-3 ${side === 'right' ? 'justify-end' : ''}`}>
          {side === 'left' ? (
            <>
              <button
                onClick={togglePanel}
                className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
                title={tooltipHide}
              >
                <Icon name="layout-left" className="h-5 w-5" />
              </button>
              {headerActions}
            </>
          ) : (
            <>
              {headerActions}
              <button
                onClick={togglePanel}
                className={`rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground ${side === 'right' ? 'ml-auto' : ''}`}
                title={tooltipHide}
              >
                <Icon name="layout-right" className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>

      {isOpen && (
        <ResizeHandle
          position={side === 'left' ? 'right' : 'left'}
          onResize={handleResize}
          onResizeStart={handleResizeStart}
          onResizeEnd={handleResizeEnd}
        />
      )}
    </aside>
  )
}