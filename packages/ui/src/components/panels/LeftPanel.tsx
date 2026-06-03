import React from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { ProjectsTab } from './ProjectsTab'
import { FilesTab } from './FilesTab'
import { GitTab } from './GitTab'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

const LEFT_TABS = [
  { id: 'projects', icon: 'folder-3' as const, labelKey: 'leftPanel.tab.projects' },
  { id: 'files', icon: 'file-text' as const, labelKey: 'leftPanel.tab.files' },
  { id: 'git', icon: 'git-branch' as const, labelKey: 'leftPanel.tab.git' },
] as const

export const LeftPanel: React.FC = () => {
  const { t } = useI18n()
  const { leftPanelTab, setLeftPanelTab } = useUIStore()

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-center px-2">
        <div className="inline-flex rounded-lg border border-sidebar-border overflow-hidden">
          {LEFT_TABS.map((tab) => {
            const active = leftPanelTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setLeftPanelTab(tab.id)}
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
        {leftPanelTab === 'projects' && <ProjectsTab />}
        {leftPanelTab === 'files' && <FilesTab />}
        {leftPanelTab === 'git' && <GitTab />}
      </div>
    </div>
  )
}
