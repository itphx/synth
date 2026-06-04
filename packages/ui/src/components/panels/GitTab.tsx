import { useMemo, useCallback, useEffect, useState } from 'react'
import { useProjectsStore } from '@/stores/projectsStore'
import { useGitStore } from '@/stores/gitStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP } from '@/lib/projectMeta'
import { useNotification } from '@/hooks/useNotification'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { RepoStatus } from '@synth/shared'

const MAX_VISIBLE_COMMITS = 10

type AddRepoMode = 'scan' | 'clone' | 'init' | null

export function GitTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { projects, loadProjects } = useProjectsStore()
  const {
    reposByProject,
    commitsByRepo,
    error,
    expandedProjects,
    expandedRepos,
    showMoreLimits,
    loadRepos,
    loadCommitLog,
    scanWorkspace,
    initRepo,
    toggleProjectExpand,
    expandProject,
    toggleRepoExpand,
    setShowMoreLimit,
  } = useGitStore()
  const { centerTabs, activeCenterTabId, openTab } = useUIStore()

  const workspacedProjects = useMemo(
    () => projects.filter((p) => p.workspace),
    [projects],
  )

  // Popover state
  const [popoverProjectId, setPopoverProjectId] = useState<string | null>(null)
  const [popoverMode, setPopoverMode] = useState<AddRepoMode>(null)
  const [scanResults, setScanResults] = useState<RepoStatus[] | null>(null)
  const [scanSelected, setScanSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [clonePath, setClonePath] = useState('')
  const [cloneBranch, setCloneBranch] = useState('')
  const [initPath, setInitPath] = useState('')
  const [initBranch, setInitBranch] = useState('main')
  const [actionError, setActionError] = useState<string | null>(null)

  const closePopover = useCallback(() => {
    setPopoverProjectId(null)
    setPopoverMode(null)
    setScanResults(null)
    setScanSelected(new Set())
    setActionError(null)
    setCloneUrl('')
    setClonePath('')
    setCloneBranch('')
    setInitPath('')
    setInitBranch('main')
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const handleDoScan = useCallback(async (projectId: string) => {
    setScanning(true)
    setScanResults(null)
    setScanSelected(new Set())
    setActionError(null)
    try {
      const result = await synthApi.scanGitRepos(projectId)
      const existing = reposByProject[projectId] || []
      setScanResults(result.repos.filter((r) => !existing.some((x) => x.path === r.path)))
    } catch (e) {
      setActionError((e as Error).message)
      setScanResults([])
    } finally {
      setScanning(false)
    }
  }, [reposByProject])

  const handleAddScanned = useCallback((projectId: string) => {
    if (!scanResults) return
    const added = scanResults.filter((r) => scanSelected.has(r.path))
    const existing = reposByProject[projectId] || []
    void updateProjectRepos(projectId, [...existing, ...added.map((r) => ({ path: r.path }))])
    closePopover()
    notify({ text: t('git.addRepo'), type: 'success', category: 'connection' })
  }, [scanResults, scanSelected, reposByProject, closePopover, notify, t])

  const handleDoClone = useCallback(async (projectId: string) => {
    if (!cloneUrl) return
    setActionError(null)
    try {
      const repo = await synthApi.cloneGitRepo(projectId, cloneUrl, clonePath || undefined, cloneBranch || undefined)
      const existing = reposByProject[projectId] || []
      void updateProjectRepos(projectId, [...existing, { path: repo.path }])
      closePopover()
      notify({ text: t('git.cloneSuccess'), type: 'success', category: 'connection' })
    } catch (e) {
      setActionError((e as Error).message)
    }
  }, [cloneUrl, clonePath, cloneBranch, reposByProject, closePopover, notify, t])

  const handleDoInit = useCallback(async (projectId: string) => {
    setActionError(null)
    try {
      await initRepo(projectId, initPath, initBranch || undefined)
      const existing = reposByProject[projectId] || []
      void updateProjectRepos(projectId, [...existing, { path: initPath, defaultBranch: initBranch || undefined }])
      closePopover()
      notify({ text: t('git.initSuccess'), type: 'success', category: 'connection' })
    } catch (e) {
      setActionError((e as Error).message)
    }
  }, [initPath, initBranch, reposByProject, initRepo, closePopover, notify, t])

  const updateProjectRepos = useCallback(async (projectId: string, repos: { path: string; defaultBranch?: string }[]) => {
    try {
      await synthApi.updateProject(projectId, { repos })
      useGitStore.getState().loadRepos(projectId, repos)
    } catch {
      // project save error, repos added to state already
    }
  }, [])

  // Auto-load repos when projects change
  useEffect(() => {
    for (const p of workspacedProjects) {
      if (!reposByProject[p.id] && p.repos) {
        loadRepos(p.id, p.repos)
      }
    }
  }, [workspacedProjects, reposByProject, loadRepos])

  useEffect(() => {
    for (const p of workspacedProjects) {
      const repos = reposByProject[p.id]
      if (repos && repos.length > 0) {
        expandProject(p.id)
      }
    }
  }, [workspacedProjects, reposByProject, expandProject])

  useEffect(() => {
    const handler = () => {
      for (const p of workspacedProjects) {
        expandProject(p.id)
      }
    }
    document.addEventListener('synth:git-expand-all', handler)
    return () => document.removeEventListener('synth:git-expand-all', handler)
  }, [workspacedProjects, expandProject])

  const handleToggleProject = useCallback(
    (projectId: string) => {
      const repos = reposByProject[projectId]
      if (repos && repos.length > 0) {
        toggleProjectExpand(projectId)
        const isExpanded = expandedProjects.has(projectId)
        if (!isExpanded) {
          for (const repo of repos) {
            const key = `${projectId}::${repo.path}`
            if (expandedRepos.has(key)) {
              loadCommitLog(projectId, repo.path)
            }
          }
        }
      } else {
        toggleProjectExpand(projectId)
      }
    },
    [reposByProject, expandedProjects, expandedRepos, toggleProjectExpand, loadCommitLog],
  )

  const handleToggleRepo = useCallback(
    (projectId: string, repoPath: string) => {
      const key = `${projectId}::${repoPath}`
      const isExpanded = expandedRepos.has(key)
      toggleRepoExpand(projectId, repoPath)
      if (!isExpanded) {
        loadCommitLog(projectId, repoPath)
      }
    },
    [expandedRepos, toggleRepoExpand, loadCommitLog],
  )

  const handleCommitClick = useCallback(
    (projectId: string, repoPath: string, commit: { hash: string; subject: string }) => {
      const tabId = `commit-${projectId}-${repoPath}-${commit.hash}`
      openTab({
        id: tabId,
        type: 'commit-detail',
        title: commit.subject,
        data: {
          projectId,
          repoPath,
          commitHash: commit.hash,
        },
      })
    },
    [openTab],
  )

  if (!workspacedProjects.length) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm px-4 text-center">
        {t('leftPanel.empty')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-950/20 border-b border-red-950/30">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {workspacedProjects.map((project) => {
          const repos = reposByProject[project.id] || []
          const isProjectExpanded = expandedProjects.has(project.id)
          const projectColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined
          const projectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : 'folder-3'

          const isMenuOpen = popoverProjectId === project.id

          return (
            <div key={project.id} className="group/project">
              {/* Заголовок проекта */}
              <div
                onClick={() => handleToggleProject(project.id)}
                className="relative flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors hover:bg-interactive-hover rounded-md mx-1"
              >
                <span className="group-hover/project:hidden h-3.5 w-3.5 flex items-center justify-center text-muted-foreground">
                  <Icon name={isProjectExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
                </span>
                <span className="group-hover/project:inline-flex hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground">
                  <Icon name={isProjectExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
                </span>
                <Icon
                  name={projectIcon}
                  className="h-4 w-4 shrink-0"
                  style={projectColor ? { color: projectColor } : undefined}
                />
                <span className="truncate text-sm font-medium text-foreground flex-1 min-w-0" title={project.name}>
                  {project.name}
                </span>

                <span className="text-xs text-muted-foreground shrink-0 group-hover/project:hidden">
                  {repos.length > 0 ? `${repos.length}` : ''}
                </span>

                <div className={`shrink-0 flex items-center gap-0.5 bg-sidebar rounded ${isMenuOpen ? '' : 'hidden group-hover/project:flex'}`}>
                  <Popover open={isMenuOpen} onOpenChange={(open) => { if (!open) closePopover() }}>
                    <PopoverTrigger asChild>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (isMenuOpen) {
                            closePopover()
                          } else {
                            setPopoverProjectId(project.id)
                            setPopoverMode('clone')
                            setScanResults(null)
                            setActionError(null)
                          }
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                        title={t('git.addRepo')}
                      >
                        <Icon name="git-repository" className="h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="bottom"
                      align="end"
                      sideOffset={4}
                      className="w-72 p-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Mode switches — LeftPanel tab style */}
                      <div className="flex w-full rounded-lg border border-sidebar-border overflow-hidden mb-3">
                        {([
                          { id: 'scan' as const, icon: 'git-branch' as const, labelKey: 'git.scan' as const },
                          { id: 'clone' as const, icon: 'download' as const, labelKey: 'git.cloneRepo' as const },
                          { id: 'init' as const, icon: 'add' as const, labelKey: 'git.initRepo' as const },
                        ] as const).map((mode) => (
                          <button
                            key={mode.id}
                            onClick={(e) => { e.stopPropagation(); setPopoverMode(mode.id); setActionError(null) }}
                            title={t(mode.labelKey)}
                            className={`flex items-center justify-center px-2 py-1 text-xs transition-colors
                              border-r border-sidebar-border last:border-r-0
                              flex-1
                              ${popoverMode === mode.id
                                ? 'bg-primary/15 text-foreground'
                                : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
                              }`}
                          >
                            <Icon name={mode.icon} className="size-3.5 shrink-0" />
                          </button>
                        ))}
                      </div>

                    {/* Scan mode */}
                    {popoverMode === 'scan' && (
                      <div className="space-y-2">
                        {!scanResults ? (
                          <button
                            onClick={() => handleDoScan(project.id)}
                            disabled={scanning}
                            className="w-full flex items-center justify-center gap-1.5 rounded bg-interactive px-3 py-2 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
                          >
                            <Icon name={scanning ? 'loader-2' : 'git-branch'} className={`size-3.5 ${scanning ? 'animate-spin' : ''}`} />
                            {scanning ? t('common.loading') : t('git.scan')}
                          </button>
                        ) : scanResults.length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-2">{t('git.noGitRepos')}</p>
                        ) : (
                          <>
                            <p className="text-[0.65rem] text-muted-foreground">{t('git.selectToAdd')}</p>
                            <div className="max-h-40 overflow-y-auto space-y-0.5">
                              {scanResults.map((r) => (
                                <label key={r.path} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-interactive-hover cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={scanSelected.has(r.path)}
                                    onChange={() => {
                                      const next = new Set(scanSelected)
                                      if (next.has(r.path)) next.delete(r.path)
                                      else next.add(r.path)
                                      setScanSelected(next)
                                    }}
                                    className="size-3.5"
                                  />
                                  <code className="font-mono text-foreground truncate flex-1">{r.path || '.'}</code>
                                  {r.currentBranch && (
                                    <span className="text-[0.65rem] text-muted-foreground">{r.currentBranch}</span>
                                  )}
                                </label>
                              ))}
                            </div>
                            <button
                              onClick={() => handleAddScanned(project.id)}
                              disabled={scanSelected.size === 0}
                              className="w-full rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              {t('git.addRepo')}
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {/* Clone mode */}
                    {popoverMode === 'clone' && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.url')}</label>
                          <input
                            type="text"
                            value={cloneUrl}
                            onChange={(e) => setCloneUrl(e.target.value)}
                            placeholder="https://github.com/..."
                            autoFocus
                            className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                          />
                        </div>
                        <div>
                          <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.path')}</label>
                          <input
                            type="text"
                            value={clonePath}
                            onChange={(e) => setClonePath(e.target.value)}
                            placeholder={t('common.optional')}
                            className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                          />
                        </div>
                        <div>
                          <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.branch')}</label>
                          <input
                            type="text"
                            value={cloneBranch}
                            onChange={(e) => setCloneBranch(e.target.value)}
                            placeholder={t('common.optional')}
                            className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                          />
                        </div>
                        <button
                          onClick={() => handleDoClone(project.id)}
                          disabled={!cloneUrl}
                          className="w-full rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {t('git.cloneRepo')}
                        </button>
                      </div>
                    )}

                    {/* Init mode */}
                    {popoverMode === 'init' && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.path')}</label>
                          <input
                            type="text"
                            value={initPath}
                            onChange={(e) => setInitPath(e.target.value)}
                            placeholder=". (корень)"
                            autoFocus
                            className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                          />
                        </div>
                        <div>
                          <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.defaultBranch')}</label>
                          <input
                            type="text"
                            value={initBranch}
                            onChange={(e) => setInitBranch(e.target.value)}
                            placeholder={t('git.branchPlaceholder')}
                            className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                          />
                        </div>
                        <button
                          onClick={() => handleDoInit(project.id)}
                          className="w-full rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                          {t('git.initRepo')}
                        </button>
                      </div>
                    )}

                    {actionError && (
                      <p className="text-xs text-red-500 mt-2">{actionError}</p>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            </div>

              {/* Содержимое проекта */}
              {isProjectExpanded && (
                <>
                  {repos.length === 0 ? (
                    <div className="ml-9 pl-2 py-1">
                      <span className="text-xs text-muted-foreground">{t('leftPanel.noRepos')}</span>
                    </div>
                  ) : (
                    <div className="ml-5 border-l border-sidebar-border">
                      {repos.map((repo) => {
                      const repoName = repo.path || '.'
                      const rkey = `${project.id}::${repo.path}`
                      const isRepoExpanded = expandedRepos.has(rkey)
                      const commits = commitsByRepo[rkey] || []
                      const visibleLimit = showMoreLimits[rkey] || MAX_VISIBLE_COMMITS
                      const visibleCommits = commits.slice(0, visibleLimit)
                      const hiddenCount = commits.length - visibleCommits.length

                      return (
                        <div key={rkey} className="group/repo">
                          {/* Строка репозитория */}
                          <div className="flex items-center gap-0.5 px-2 py-0.5 h-7">
                            <button
                              onClick={() => handleToggleRepo(project.id, repo.path)}
                              className="flex items-center shrink-0 size-5 justify-center text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <Icon
                                name={isRepoExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                                className="size-3"
                              />
                            </button>
                            <Icon name="git-repository" className="size-3.5 shrink-0 ml-0.5 text-muted-foreground" />
                            <span className="text-sm truncate ml-1 text-muted-foreground">
                              {repoName === '.' ? t('git.workspaceRoot') : repoName}
                            </span>

                            {repo.currentBranch && (
                              <span className="text-[0.65rem] text-muted-foreground ml-1.5 font-mono bg-interactive rounded px-1 py-px group-hover/repo:hidden">
                                {repo.currentBranch}
                              </span>
                            )}

                            <div className="hidden group-hover/repo:flex items-center gap-0.5 ml-auto">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  loadCommitLog(project.id, repo.path)
                                }}
                                className="flex items-center justify-center size-5 rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors"
                                title={t('git.refresh')}
                              >
                                <Icon name="loader-2" className="size-3" />
                              </button>
                            </div>

                            <span className="text-[0.65rem] text-muted-foreground ml-2 group-hover/repo:hidden">
                              {repo.lastCommitSubject ? repo.lastCommitSubject.slice(0, 30) : ''}
                            </span>
                          </div>

                          {/* Коммиты */}
                          {isRepoExpanded && (
                            <div className="ml-5 border-l border-sidebar-border">
                              {commits.length === 0 ? (
                                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                                  <Icon name="git-commit" className="size-3" />
                                  <span>{t('leftPanel.noCommits')}</span>
                                </div>
                              ) : (
                                <>
                                  {visibleCommits.map((commit) => {
                                    const isActive = activeCenterTabId === `commit-${project.id}-${repo.path}-${commit.hash}`
                                    return (
                                      <Tooltip key={commit.hash}>
                                        <TooltipTrigger asChild>
                                          <div
                                            onClick={() => handleCommitClick(project.id, repo.path, commit)}
                                            className={`flex items-start gap-1.5 px-2 py-1 cursor-pointer transition-colors border-l-2 border-transparent
                                              ${isActive ? 'bg-primary/10 border-primary' : 'hover:bg-interactive-hover'}
                                            `}
                                          >
                                            <Icon name="git-commit" className="size-3 shrink-0 mt-0.5 text-muted-foreground" />
                                            <div className="flex-1 min-w-0">
                                              <div className="text-sm text-foreground truncate leading-tight">
                                                {commit.subject}
                                              </div>
                                              <div className="text-[0.65rem] text-muted-foreground truncate mt-0.5">
                                                {commit.author}
                                                {' · '}
                                                {commit.relativeDate}
                                              </div>
                                            </div>
                                          </div>
                                        </TooltipTrigger>
                                        <TooltipContent side="right" sideOffset={8} className="max-w-sm">
                                          <div className="text-xs space-y-1">
                                            <div className="font-medium text-foreground">{commit.subject}</div>
                                            {commit.message !== commit.subject && (
                                              <div className="text-muted-foreground whitespace-pre-wrap text-[0.65rem] leading-relaxed">
                                                {commit.message}
                                              </div>
                                            )}
                                            <div className="text-[0.65rem] text-muted-foreground space-y-0.5 pt-0.5 border-t border-border">
                                              <div>{commit.author} · {commit.date}</div>
                                              <div>Ветка: {commit.branch}</div>
                                              <div className="font-mono">{commit.hash}</div>
                                            </div>
                                          </div>
                                        </TooltipContent>
                                      </Tooltip>
                                    )
                                  })}
                                  {hiddenCount > 0 && (
                                    <div
                                      onClick={() => setShowMoreLimit(rkey, visibleLimit + MAX_VISIBLE_COMMITS)}
                                      className="flex items-center gap-1.5 px-2 py-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors ml-5"
                                    >
                                      <Icon name="more-2" className="size-3" />
                                      <span>{t('leftPanel.showMoreCommits', { count: String(hiddenCount) })}</span>
                                    </div>
                                  )}
                                  {visibleLimit > MAX_VISIBLE_COMMITS && (
                                    <div
                                      onClick={() => setShowMoreLimit(rkey, MAX_VISIBLE_COMMITS)}
                                      className="flex items-center gap-1.5 px-2 py-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors ml-5"
                                    >
                                      <Icon name="arrow-up-s" className="size-3" />
                                      <span>{t('leftPanel.showFewerCommits')}</span>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                </div>
              )}
              </>
              )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
