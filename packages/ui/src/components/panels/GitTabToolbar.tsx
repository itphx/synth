import { useGitStore } from '@/stores/gitStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

export function GitTabToolbar() {
  const { t } = useI18n()
  const { expandedProjects, expandedRepos, collapseAll } = useGitStore()

  const hasExpanded = expandedProjects.size > 0 || expandedRepos.size > 0

  return (
    <div className="flex items-center gap-0.5 ml-auto">
      <button
        onClick={() => {
          if (hasExpanded) {
            collapseAll()
          } else {
            document.dispatchEvent(new CustomEvent('synth:git-expand-all'))
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
