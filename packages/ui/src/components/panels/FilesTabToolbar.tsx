import React from 'react'
import { Icon } from '@/components/icon/Icon'
import { useFilesStore } from '@/stores/filesStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useI18n } from '@/lib/i18n'

export const FilesTabToolbar: React.FC = () => {
  const { t } = useI18n()
  const { projects } = useProjectsStore()
  const {
    expandedProjects, toggleProjectExpand, collapseAll,
    showHidden, toggleShowHidden,
    selectionMode, toggleSelectionMode,
  } = useFilesStore()

  const workspacedProjects = projects.filter((p) => p.workspace)
  const allCollapsed = workspacedProjects.every((p) => !expandedProjects.has(p.id))

  const handleToggleAll = () => {
    if (allCollapsed) {
      workspacedProjects.forEach((p) => {
        if (!expandedProjects.has(p.id)) toggleProjectExpand(p.id)
      })
    } else {
      collapseAll()
    }
  }

  return (
    <div className="flex items-center gap-0.5 ml-auto">
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
