import React, { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface MobileDrawerProps {
  side: 'left' | 'right'
  open: boolean
  onClose: () => void
  children: React.ReactNode
  headerActions?: React.ReactNode
}

/**
 * Оверлей-дровер для phone/tablet зоны. Содержимое панели (LeftPanel/RightPanel)
 * переиспользуется как есть; дровер добавляет фиксированную обёртку с backdrop,
 * slide-in по стороне, закрытием по Esc/клику на backdrop.
 */
export const MobileDrawer: React.FC<MobileDrawerProps> = ({
  side,
  open,
  onClose,
  children,
  headerActions,
}) => {
  const { t } = useI18n()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const hideLabel = side === 'left' ? t('header.hideLeftPanel') : t('header.hideRightPanel')

  return (
    <div
      className={cn(
        'mobile-drawer-root',
        side === 'left' ? 'mobile-drawer-left' : 'mobile-drawer-right',
        open && 'mobile-drawer-open'
      )}
      inert={!open}
    >
      <div className="mobile-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="mobile-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={hideLabel}
      >
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 border-b border-sidebar-border px-2 pt-safe',
            side === 'right' && 'justify-end'
          )}
        >
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={hideLabel}
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
          {side === 'left' && headerActions}
        </div>
        <div className="flex flex-1 overflow-hidden pb-safe">{children}</div>
      </aside>
    </div>
  )
}
