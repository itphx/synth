import React, { useRef } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useAdaptiveIcons } from '@/hooks/useAdaptiveIcons'
import { ProjectsTab } from './left-panel/ProjectsTab'
import { FilesTab } from './left-panel/FilesTab'
import { GitTab } from './left-panel/GitTab'
import { PipelinesTab } from './left-panel/PipelinesTab'

const LEFT_TABS = [
  { id: 'projects' as const, icon: 'folder-3' as const, labelKey: 'leftPanel.tab.projects' },
  { id: 'files' as const, icon: 'file-text' as const, labelKey: 'leftPanel.tab.files' },
  { id: 'git' as const, icon: 'git-branch' as const, labelKey: 'leftPanel.tab.git' },
  // ADR-101 (Э7): пайплайны проекта (дерево проект → пайплайн).
  { id: 'pipelines' as const, icon: 'links-line' as const, labelKey: 'leftPanel.tab.pipelines' },
]

// ---- LeftPanel ----

export const LeftPanel: React.FC = () => {
  const { t } = useI18n()
  const leftPanelTab = useUIStore(s => s.leftPanelTab)
  const setLeftPanelTab = useUIStore(s => s.setLeftPanelTab)

  const containerRef = useRef<HTMLDivElement>(null)
  const iconsOnly = useAdaptiveIcons(containerRef)

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="left-tabs flex shrink-0 px-2 py-1">
        <div data-tab-row className="flex w-full rounded-lg border border-sidebar-border overflow-hidden">
          {LEFT_TABS.map((tab) => {
            const active = leftPanelTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setLeftPanelTab(tab.id)}
                title={t(tab.labelKey)}
                data-compact
                className={`flex items-center justify-center gap-1.5 py-1.5 text-xs transition-colors
                  border-r border-sidebar-border last:border-r-0
                  flex-1
                  ${iconsOnly ? 'min-w-0 px-2' : 'min-w-[4.5rem] px-3'}
                  ${active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
                `}
              >
                <Icon name={tab.icon} className="h-4 w-4 shrink-0" />
                {!iconsOnly && <span data-tab-label className="truncate">{t(tab.labelKey)}</span>}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-col flex-1 overflow-hidden">
        {leftPanelTab === 'projects' && <ProjectsTab />}
        {leftPanelTab === 'files' && <FilesTab />}
        {leftPanelTab === 'git' && <GitTab />}
        {leftPanelTab === 'pipelines' && <PipelinesTab />}
      </div>
    </div>
  )
}
