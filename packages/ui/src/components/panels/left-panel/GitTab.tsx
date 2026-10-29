import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { useGitStore, type GitRepoView } from '@/stores/gitStore'
import { useNotification } from '@/hooks/useNotification'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'
import type { ProjectData } from '@/lib/api/synthApi'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { formatDateTime } from '@/lib/formatDate'
import { TreeNode, TreeChildren, TreeContainer } from '@/components/tree'
import { OriginBadge } from '@/components/ui/OriginBadge'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  canDeleteOccupiedPath,
  repoOccupiedAction,
  repoOccupiedDetails,
  type RepoOccupiedAction,
  type RepoOccupiedDetails,
} from '@/lib/gitOccupancy'
import type { SSHKeyMeta } from '@itphx/synth-shared'
import { CurrentProjectHeader, ScopeHint, OtherProjectsGroup } from './scope-parts'
import { useAutoScroll } from './useAutoScroll'
import { MAX_VISIBLE_COMMITS } from './constants'

// ---- Git tab ----

type AddRepoMode = 'scan' | 'clone' | 'init' | null

/** ADR-076: нормализация пути репозитория (корень workspace — `''`/`.`). */
function normRepoPath(path: string): string {
  return path === '' || path === '.' ? '' : path
}

/** Отображаемое назначение (destination) записи реестра. */
function repoDestination(path: string, rootLabel: string): string {
  return path === '' || path === '.' ? rootLabel : path
}

/** Последний сегмент относительного пути (имя репозитория по умолчанию). */
function basenameOf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || ''
}

/** ADR-076: клиентская проверка ssh-URL (зеркалит серверный `isSshUrl`). */
function isSshRepoUrl(url: string): boolean {
  const v = url.trim()
  return v.startsWith('git@') || v.startsWith('ssh://')
}

/**
 * Освобождает путь от следа прерванного клона (`occupied: 'stub'`).
 *
 * Сначала штатное удаление: `DELETE /fs` сносит файл и **пустой** каталог. След
 * клона — каталог с `.git`, то есть непустой, а рекурсивного удаления в API нет
 * (`DELETE /fs` отвечает `400 DIR_NOT_EMPTY`). Тогда путь освобождается
 * переносом в соседний `<path>.incomplete`: повторный клон возможен, а данные
 * не теряются. Возвращает путь, куда отложен каталог (`null` — удаление удалось).
 */
async function clearOccupiedPath(projectId: string, path: string): Promise<string | null> {
  try {
    await synthApi.deleteEntry(projectId, path)
    return null
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status !== 400) throw e
    const aside = `${path.replace(/\/+$/, '')}.incomplete`
    await synthApi.moveEntry(projectId, path, aside)
    return aside
  }
}

