import React from 'react'
import { Icon } from '@/components/icon/Icon'
import { useUIStore } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { useI18n } from '@/lib/i18n'

/**
 * Тумблер «Только текущий проект / Все проекты» в тулбарах Files/Git (вариант C).
 * Persist — через useUIStore.onlyActiveProject. Disabled, если нет валидного
 * текущего проекта (с workspace) — тогда вкладка работает как плоский список.
 */
export const ProjectScopeToggle: React.FC = () => {
  const { t } = useI18n()
  const onlyActiveProject = useUIStore((s) => s.onlyActiveProject)
  const setOnlyActiveProject = useUIStore((s) => s.setOnlyActiveProject)
  const projects = useProjectsStore((s) => s.projects)
  const { projectId } = useActiveProject()

  const valid = !!projectId && projects.some((p) => p.id === projectId && !!p.workspace)
  const title = !valid
    ? t('leftPanel.projectScope.noContextHint')
    : onlyActiveProject
      ? t('leftPanel.projectScope.all')
      : t('leftPanel.projectScope.onlyCurrent')

  return (
    <>
      <button
        type="button"
        data-project-scope-toggle
        onClick={() => setOnlyActiveProject(!onlyActiveProject)}
        disabled={!valid}
        aria-pressed={onlyActiveProject}
        title={title}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          onlyActiveProject
            ? 'bg-interactive-hover text-primary'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        } disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground`}
      >
        <Icon name={onlyActiveProject ? 'pushpin' : 'folder-open'} className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
    </>
  )
}
