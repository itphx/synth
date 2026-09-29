import React from 'react'
import { Icon } from '@/components/icon/Icon'
import { useFilesStore } from '@/stores/filesStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { ProjectScopeToggle } from '@/components/panels/ProjectScopeToggle'
import { useI18n } from '@/lib/i18n'

export const FilesTabToolbar: React.FC = () => {
  const { t } = useI18n()
  const projects = useProjectsStore(s => s.projects)
  const expandedProjects = useFilesStore(s => s.expandedProjects)
  const toggleProjectExpand = useFilesStore(s => s.toggleProjectExpand)
  const showHidden = useFilesStore(s => s.showHidden)
  const toggleShowHidden = useFilesStore(s => s.toggleShowHidden)
  const selectionMode = useFilesStore(s => s.selectionMode)
  const toggleSelectionMode = useFilesStore(s => s.toggleSelectionMode)
  const onlyActiveProject = useUIStore(s => s.onlyActiveProject)
  const { projectId: activeProjectId } = useActiveProject()

  const workspacedProjects = projects.filter((p) => p.workspace)
  // При включённом «только текущий» expand/collapse-all работают лишь по видимым проектам.
  const visibleProjects = onlyActiveProject && activeProjectId
    ? workspacedProjects.filter((p) => p.id === activeProjectId)
    : workspacedProjects
  const allCollapsed = visibleProjects.every((p) => !expandedProjects.has(p.id))

  const handleToggleAll = () => {
    if (allCollapsed) {
      visibleProjects.forEach((p) => {
        if (!expandedProjects.has(p.id)) toggleProjectExpand(p.id)
      })
    } else {
      visibleProjects.forEach((p) => {
        if (expandedProjects.has(p.id)) toggleProjectExpand(p.id)
      })
    }
  }

  return (
    <div className="flex items-center gap-0.5 ml-auto">
      <ProjectScopeToggle />
      <button
        onClick={handleToggleAll}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors"
        title={allCollapsed ? t('leftPanel.expandAll') : t('leftPanel.collapseAll')}
      >
        <Icon name={allCollapsed ? 'arrow-down-s' : 'arrow-up-s'} className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
      <button
        onClick={toggleShowHidden}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          showHidden ? 'bg-interactive-hover text-primary' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        }`}
        title={t('files.toolbar.showHidden')}
      >
        <Icon name={showHidden ? 'eye' : 'eye-off'} className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
      <button
        onClick={toggleSelectionMode}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          selectionMode ? 'bg-interactive-hover text-primary' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        }`}
        title={selectionMode ? t('files.toolbar.exitSelection') : t('files.toolbar.selectionMode')}
      >
        <Icon name="checkbox-multiple" className="h-4 w-4" />
      </button>
    </div>
  )
}