export function GitTab() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const projects = useProjectsStore(s => s.projects)
  const loadProjects = useProjectsStore(s => s.loadProjects)
  const reposByProject = useGitStore(s => s.reposByProject)
  const commitsByRepo = useGitStore(s => s.commitsByRepo)
  const expandedProjects = useGitStore(s => s.expandedProjects)
  const expandedRepos = useGitStore(s => s.expandedRepos)
  const loadRepos = useGitStore(s => s.loadRepos)
  const loadCommitLog = useGitStore(s => s.loadCommitLog)
  const toggleProjectExpand = useGitStore(s => s.toggleProjectExpand)
  const toggleRepoExpand = useGitStore(s => s.toggleRepoExpand)
  const initRepo = useGitStore(s => s.initRepo)
  const cloneRepo = useGitStore(s => s.cloneRepo)
  const scanWorkspace = useGitStore(s => s.scanWorkspace)
  const registerRepo = useGitStore(s => s.registerRepo)
  const removeRepo = useGitStore(s => s.removeRepo)
  const fetchRepo = useGitStore(s => s.fetchRepo)
  const openTab = useUIStore((s) => s.openTab)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const onlyActiveProject = useUIStore((s) => s.onlyActiveProject)
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapse = useUIStore((s) => s.toggleProjectCollapse)
  const loadSessions = useSessionsStore((s) => s.loadSessions)
  const { projectId: activeProjectId, source: activeProjectSource } = useActiveProject()
  const [commitShowMore, setCommitShowMore] = useState<Record<string, boolean>>({})
  const [addRepoProjectId, setAddRepoProjectId] = useState<string | null>(null)
  const [popoverMode, setPopoverMode] = useState<AddRepoMode>(null)
  const [scanResults, setScanResults] = useState<{ path: string; currentBranch?: string }[] | null>(null)
  const [scanSelected, setScanSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [clonePath, setClonePath] = useState('')
  const [cloneBranch, setCloneBranch] = useState('')
  const [cloneName, setCloneName] = useState('')
  const [cloneSshKeyId, setCloneSshKeyId] = useState('')
  const [initPath, setInitPath] = useState('')
  const [initBranch, setInitBranch] = useState('main')
  const [initName, setInitName] = useState('')
  const [sshKeys, setSshKeys] = useState<SSHKeyMeta[]>([])
  const [removeTarget, setRemoveTarget] = useState<{ projectId: string; repo: GitRepoView } | null>(null)
  const [deleteLocal, setDeleteLocal] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Busy-состояния: без них форма клона выглядит зависшей (сеть идёт минутами).
  const [isCloning, setIsCloning] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)
  /** Идущая операция над записью реестра: спиннер в строке + блок остальных. */
  const [busyRepo, setBusyRepo] = useState<{
    projectId: string
    path: string
    kind: 'fetch' | 'remove'
  } | null>(null)
  /** Actionable-действие по 409 «путь занят» (`details.occupied`). */
  const [occupied, setOccupied] = useState<{ action: RepoOccupiedAction; details: RepoOccupiedDetails } | null>(null)
  const projectRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Защита от двойного сабмита — на refs, а не на state: два клика до
  // перерисовки не должны отправить второй параллельный запрос.
  const cloneInFlightRef = useRef(false)
  const initInFlightRef = useRef(false)
  const busyRepoRef = useRef<{ projectId: string; path: string; kind: 'fetch' | 'remove' } | null>(null)
  // Отмена клона: закрытие поповера и кнопка «Отмена» прерывают запрос.
  const cloneAbortRef = useRef<AbortController | null>(null)
  const clonePathInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { loadProjects(); loadSessions() }, [loadProjects, loadSessions])

  useEffect(() => {
    let cancelled = false
    synthApi.listSshKeys()
      .then((keys) => { if (!cancelled) setSshKeys(keys) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const workspacedProjects = useMemo(() => projects.filter((p) => p.workspace), [projects])

  // Вариант C: текущий проект — из активного контекста (сессия/файл/коммит).
  const currentProject = useMemo(
    () => (activeProjectId ? workspacedProjects.find((p) => p.id === activeProjectId) ?? null : null),
    [workspacedProjects, activeProjectId],
  )
  const otherProjects = useMemo(
    () => workspacedProjects.filter((p) => p.id !== currentProject?.id),
    [workspacedProjects, currentProject],
  )
  const currentProjectId = currentProject?.id ?? null

  // Закреплённый текущий проект всегда раскрыт (идемпотентный expand, не toggle).
  useEffect(() => {
    if (!currentProjectId) return
    useGitStore.getState().expandProject(currentProjectId)
  }, [currentProjectId])

  useEffect(() => {
    for (const p of workspacedProjects) {
      if (!reposByProject[p.id] && p.repos) loadRepos(p.id, p.repos)
    }
  }, [workspacedProjects, reposByProject, loadRepos])

  useEffect(() => {
    expandedRepos.forEach((key) => {
      if (commitsByRepo[key]) return
      const parts = key.split('::')
      const projectId = parts[0]
      const repoPath = parts.slice(1).join('::')
      if (projectId && repoPath) {
        loadCommitLog(projectId, repoPath)
      }
    })
  }, [expandedRepos])

  const commitTabOpenSet = useMemo(() => {
    const set = new Set<string>()
    for (const tab of (centerTabs ?? [])) {
      if (tab.type === 'commit-detail' && tab.data?.projectId && tab.data?.repoPath && tab.data?.commitHash) {
        set.add(`${tab.data.projectId}::${tab.data.repoPath}::${tab.data.commitHash}`)
      }
    }
    return set
  }, [centerTabs])

  const activeCommitData = useMemo(() => {
    if (!activeCenterTabId?.startsWith('commit-')) return null
    const tab = (centerTabs ?? []).find((t) => t.id === activeCenterTabId)
    if (tab?.type === 'commit-detail' && tab.data?.projectId && tab.data?.repoPath && tab.data?.commitHash) {
      return { projectId: tab.data.projectId, repoPath: tab.data.repoPath, commitHash: tab.data.commitHash }
    }
    return null
  }, [centerTabs, activeCenterTabId])

  const scrollTarget = useMemo(() => {
    if (!activeCommitData) return null
    return `commit:${activeCommitData.commitHash}`
  }, [activeCommitData])

  useAutoScroll(scrollTarget)

  useEffect(() => {
    if (!activeCommitData) return
    const { projectId, repoPath } = activeCommitData
    const gitStore = useGitStore.getState()
    if (!gitStore.expandedProjects.has(projectId)) {
      gitStore.toggleProjectExpand(projectId)
    }
    const rkey = `${projectId}::${repoPath}`
    if (!gitStore.expandedRepos.has(rkey)) {
      gitStore.toggleRepoExpand(projectId, repoPath)
      gitStore.loadCommitLog(projectId, repoPath)
    }
    setCommitShowMore(prev => {
      if (prev[rkey]) return prev
      return { ...prev, [rkey]: true }
    })
  }, [activeCommitData])

  const openAddRepo = (projectId: string) => {
    if (addRepoProjectId === projectId) {
      closePopover()
    } else {
      // Переключение на другой проект = закрытие прежней формы: незавершённый
      // клон прерываем, иначе он продолжится без видимой формы.
      cloneAbortRef.current?.abort()
      cloneAbortRef.current = null
      setAddRepoProjectId(projectId)
      setPopoverMode('clone')
      setScanResults(null)
      setActionError(null)
      setOccupied(null)
    }
  }

  const closePopover = () => {
    // Закрытие формы прерывает незавершённый клон: иначе запрос продолжается
    // «в фоне», а пользователь уверен, что отменил операцию.
    cloneAbortRef.current?.abort()
    cloneAbortRef.current = null
    setAddRepoProjectId(null)
    setPopoverMode(null)
    setScanResults(null)
    setScanSelected(new Set())
    setScanning(false)
    setCloneUrl('')
    setClonePath('')
    setCloneBranch('')
    setCloneName('')
    setCloneSshKeyId('')
    setInitPath('')
    setInitBranch('main')
    setInitName('')
    setActionError(null)
    setOccupied(null)
  }

  // Уход компонента (смена вкладки) — тоже отмена клона, иначе запрос живёт без UI.
  useEffect(() => () => { cloneAbortRef.current?.abort() }, [])

  /** Перечитать реестр проекта после мутации: список проектов + записи gitStore. */
  const refreshRepos = useCallback(async (projectId: string) => {
    await loadProjects()
    const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
    await loadRepos(projectId, project?.repos ?? [])
  }, [loadProjects, loadRepos])

  const storeError = () => useGitStore.getState().error ?? t('common.error')

  /**
   * Показывает ошибку последней операции в форме. Если сервер различил причину
   * 409 «путь занят» (`details.occupied`), под текстом появятся actionable-кнопки.
   */
  const applyStoreError = () => {
    const last = useGitStore.getState().lastError
    setActionError(last?.message ?? storeError())
    const action = repoOccupiedAction(last?.details)
    const details = repoOccupiedDetails(last?.details)
    setOccupied(action && details ? { action, details } : null)
  }

  const sshKeyLabel = useCallback((id?: string): string | null => {
    if (!id) return null
    return sshKeys.find((k) => k.id === id)?.name ?? id
  }, [sshKeys])

  const handleDoScan = async (projectId: string) => {
    setScanning(true)
    setActionError(null)
    try {
      const repos = await scanWorkspace(projectId)
      if (!repos) {
        setActionError(storeError())
        return
      }
      const project = projects.find((p) => p.id === projectId)
      const known = new Set(
        (project?.repos ?? []).map((r) => normRepoPath(typeof r === 'string' ? r : r.path)),
      )
      setScanResults(repos.filter((r) => !known.has(normRepoPath(r.path))))
    } finally {
      setScanning(false)
    }
  }

  const handleAddScanned = async (projectId: string) => {
    if (scanSelected.size === 0) return
    const reposToAdd = scanResults?.filter((r) => scanSelected.has(r.path)) ?? []
    if (reposToAdd.length === 0) return
    setActionError(null)
    // Бэкенд регистрирует записи по одной (upsert по path) — вызываем последовательно.
    for (const repo of reposToAdd) {
      const normalized = normRepoPath(repo.path)
      const registered = await registerRepo(projectId, {
        path: normalized === '' ? '.' : repo.path,
        defaultBranch: repo.currentBranch,
      })
      if (!registered) {
        setActionError(storeError())
        return
      }
    }
    await refreshRepos(projectId)
    closePopover()
  }

  /**
   * Один прогон клонирования: индикация, `AbortController` и разбор ошибки
   * (409 «путь занят» → actionable-действия). Guard от двойного сабмита держит
   * вызывающий (`cloneInFlightRef`), чтобы он же покрывал `refreshRepos`.
   */
  const runClone = async (projectId: string) => {
    const controller = new AbortController()
    cloneAbortRef.current = controller
    setIsCloning(true)
    setActionError(null)
    setOccupied(null)
    try {
      const repo = await cloneRepo(
        projectId,
        cloneUrl.trim(),
        clonePath.trim() || undefined,
        cloneBranch.trim() || undefined,
        cloneName.trim() || undefined,
        cloneSshKeyId || undefined,
        controller.signal,
      )
      if (cloneAbortRef.current === controller) cloneAbortRef.current = null
      if (controller.signal.aborted) {
        // Отмена — не ошибка: нейтральное уведомление, форма остаётся открытой.
        notify({ text: t('git.cloneCancelled'), type: 'info', category: 'system' })
        return
      }
      if (!repo) {
        applyStoreError()
        return
      }
      await refreshRepos(projectId)
      notify({ text: t('git.cloneSuccess'), type: 'success', category: 'system' })
      closePopover()
    } finally {
      if (cloneAbortRef.current === controller) cloneAbortRef.current = null
      setIsCloning(false)
    }
  }

  const handleDoClone = async (projectId: string) => {
    // Синхронная проверка ref: повторный клик до перерисовки не должен
    // отправить второй параллельный клон.
    if (cloneInFlightRef.current) return
    if (!cloneUrl.trim()) return
    if (isSshRepoUrl(cloneUrl) && !cloneSshKeyId) {
      setActionError(t('git.ssh_key_required', { path: cloneName.trim() || clonePath.trim() || t('git.repo') }))
      return
    }
    cloneInFlightRef.current = true
    try {
      await runClone(projectId)
    } finally {
      cloneInFlightRef.current = false
    }
  }

  const handleCancelClone = () => {
    cloneAbortRef.current?.abort()
  }

  const handleDoInit = async (projectId: string) => {
    if (initInFlightRef.current) return
    initInFlightRef.current = true
    setIsInitializing(true)
    setActionError(null)
    setOccupied(null)
    try {
      const path = initPath.trim() || '.'
      const derivedName = path === '.' || path === '' ? '' : basenameOf(path)
      const repo = await initRepo(
        projectId,
        path,
        initBranch.trim() || undefined,
        initName.trim() || derivedName || undefined,
      )
      if (!repo) {
        applyStoreError()
        return
      }
      await refreshRepos(projectId)
      notify({ text: t('git.initSuccess'), type: 'success', category: 'system' })
      closePopover()
    } finally {
      initInFlightRef.current = false
      setIsInitializing(false)
    }
  }

  /** 409 `occupied: 'repo'` — зарегистрировать существующий репозиторий. */
  const handleRegisterOccupied = async (projectId: string) => {
    if (cloneInFlightRef.current || !occupied) return
    cloneInFlightRef.current = true
    setIsRegistering(true)
    setActionError(null)
    try {
      const path = occupied.details.path.trim() || clonePath.trim() || '.'
      const registered = await registerRepo(projectId, {
        path: path === '' ? '.' : path,
        url: cloneUrl.trim() || undefined,
        name: cloneName.trim() || undefined,
        type: isSshRepoUrl(cloneUrl) ? 'ssh' : 'https',
        sshKeyId: cloneSshKeyId || undefined,
      })
      if (!registered) {
        applyStoreError()
        return
      }
      await refreshRepos(projectId)
      setOccupied(null)
      notify({ text: t('git.registerOccupiedSuccess'), type: 'success', category: 'system' })
      closePopover()
    } finally {
      cloneInFlightRef.current = false
      setIsRegistering(false)
    }
  }

  /** 409 `occupied: 'stub'` — удалить след прерванного клона и повторить клон. */
  const handleDeleteOccupiedAndRetry = async (projectId: string) => {
    if (cloneInFlightRef.current || !occupied) return
    const target = occupied.details.path
    if (!canDeleteOccupiedPath(occupied.details)) return
    cloneInFlightRef.current = true
    try {
      setActionError(null)
      let aside: string | null
      try {
        aside = await clearOccupiedPath(projectId, target)
      } catch (e) {
        setActionError((e as Error).message || t('common.error'))
        setOccupied(null)
        return
      }
      if (aside) {
        // След клона — непустой каталог: удаление невозможно, он отложен в сторону.
        notify({ text: t('git.occupied.stubMoved', { path: aside }), type: 'info', category: 'system' })
      }
      setOccupied(null)
      await runClone(projectId)
    } finally {
      cloneInFlightRef.current = false
    }
  }

  /** 409 `occupied: 'dir'` — другой путь: фокус на поле, поповер не закрываем. */
  const handleChooseOtherPath = () => {
    setActionError(null)
    setOccupied(null)
    clonePathInputRef.current?.focus()
  }

  const handleRemoveRepo = async () => {
    if (!removeTarget || busyRepoRef.current) return
    const { projectId, repo } = removeTarget
    const busy = { projectId, path: repo.path, kind: 'remove' as const }
    busyRepoRef.current = busy
    setBusyRepo(busy)
    try {
      const ok = await removeRepo(projectId, {
        id: repo.id,
        path: repo.id ? undefined : repo.path || undefined,
        deleteLocal,
      })
      if (!ok) {
        notify({ text: storeError(), type: 'error', category: 'error' })
        return
      }
      await refreshRepos(projectId)
      setRemoveTarget(null)
      setDeleteLocal(false)
    } finally {
      busyRepoRef.current = null
      setBusyRepo(null)
    }
  }

  const handleFetchRepo = async (projectId: string, repo: GitRepoView) => {
    // Пока идёт любая сетевая операция над записью реестра — остальные заблокированы.
    if (busyRepoRef.current) return
    const busy = { projectId, path: repo.path, kind: 'fetch' as const }
    busyRepoRef.current = busy
    setBusyRepo(busy)
    try {
      const ok = await fetchRepo(projectId, {
        id: repo.id,
        path: repo.id ? undefined : repo.path || undefined,
      })
      if (!ok) {
        notify({ text: storeError(), type: 'error', category: 'error' })
        return
      }
      await refreshRepos(projectId)
      notify({ text: t('git.fetchSuccess'), type: 'success', category: 'system' })
    } finally {
      busyRepoRef.current = null
      setBusyRepo(null)
    }
  }

  const renderGitProject = (project: ProjectData) => {
    const repos = reposByProject[project.id] || []
    const isExpanded = expandedProjects.has(project.id)
    const isAddRepoOpen = addRepoProjectId === project.id

    return (
      <div key={project.id}>
        <Popover open={isAddRepoOpen} onOpenChange={(open) => { if (!open) closePopover() }}>
          <div ref={(el) => { projectRefs.current[project.id] = el }} className="relative">
            <PopoverTrigger asChild>
              <button className="absolute top-0 right-0 w-0 h-0 opacity-0 pointer-events-none" />
            </PopoverTrigger>
            <TreeNode
              id={`git-project:${project.id}`}
              label={project.name}
              icon={resolveIconName(project.icon) ?? 'folder-3'}
              iconColor={resolveIconColor(project.color)}
              iconSize="md"
              isExpanded={isExpanded}
              hasChildren={repos.length > 0 ? true : undefined}
              badge={<OriginBadge origin={project.origin} />}
              onToggle={() => toggleProjectExpand(project.id)}
              count={repos.length > 0 ? repos.length : undefined}
              actions={[
                { id: 'add-repo', icon: 'git-repository', title: t('git.addRepo'), onClick: () => openAddRepo(project.id) },
              ]}
            />
          </div>
          <PopoverContent side="bottom" align="end" sideOffset={4} className="w-72 p-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex w-full rounded-lg border border-sidebar-border overflow-hidden mb-3">
              {([
                { id: 'scan' as const, icon: 'git-branch' as const },
                { id: 'clone' as const, icon: 'download' as const },
                { id: 'init' as const, icon: 'add' as const },
              ]).map((mode) => (
                <button
                  key={mode.id}
                  onClick={(e) => { e.stopPropagation(); setPopoverMode(mode.id); setActionError(null); setOccupied(null) }}
                  title={t(`git.${mode.id === 'scan' ? 'scan' : mode.id === 'clone' ? 'cloneRepo' : 'initRepo'}`)}
                  className={`flex items-center justify-center px-2 py-1 text-xs transition-colors
                    border-r border-sidebar-border last:border-r-0 flex-1
                    ${popoverMode === mode.id
                      ? 'bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
                    }`}
                >
                  <Icon name={mode.icon} className="size-3.5 shrink-0" />
                </button>
              ))}
            </div>

            {popoverMode === 'scan' && (
              <div className="space-y-2">
                {!scanResults ? (
                  <button
                    onClick={() => handleDoScan(project.id)}
                    disabled={scanning}
                    className="w-full flex items-center justify-center gap-1.5 rounded bg-interactive px-3 py-2 min-h-[40px] text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
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
                      className="w-full rounded bg-primary px-3 py-2 min-h-[40px] text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {t('git.addRepo')}
                    </button>
                  </>
                )}
              </div>
            )}

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
                    data-testid="git-clone-url"
                    className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div>
                  <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.name')}</label>
                  <input
                    type="text"
                    value={cloneName}
                    onChange={(e) => setCloneName(e.target.value)}
                    placeholder={t('git.namePlaceholder')}
                    className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div>
                  <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.path')}</label>
                  <input
                    ref={clonePathInputRef}
                    type="text"
                    value={clonePath}
                    onChange={(e) => setClonePath(e.target.value)}
                    placeholder={t('git.pathHint')}
                    data-testid="git-clone-path"
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
                <div>
                  <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.sshKey')}</label>
                  <select
                    value={cloneSshKeyId}
                    onChange={(e) => setCloneSshKeyId(e.target.value)}
                    className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none"
                  >
                    <option value="">{t('git.sshKeyNone')}</option>
                    {sshKeys.map((key) => (
                      <option key={key.id} value={key.id}>{key.name}</option>
                    ))}
                  </select>
                  {isSshRepoUrl(cloneUrl) && !cloneSshKeyId && (
                    <p className="text-[0.65rem] text-status-warning mt-0.5">{t('git.sshKeyRequiredHint')}</p>
                  )}
                  {sshKeys.length === 0 && (
                    <p className="text-[0.65rem] text-muted-foreground mt-0.5">{t('git.noSshKeys')}</p>
                  )}
                </div>
                <p className="text-[0.65rem] text-muted-foreground" data-testid="git-clone-network-hint">
                  {t('git.cloneNetworkHint')}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDoClone(project.id)}
                    disabled={
                      isCloning
                      || isRegistering
                      || !cloneUrl.trim()
                      || (isSshRepoUrl(cloneUrl) && !cloneSshKeyId)
                    }
                    data-testid="git-clone-submit"
                    aria-busy={isCloning}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded bg-primary px-3 py-2 min-h-[40px] text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {isCloning && <Icon name="loader-2" className="size-3.5 shrink-0 animate-spin" />}
                    {isCloning ? t('git.cloning') : t('git.cloneRepo')}
                  </button>
                  {isCloning && (
                    <button
                      onClick={handleCancelClone}
                      data-testid="git-clone-cancel"
                      className="rounded border border-sidebar-border px-2 py-2 min-h-[40px] text-xs text-foreground hover:bg-interactive-hover transition-colors"
                    >
                      {t('git.cloneCancel')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {popoverMode === 'init' && (
              <div className="space-y-2">
                <div>
                  <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.path')}</label>
                  <input
                    type="text"
                    value={initPath}
                    onChange={(e) => setInitPath(e.target.value)}
                    placeholder={t('git.pathHint')}
                    autoFocus
                    className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div>
                  <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('git.name')}</label>
                  <input
                    type="text"
                    value={initName}
                    onChange={(e) => setInitName(e.target.value)}
                    placeholder={t('git.namePlaceholder')}
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
                  disabled={isInitializing}
                  data-testid="git-init-submit"
                  aria-busy={isInitializing}
                  className="flex w-full items-center justify-center gap-1.5 rounded bg-primary px-3 py-2 min-h-[40px] text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {isInitializing && <Icon name="loader-2" className="size-3.5 shrink-0 animate-spin" />}
                  {isInitializing ? t('git.initializing') : t('git.initRepo')}
                </button>
              </div>
            )}

            {actionError && (
              <div className="mt-2 space-y-1.5" data-testid="git-action-error">
                <p className="text-xs text-destructive">{actionError}</p>
                {occupied && occupied.action === 'register' && (
                  <button
                    onClick={() => handleRegisterOccupied(project.id)}
                    disabled={isRegistering}
                    data-testid="git-occupied-register"
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-sidebar-border px-2 py-1.5 min-h-[32px] text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
                  >
                    {isRegistering && <Icon name="loader-2" className="size-3.5 shrink-0 animate-spin" />}
                    {t('git.occupied.register')}
                  </button>
                )}
                {occupied && occupied.action === 'delete-and-retry' && canDeleteOccupiedPath(occupied.details) && (
                  <button
                    onClick={() => handleDeleteOccupiedAndRetry(project.id)}
                    disabled={isCloning}
                    data-testid="git-occupied-delete-retry"
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-sidebar-border px-2 py-1.5 min-h-[32px] text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
                  >
                    {t('git.occupied.deleteAndRetry')}
                  </button>
                )}
                {occupied && occupied.action === 'choose-path' && (
                  <button
                    onClick={handleChooseOtherPath}
                    data-testid="git-occupied-choose-path"
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-sidebar-border px-2 py-1.5 min-h-[32px] text-xs text-foreground hover:bg-interactive-hover transition-colors"
                  >
                    {t('git.occupied.choosePath')}
                  </button>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {isExpanded && (
          <TreeChildren indent totalCount={repos.length} emptyText={t('leftPanel.noRepos')}>
            {repos.length === 0 && <></>}
            {repos.map((repo) => {
              const rkey = `${project.id}::${repo.path}`
              const isRepoExpanded = expandedRepos.has(rkey)
              const commits = commitsByRepo[rkey] || []
              const destination = repoDestination(repo.path, t('git.workspaceRoot'))
              const displayName = repo.name || destination
              const keyLabel = sshKeyLabel(repo.sshKeyId)
              const busyHere = busyRepo !== null
                && busyRepo.projectId === project.id
                && busyRepo.path === repo.path

              return (
                <div key={rkey}>
                  <TreeNode
                    id={`repo:${rkey}`}
                    label={displayName}
                    labelMuted
                    icon="git-repository"
                    isExpanded={isRepoExpanded}
                    hasChildren={true}
                    onToggle={() => {
                      toggleRepoExpand(project.id, repo.path)
                      if (!isRepoExpanded) loadCommitLog(project.id, repo.path)
                    }}
                    suffix={repo.currentBranch}
                    actions={[
                      { id: 'fetch', icon: 'refresh', title: t('git.fetchRepo'), onClick: () => handleFetchRepo(project.id, repo) },
                      { id: 'remove', icon: 'delete-bin', title: t('git.remove'), variant: 'destructive', onClick: () => { if (busyRepoRef.current) return; setDeleteLocal(false); setRemoveTarget({ projectId: project.id, repo }) } },
                    ]}
                    subtitle={repo.lastCommitSubject?.slice(0, 30)}
                  />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pb-1 -mt-0.5 text-[0.65rem] text-muted-foreground">
                    {busyHere && (
                      <span
                        className="inline-flex items-center gap-1 text-foreground"
                        data-testid={`git-busy-${rkey}`}
                        aria-live="polite"
                      >
                        <Icon name="loader-2" className="size-3 shrink-0 animate-spin" />
                        {busyRepo.kind === 'fetch' ? t('git.fetching') : t('git.removing')}
                      </span>
                    )}
                    {repo.type && (
                      <span className="rounded border border-sidebar-border px-1 uppercase tracking-wide" title={t('git.type')}>
                        {repo.type}
                      </span>
                    )}
                    <span className="min-w-0 truncate" title={destination}>
                      <span className="opacity-70">{t('git.destination')}:</span>{' '}
                      <code className="font-mono text-foreground/80">{destination}</code>
                    </span>
                    {repo.url && (
                      <span className="inline-flex min-w-0 items-center gap-0.5" title={repo.url}>
                        <Icon name="link" className="size-3 shrink-0" />
                        <span className="truncate">{repo.url}</span>
                      </span>
                    )}
                    {keyLabel && (
                      <span className="inline-flex items-center gap-0.5">
                        <Icon name="shield-keyhole" className="size-3" />
                        {keyLabel}
                      </span>
                    )}
                    {repo.lastFetch && (
                      <span>{t('git.lastFetch')}: {formatDateTime(repo.lastFetch, locale)}</span>
                    )}
                  </div>
                  {isRepoExpanded && (
                    (() => {
                      const isExpanded = commitShowMore[rkey] ?? false
                      const visibleCommits = isExpanded ? commits : commits.slice(0, MAX_VISIBLE_COMMITS)
                      const hiddenCount = commits.length - MAX_VISIBLE_COMMITS
                      return (
                    <TreeChildren
                      borderOnHover
                      totalCount={commits.length}
                      maxVisible={MAX_VISIBLE_COMMITS}
                      expanded={isExpanded}
                      emptyText={t('leftPanel.noCommits')}
                      emptyIcon="git-commit"
                      showMoreLabel={t('leftPanel.showMoreCommits', { count: String(hiddenCount) })}
                      collapseLabel={t('leftPanel.showFewerCommits')}
                      onShowMore={hiddenCount > 0 ? () => setCommitShowMore(prev => ({ ...prev, [rkey]: true })) : undefined}
                      onCollapse={() => setCommitShowMore(prev => ({ ...prev, [rkey]: false }))}
                    >
                      {visibleCommits.map((commit: any) => {
                        const commitKey = `${project.id}::${repo.path}::${commit.hash}`
                        return (
                        <TreeNode
                          key={`commit:${commit.hash}`}
                          id={`commit:${commit.hash}`}
                          label={commit.subject}
                          icon="git-commit"
                          subtitle={`${commit.author} · ${commit.relativeDate}`}
                          isActive={activeCenterTabId === `commit-${project.id}-${repo.path}-${commit.hash}`}
                          isTabOpen={commitTabOpenSet.has(commitKey)}
                          onClick={() => openTab({
                            id: `commit-${project.id}-${repo.path}-${commit.hash}`,
                            type: 'commit-detail',
                            title: commit.subject,
                            data: { projectId: project.id, repoPath: repo.path, commitHash: commit.hash },
                          })}
                        />
                        )
                      })}
                    </TreeChildren>
                      )
                    })()
                  )}
                </div>
              )
            })}
          </TreeChildren>
        )}
      </div>
    )
  }

  if (!workspacedProjects.length) {
    return (
      <TreeContainer>
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm px-4 text-center">
          {t('leftPanel.empty')}
        </div>
      </TreeContainer>
    )
  }

  return (
    <>
      <TreeContainer>
      {!currentProject ? (
        <>
          {activeProjectSource === 'session' && !activeProjectId && (
            <ScopeHint text={t('leftPanel.currentProject.none')} />
          )}
          {activeProjectSource !== null && !!activeProjectId && (
            <ScopeHint text={t('leftPanel.currentProject.noWorkspace')} />
          )}
          {workspacedProjects.map(renderGitProject)}
        </>
      ) : (
        <>
          <CurrentProjectHeader label={t('leftPanel.currentProject')} />
          {renderGitProject(currentProject)}
          {!onlyActiveProject && otherProjects.length > 0 && (
            <OtherProjectsGroup
              label={t('leftPanel.otherProjects', { count: String(otherProjects.length) })}
              title={collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)
                ? t('leftPanel.otherProjects.expand')
                : t('leftPanel.otherProjects.collapse')}
              collapsed={collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)}
              onToggle={() => toggleProjectCollapse(OTHER_PROJECTS_COLLAPSE_KEY)}
            >
              {otherProjects.map(renderGitProject)}
            </OtherProjectsGroup>
          )}
        </>
      )}
      </TreeContainer>
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open) { setRemoveTarget(null); setDeleteLocal(false) } }}
        title={t('git.removeTitle')}
        message={removeTarget ? t('git.removeConfirm', { path: repoDestination(removeTarget.repo.path, t('git.workspaceRoot')) }) : undefined}
        confirmLabel={t('git.remove')}
        variant="danger"
        onConfirm={handleRemoveRepo}
      >
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer min-h-[40px]">
          <input
            type="checkbox"
            checked={deleteLocal}
            onChange={(e) => setDeleteLocal(e.target.checked)}
            className="size-4"
          />
          {t('git.deleteLocal')}
        </label>
      </ConfirmDialog>
    </>
  )
}
