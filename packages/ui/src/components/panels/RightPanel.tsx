import React, { useEffect } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { StatsTab } from './StatsTab'
import { ContextTab } from './ContextTab'
import { SessionSettingsTab } from './SessionSettingsTab'
import { ProjectTab } from './ProjectTab'
import { ReferencesTab } from './ReferencesTab'
import { SecretsTab } from './SecretsTab'

const RIGHT_TABS = [
  { id: 'stats', icon: 'bar-chart-2' as const, labelKey: 'rightPanel.tab.stats' },
  { id: 'params', icon: 'settings-3' as const, labelKey: 'rightPanel.tab.session' },
  { id: 'project', icon: 'folder-3' as const, labelKey: 'rightPanel.tab.project' },
  { id: 'context', icon: 'file-text' as const, labelKey: 'rightPanel.tab.context' },
  { id: 'references', icon: 'link' as const, labelKey: 'rightPanel.tab.references' },
  { id: 'scheduler', icon: 'calendar-schedule' as const, labelKey: 'rightPanel.tab.scheduler' },
] as const

export const RightPanel: React.FC = () => {
  const { t } = useI18n()
  const { rightPanelTab, setRightPanelTab, centerTabs, activeCenterTabId } = useUIStore()
  const user = useAuthStore((s) => s.user)
  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)
  const sessionId = activeTab?.data?.sessionId

  // Вкладка «Словарь обфускации» (AD-036) — только для ADMIN/AUDITOR
  const canViewSecrets = !!user?.roles?.some((r) => r === 'ADMIN' || r === 'AUDITOR')
  const tabs = canViewSecrets
    ? [...RIGHT_TABS, { id: 'secrets', icon: 'shield-keyhole' as const, labelKey: 'rightPanel.tab.secrets' }]
    : RIGHT_TABS

  // Нормализация: если вкладка secrets недоступна (роль без прав) — сбрасываем на дефолтную
  useEffect(() => {
    if (rightPanelTab === 'secrets' && !canViewSecrets) {
      setRightPanelTab('stats')
    }
  }, [rightPanelTab, canViewSecrets, setRightPanelTab])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-center px-2">
        <div className="inline-flex rounded-lg border border-sidebar-border overflow-hidden">
          {tabs.map((tab) => {
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
        {rightPanelTab === 'project' && <ProjectTab />}
        {rightPanelTab === 'context' && <ContextTab />}
        {rightPanelTab === 'references' && sessionId && <ReferencesTab sessionId={sessionId} />}
        {rightPanelTab === 'references' && !sessionId && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('reference.empty')}
          </div>
        )}
        {rightPanelTab === 'secrets' && canViewSecrets && sessionId && <SecretsTab sessionId={sessionId} />}
        {rightPanelTab === 'secrets' && canViewSecrets && !sessionId && (
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
