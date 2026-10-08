import React, { useEffect, useRef } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useAdaptiveIcons } from '@/hooks/useAdaptiveIcons'
import { StatsTab } from './StatsTab'
import { ContextTab } from './ContextTab'
import { SessionSettingsTab } from './SessionSettingsTab'
import { ProjectTab } from './ProjectTab'
import { ReferencesTab } from './ReferencesTab'
import { SecretsTab } from './SecretsTab'
import { SchedulerTab } from './SchedulerTab'
import { PanelTab } from './PanelTab'

// AD-071: верхний ряд правой панели — «Сессия», «Проект», «Контекст», «Статистика».
export const RIGHT_TABS = [
  { id: 'params', icon: 'settings-3' as const, labelKey: 'rightPanel.tab.session' },
  { id: 'project', icon: 'folder-3' as const, labelKey: 'rightPanel.tab.project' },
  { id: 'context', icon: 'file-text' as const, labelKey: 'rightPanel.tab.context' },
  { id: 'stats', icon: 'bar-chart-2' as const, labelKey: 'rightPanel.tab.stats' },
  { id: 'references', icon: 'link' as const, labelKey: 'rightPanel.tab.references' },
  { id: 'scheduler', icon: 'calendar-schedule' as const, labelKey: 'rightPanel.tab.scheduler' },
] as const

export const RightPanel: React.FC = () => {
  const { t } = useI18n()
  const rightPanelTab = useUIStore(s => s.rightPanelTab)
  const setRightPanelTab = useUIStore(s => s.setRightPanelTab)
  const centerTabs = useUIStore(s => s.centerTabs)
  const activeCenterTabId = useUIStore(s => s.activeCenterTabId)
  const user = useAuthStore((s) => s.user)
  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)
  const sessionId = activeTab?.data?.sessionId

  // Вкладка «Безопасность» (AD-036) — только для ADMIN/AUDITOR
  const canViewSecrets = !!user?.roles?.some((r) => r === 'ADMIN' || r === 'AUDITOR')
  const tabs = canViewSecrets
    ? [...RIGHT_TABS, { id: 'secrets', icon: 'shield-keyhole' as const, labelKey: 'rightPanel.tab.secrets' }]
    : RIGHT_TABS

  // Нормализация: если вкладка secrets недоступна (роль без прав) — сбрасываем на дефолтную
  useEffect(() => {
    if (rightPanelTab === 'secrets' && !canViewSecrets) {
      setRightPanelTab('context')
    }
  }, [rightPanelTab, canViewSecrets, setRightPanelTab])

  const firstRow = tabs.slice(0, 4)
  const secondRow = tabs.slice(4)

  const containerRef = useRef<HTMLDivElement>(null)
  const iconsOnly = useAdaptiveIcons(containerRef)

  const renderTab = (tab: (typeof tabs)[number]) => {
    const active = rightPanelTab === tab.id
    return (
      <button
        key={tab.id}
        onClick={() => setRightPanelTab(tab.id)}
        title={t(tab.labelKey)}
        data-compact
        className={`flex items-center justify-center gap-1.5 py-1.5 text-xs transition-colors
          border-r border-sidebar-border last:border-r-0
          flex-1
          ${iconsOnly ? 'min-w-0 px-2' : 'min-w-[4.5rem] px-3'}
          ${active ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
        `}
      >
        <Icon name={tab.icon} className="h-4 w-4 shrink-0" />
        {!iconsOnly && <span data-tab-label className="truncate">{t(tab.labelKey)}</span>}
      </button>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="flex flex-col gap-1 shrink-0 px-2 py-1">
        <div data-tab-row className="flex w-full rounded-lg border border-sidebar-border overflow-hidden">
          {firstRow.map(renderTab)}
        </div>
        <div data-tab-row className="flex w-full rounded-lg border border-sidebar-border overflow-hidden">
          {secondRow.map(renderTab)}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {rightPanelTab === 'stats' && <StatsTab />}
        {rightPanelTab === 'params' && <SessionSettingsTab />}
        {rightPanelTab === 'project' && <ProjectTab />}
        {rightPanelTab === 'context' && <ContextTab />}
        {rightPanelTab === 'references' && sessionId && <ReferencesTab sessionId={sessionId} />}
        {rightPanelTab === 'references' && !sessionId && (
          <PanelTab>
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {t('reference.empty')}
            </div>
          </PanelTab>
        )}
        {rightPanelTab === 'secrets' && canViewSecrets && sessionId && <SecretsTab sessionId={sessionId} />}
        {rightPanelTab === 'secrets' && canViewSecrets && !sessionId && (
          <PanelTab>
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {t('reference.empty')}
            </div>
          </PanelTab>
        )}
        {rightPanelTab === 'scheduler' && <SchedulerTab />}
      </div>
    </div>
  )
}
