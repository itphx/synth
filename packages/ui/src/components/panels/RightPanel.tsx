import React from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { StatsTab } from './StatsTab'
import { ContextTab } from './ContextTab'
import { SessionSettingsTab } from './SessionSettingsTab'
import { ReferencesTab } from './ReferencesTab'

const RIGHT_TABS = [
  { id: 'stats', icon: 'bar-chart-2' as const, labelKey: 'rightPanel.tab.stats' },
  { id: 'params', icon: 'settings-3' as const, labelKey: 'rightPanel.tab.params' },
  { id: 'context', icon: 'file-text' as const, labelKey: 'rightPanel.tab.context' },
  { id: 'references', icon: 'link' as const, labelKey: 'rightPanel.tab.references' },
  { id: 'scheduler', icon: 'calendar-schedule' as const, labelKey: 'rightPanel.tab.scheduler' },
] as const

export const RightPanel: React.FC = () => {
  const { t } = useI18n()
  const { rightPanelTab, setRightPanelTab, centerTabs, activeCenterTabId } = useUIStore()
  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)
  const sessionId = activeTab?.data?.sessionId

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-center px-2">
        <div className="inline-flex rounded-lg border border-sidebar-border overflow-hidden">
          {RIGHT_TABS.map((tab) => {
            const active = rightPanelTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setRightPanelTab(tab.id)}
                title={t(tab.labelKey)}
                className={`flex items-center justify-center gap-1.5 px-3 py-1 text-xs transition-colors
                  border-r border-sidebar-border last:border-r-0
                  flex-1 min-w-0 max-w-[150px]
                  ${active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
                `}
              >
                <Icon name={tab.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t(tab.labelKey)}</span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rightPanelTab === 'stats' && <StatsTab />}
        {rightPanelTab === 'params' && <SessionSettingsTab />}
        {rightPanelTab === 'context' && <ContextTab />}
        {rightPanelTab === 'references' && sessionId && <ReferencesTab sessionId={sessionId} />}
        {rightPanelTab === 'references' && !sessionId && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('reference.empty')}
          </div>
        )}
        {rightPanelTab === 'scheduler' && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('rightPanel.scheduler.placeholder')}
          </div>
        )}
      </div>
    </div>
  )
}
