import type { ReactNode } from 'react'

/**
 * Каркас вкладки правой панели: собственный вертикальный скролл + фиксированный футер.
 * Скролл живёт во вкладке (внешний скролл RightPanel отключён) — см. packages/ui/AGENTS.md.
 */
export function PanelTab({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4" data-testid="panel-tab-body">
        {children}
      </div>
      {footer !== undefined && (
        <div className="shrink-0 border-t border-border p-3 space-y-2" data-testid="panel-tab-footer">
          {footer}
        </div>
      )}
    </div>
  )
}
