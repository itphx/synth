import React, { lazy, Suspense, useEffect, useRef } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useAdaptiveIcons } from '@/hooks/useAdaptiveIcons'
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
const MemoryTab = lazy(() => import('./MemoryTab').then((m) => ({ default: m.MemoryTab })))
const SessionSettingsTab = lazy(() =>
  import('./SessionSettingsTab').then((m) => ({ default: m.SessionSettingsTab })),
)
const ProjectTab = lazy(() => import('./ProjectTab').then((m) => ({ default: m.ProjectTab })))
const AutomationTab = lazy(
  () => import('./automation/AutomationTab').then((m) => ({ default: m.AutomationTab })),
)
const ProcessesTab = lazy(() => import('./ProcessesTab').then((m) => ({ default: m.ProcessesTab })))

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
  { id: 'memory', icon: 'brain' as const, labelKey: 'rightPanel.tab.memory' },
  { id: 'references', icon: 'link' as const, labelKey: 'rightPanel.tab.references' },
  // PROP-141 (этап 7b): «Автоматизация» — расписания, таймеры и будильники.
  { id: 'automation', icon: 'calendar-schedule' as const, labelKey: 'rightPanel.tab.automation' },
  // PROP-096/097: единый реестр фоновых процессов и фоновых саб-агентов.
  { id: 'processes', icon: 'terminal-box' as const, labelKey: 'rightPanel.tab.processes' },
] as const

/**
 * Сессионные вкладки правой панели — те, что живут в контексте сессии.
 *
 * В режиме выделенного проекта (`selectedProjectId`) сессии нет: вкладки
 * остаются в списке, но становятся недоступны («Нужна сессия»). Проектные
 * вкладки («Проект», «Автоматизация», «Процессы») доступны всегда.
 */
const SESSION_SCOPED_TABS = new Set<string>([
  'params',
  'context',
  'stats',
  'memory',
  'references',
  'secrets',
])

export const RightPanel: React.FC = () => {
  const { t } = useI18n()
  const rightPanelTab = useUIStore(s => s.rightPanelTab)
  const setRightPanelTab = useUIStore(s => s.setRightPanelTab)
  const centerTabs = useUIStore(s => s.centerTabs)
  const activeCenterTabId = useUIStore(s => s.activeCenterTabId)
  const selectedProjectId = useUIStore(s => s.selectedProjectId)
  const user = useAuthStore((s) => s.user)
  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)
  const sessionId = activeTab?.data?.sessionId

  // Вкладка «Безопасность» (ADR-036) — только для ADMIN/AUDITOR
  const canViewSecrets = !!user?.roles?.some((r) => r === 'ADMIN' || r === 'AUDITOR')
  const tabs = canViewSecrets
    ? [...RIGHT_TABS, { id: 'secrets', icon: 'shield-keyhole' as const, labelKey: 'rightPanel.tab.secrets' }]
    : RIGHT_TABS

  // Режим выделенного проекта: сессии нет — сессионные вкладки недоступны.
  const projectScope = !!selectedProjectId

  // Нормализация: если вкладка secrets недоступна (роль без прав) — сбрасываем на дефолтную
  useEffect(() => {
    if (rightPanelTab === 'secrets' && !canViewSecrets) {
      setRightPanelTab('context')
    }
  }, [rightPanelTab, canViewSecrets, setRightPanelTab])

  // Нормализация: активная сессионная вкладка в режиме выделенного проекта
  // недоступна — переключаем на проектную.
  useEffect(() => {
    if (!projectScope) return
    if (SESSION_SCOPED_TABS.has(rightPanelTab)) {
      setRightPanelTab('project')
    }
  }, [projectScope, rightPanelTab, setRightPanelTab])

  const firstRow = tabs.slice(0, 4)
  const secondRow = tabs.slice(4)

  const containerRef = useRef<HTMLDivElement>(null)
  const iconsOnly = useAdaptiveIcons(containerRef)

  const renderTab = (tab: (typeof tabs)[number]) => {
    const active = rightPanelTab === tab.id
    const disabled = projectScope && SESSION_SCOPED_TABS.has(tab.id)
    return (
      <button
        key={tab.id}
        onClick={() => { if (disabled) return; setRightPanelTab(tab.id) }}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        title={disabled ? t('rightPanel.tab.requiresSession') : t(tab.labelKey)}
        data-compact
        data-tab-id={tab.id}
        className={`flex items-center justify-center gap-1.5 py-1.5 text-xs transition-colors
          border-r border-sidebar-border last:border-r-0
          flex-1
          ${iconsOnly ? 'min-w-0 px-2' : 'min-w-[4.5rem] px-3'}
          ${active ? 'bg-card text-foreground' : disabled ? 'text-muted-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
          ${disabled ? 'cursor-default opacity-50' : ''}
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
        <Suspense fallback={<TabLoadingFallback />}>
          {rightPanelTab === 'stats' && <StatsTab />}
          {rightPanelTab === 'memory' && <MemoryTab />}
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
          {rightPanelTab === 'automation' && <AutomationTab />}
          {rightPanelTab === 'processes' && <ProcessesTab />}
        </Suspense>
      </div>
    </div>
  )
}
