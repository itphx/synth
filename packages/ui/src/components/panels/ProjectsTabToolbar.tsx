import React, { useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { CreateProjectPopover } from '@/components/panels/CreateProjectPopover'
import { SessionCreateDialog } from '@/components/panels/SessionCreateDialog'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'

export const ProjectsTabToolbar: React.FC = () => {
  const { t } = useI18n()
  const sortMode = useSessionsTreeStore(s => s.sortMode)
  const toggleSortMode = useSessionsTreeStore(s => s.toggleSortMode)
  const selectionMode = useSessionsTreeStore(s => s.selectionMode)
  const toggleSelectionMode = useSessionsTreeStore(s => s.toggleSelectionMode)
  const projects = useProjectsStore(s => s.projects)
  const collapsedProjects = useUIStore(s => s.collapsedProjects)

  const [sessionDialogOpen, setSessionDialogOpen] = useState(false)

  const handleToggleAll = () => {
    const { projects } = useProjectsStore.getState()
    const { collapsedProjects, toggleProjectCollapse } = useUIStore.getState()
    const allCollapsed = projects.every(p => collapsedProjects.has(p.id)) && collapsedProjects.has('__none__')
    for (const p of projects) {
      if (allCollapsed === collapsedProjects.has(p.id)) {
        toggleProjectCollapse(p.id)
      }
    }
    if (allCollapsed === collapsedProjects.has('__none__')) {
      toggleProjectCollapse('__none__')
    }
  }

  const allCollapsed = collapsedProjects.has('__none__') && projects.every(p => collapsedProjects.has(p.id))

  return (
    <div className="flex items-center gap-0.5 ml-auto">
      <button
        onClick={handleToggleAll}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
        title={allCollapsed ? t('leftPanel.expandAll') : t('leftPanel.collapseAll')}
      >
        <Icon name={allCollapsed ? 'arrow-down-s' : 'arrow-up-s'} className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
      <CreateProjectPopover
        trigger={
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('leftPanel.newProject')}
          >
            <Icon name="folder-add" className="h-4 w-4" />
          </button>
        }
      />

      <button
        onClick={() => setSessionDialogOpen(true)}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
        title={t('leftPanel.newSession')}
        data-testid="projects-new-session"
      >
        <Icon name="chat-new" className="h-4 w-4" />
      </button>
      <SessionCreateDialog open={sessionDialogOpen} onOpenChange={setSessionDialogOpen} />

      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
      <button
        onClick={toggleSelectionMode}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          selectionMode
            ? 'bg-interactive-hover text-primary'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        }`}
        title={selectionMode ? t('leftPanel.exitSelection') : t('leftPanel.selectSessions')}
      >
        <Icon name="checkbox-multiple" className="h-4 w-4" />
      </button>
      <button
        onClick={toggleSortMode}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          sortMode === 'name'
            ? 'bg-interactive-hover text-primary'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        }`}
        title={sortMode === 'date' ? t('leftPanel.sortByName') : t('leftPanel.sortByDate')}
      >
        <Icon name="expand-up-down" className="h-4 w-4" />
      </button>
    </div>
  )
}
