import React, { lazy, Suspense, useEffect, useRef } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useAdaptiveIcons } from '@/hooks/useAdaptiveIcons'
import { useDevice } from '@/hooks/useDevice'
import { ContextTab } from './ContextTab'
import { ReferencesTab } from './ReferencesTab'
import { SecretsTab } from './SecretsTab'
import { PanelTab } from './PanelTab'

/**
 * Тяжёлые вкладки правой панели грузятся лениво (`import()`): их код не входит
 * в entry-чанк и подтягивается при первом открытии вкладки (кэш отдаёт чанк
 * мгновенно при повторных переключениях). Лёгкие вкладки (контекст по умолчанию,
 * ссылки, секреты) остаются синхронными.
 */
const StatsTab = lazy(() => import('./StatsTab').then((m) => ({ default: m.StatsTab })))
const SessionSettingsTab = lazy(() =>
  import('./SessionSettingsTab').then((m) => ({ default: m.SessionSettingsTab })),
)
const ProjectTab = lazy(() => import('./ProjectTab').then((m) => ({ default: m.ProjectTab })))
const SchedulerTab = lazy(() => import('./SchedulerTab').then((m) => ({ default: m.SchedulerTab })))

/** Заглушка на время загрузки ленивой вкладки — спиннер в сетке панели. */
function TabLoadingFallback() {
  return (
    <PanelTab>
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Icon name="refresh" className="size-4 animate-spin" />
      </div>
    </PanelTab>
  )
}

// ADR-071: верхний ряд правой панели — «Сессия», «Проект», «Контекст», «Статистика».
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
  const setAnalyticsDialogOpen = useUIStore((s) => s.setAnalyticsDialogOpen)
  const { deviceType } = useDevice()
  const touch = deviceType !== 'desktop'
  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)
  const sessionId = activeTab?.data?.sessionId

  // Вкладка «Безопасность» (ADR-036) — только для ADMIN/AUDITOR
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
        <div className="flex items-center gap-1">
          <div data-tab-row className="flex flex-1 rounded-lg border border-sidebar-border overflow-hidden">
            {secondRow.map(renderTab)}
          </div>
          {/* PROP-102: вход в «Аналитику и отчёты» из правой панели (не вкладка). */}
          <button
            type="button"
            onClick={() => setAnalyticsDialogOpen(true)}
            title={t('analytics.title')}
            aria-label={t('analytics.title')}
            className={`flex shrink-0 items-center justify-center rounded-lg border border-sidebar-border text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground ${touch ? 'h-10 w-10' : 'h-8 w-8'}`}
          >
            <Icon name="chart-line" className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<TabLoadingFallback />}>
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
        </Suspense>
      </div>
    </div>
  )
}
