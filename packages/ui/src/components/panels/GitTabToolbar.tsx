import { useGitStore } from '@/stores/gitStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { ProjectScopeToggle } from '@/components/panels/ProjectScopeToggle'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

export function GitTabToolbar() {
  const { t } = useI18n()
  const projects = useProjectsStore(s => s.projects)
  const expandedProjects = useGitStore(s => s.expandedProjects)
  const expandedRepos = useGitStore(s => s.expandedRepos)
  const toggleProjectExpand = useGitStore(s => s.toggleProjectExpand)
  const toggleRepoExpand = useGitStore(s => s.toggleRepoExpand)
  const expandAll = useGitStore(s => s.expandAll)
  const collapseAll = useGitStore(s => s.collapseAll)
  const onlyActiveProject = useUIStore(s => s.onlyActiveProject)
  const { projectId: activeProjectId } = useActiveProject()

  const workspacedProjects = projects.filter((p) => p.workspace)
  // При включённом «только текущий» collapse-all работает лишь по видимым проектам.
  const visibleProjects = onlyActiveProject && activeProjectId
    ? workspacedProjects.filter((p) => p.id === activeProjectId)
    : workspacedProjects
  const visibleIds = new Set(visibleProjects.map((p) => p.id))
  const hasExpanded =
    visibleProjects.some((p) => expandedProjects.has(p.id)) ||
    [...expandedRepos].some((k) => visibleIds.has(k.split('::')[0]))

  const handleExpand = () => {
    expandAll(visibleProjects.map((p) => p.id))
  }

  const handleCollapse = () => {
    if (!onlyActiveProject || !activeProjectId) {
      collapseAll()
      return
    }
    for (const p of visibleProjects) {
      if (expandedProjects.has(p.id)) toggleProjectExpand(p.id)
    }
    for (const key of [...expandedRepos]) {
      const [pid, ...rest] = key.split('::')
      if (pid && visibleIds.has(pid)) toggleRepoExpand(pid, rest.join('::'))
    }
  }

  return (
    <div className="flex items-center gap-0.5 ml-auto">
      <ProjectScopeToggle />
      <button
        onClick={() => {
          if (hasExpanded) {
            handleCollapse()
          } else {
            handleExpand()
          }
        }}
        className={`flex items-center justify-center size-6 rounded transition-colors
          ${hasExpanded
            ? 'bg-interactive-hover text-primary'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
          }`}
        title={t(hasExpanded ? 'leftPanel.collapseAll' : 'leftPanel.expandAll')}
      >
        <Icon name={hasExpanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
      </button>
    </div>
  )
}
