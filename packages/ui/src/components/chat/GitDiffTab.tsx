import { useEffect, useState } from 'react'
import type { GitWorktreeDiff } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { DiffView } from './DiffView'

interface GitDiffTabProps {
  tab: CenterTab
}

/**
 * ADR-076 (этап 1): вкладка diff рабочего дерева — файл, сводный diff
 * репозитория или diff индекса. Данные — `GET /api/v2/git/diff`.
 */
export function GitDiffTab({ tab }: GitDiffTabProps) {
  const { t } = useI18n()
  const openTab = useUIStore((s) => s.openTab)
  const projectId = tab.data.projectId
  const repoPath = tab.data.repoPath ?? ''
  const gitPath = tab.data.gitPath
  const gitStaged = tab.data.gitStaged === true

  const [diff, setDiff] = useState<GitWorktreeDiff | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!projectId) {
      setLoading(false)
      setError(t('errors.notFound.route'))
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    synthApi
      .getGitDiff(projectId, repoPath, { path: gitPath, staged: gitStaged })
      .then((result) => {
        if (cancelled) return
        setDiff(result)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError((e as Error).message)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, repoPath, gitPath, gitStaged, reloadKey, t])

  const title = gitPath
    ? gitPath.split('/').pop() ?? gitPath
    : gitStaged ? t('git.changes.index') : t('git.changes.all')

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon name="arrow-left-right" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground" title={gitPath ?? title}>
          {title}
        </span>
        {gitPath && (
          <span className="truncate text-[0.6875rem] text-muted-foreground" title={gitPath}>
            {repoPath ? `${repoPath}/${gitPath}` : gitPath}
          </span>
        )}
      </div>
      {diff && (diff.additions !== undefined || diff.deletions !== undefined) && (
        <span className="flex items-center gap-2 text-[0.6875rem] font-mono">
          <span className="text-status-success">+{diff.additions ?? 0}</span>
          <span className="text-status-error">−{diff.deletions ?? 0}</span>
        </span>
      )}
      {diff?.binary && (
        <span
          className="rounded border border-sidebar-border px-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground"
          data-testid="git-diff-binary"
        >
          {t('diff.binary')}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          data-testid="git-diff-refresh"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-10"
          title={t('git.refresh')}
        >
          <Icon name={loading ? 'loader-2' : 'refresh'} className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('git.refresh')}
        </button>
        {gitPath && projectId && (
          <button
            type="button"
            onClick={() => openTab({
              id: `file-${projectId}/${repoPath ? `${repoPath}/${gitPath}` : gitPath}`,
              type: 'file-viewer',
              title: gitPath.split('/').pop() ?? gitPath,
              data: {
                projectId,
                filePath: repoPath ? `${repoPath}/${gitPath}` : gitPath,
              },
            })}
            data-testid="git-diff-open-file"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-10"
            title={t('git.changes.openFile')}
          >
            <Icon name="external-link" className="size-3.5" />
            {t('git.changes.openFile')}
          </button>
        )}
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-background" data-testid="git-diff-tab">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Icon name="loader-2" className="size-8 animate-spin" />
            <span className="text-sm">{t('common.loading')}...</span>
          </div>
        </div>
      </div>
    )
  }

  if (error || !diff) {
    return (
      <div className="flex h-full flex-col bg-background" data-testid="git-diff-tab">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Icon name="alert-triangle" className="size-8 text-status-error" />
            <span className="text-sm">{error ?? t('errors.notFound.route')}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background" data-testid="git-diff-tab">
      {header}
      <div className="flex-1 min-h-0">
        <DiffView
          diff={diff.diff}
          variant="page"
          truncated={diff.diff_truncated}
          emptyText={t('git.changes.emptyDiff')}
          testId="git-diff-content"
          truncatedTestId="git-diff-truncated"
        />
      </div>
    </div>
  )
}
