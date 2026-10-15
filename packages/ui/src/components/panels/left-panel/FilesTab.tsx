import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { useFilesStore } from '@/stores/filesStore'
import { useNotification } from '@/hooks/useNotification'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useDevice } from '@/hooks/useDevice'
import { synthApi } from '@/lib/api/synthApi'
import type { ProjectData } from '@/lib/api/synthApi'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { TreeNode, TreeChildren, TreeContainer } from '@/components/tree'
import type { TreeNodeBase, TreeAction } from '@/components/tree'
import { OriginBadge } from '@/components/ui/OriginBadge'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { CurrentProjectHeader, ScopeHint, OtherProjectsGroup } from './scope-parts'
import { useAutoScroll } from './useAutoScroll'
import type { ConfirmAction } from './types'

// ---- Files tab ----

export function FilesTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const projects = useProjectsStore(s => s.projects)
  const loadProjects = useProjectsStore(s => s.loadProjects)
  const { isTouch } = useDevice()
  const treesByProject = useFilesStore(s => s.treesByProject)
  const loadFileTree = useFilesStore(s => s.loadFileTree)
  const loadSubDirectory = useFilesStore(s => s.loadSubDirectory)
  const expandedProjects = useFilesStore(s => s.expandedProjects)
  const expandedDirs = useFilesStore(s => s.expandedDirs)
  const toggleProjectExpand = useFilesStore(s => s.toggleProjectExpand)
  const toggleDirExpand = useFilesStore(s => s.toggleDirExpand)
  const createFile = useFilesStore(s => s.createFile)
  const createDirectory = useFilesStore(s => s.createDirectory)
  const moveEntry = useFilesStore(s => s.moveEntry)
  const deleteEntry = useFilesStore(s => s.deleteEntry)
  const uploadFile = useFilesStore(s => s.uploadFile)
  const openTab = useUIStore((s) => s.openTab)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const onlyActiveProject = useUIStore((s) => s.onlyActiveProject)
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapse = useUIStore((s) => s.toggleProjectCollapse)
  const loadSessions = useSessionsStore((s) => s.loadSessions)
  const { projectId: activeProjectId, source: activeProjectSource } = useActiveProject()
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [renamingEntry, setRenamingEntry] = useState<any>(null)
  const [popover, setPopover] = useState<{ type: 'newFolder' | 'newFile'; projectId: string; parentPath: string } | null>(null)
  const [popoverName, setPopoverName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [activeUploadProject, setActiveUploadProject] = useState<string | null>(null)
  const [activeUploadPath, setActiveUploadPath] = useState<string>('')
  const [moveTarget, setMoveTarget] = useState<{ projectId: string; entry: any } | null>(null)
  const [moveDest, setMoveDest] = useState<string>('')
  // Каталоги для диалога переноса: рекурсивный листинг workspace (maxDepth 10).
  const [moveDirs, setMoveDirs] = useState<string[]>([])
  const [moveDirsLoading, setMoveDirsLoading] = useState(false)
  const [moveDirsFailed, setMoveDirsFailed] = useState(false)
  const moveDirsCacheRef = useRef<Map<string, string[]>>(new Map())
  const moveLoadProjectRef = useRef<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const pendingDeleteRef = useRef<Set<string>>(new Set())
  const [dragState, setDragState] = useState<{ projectId: string; path: string } | null>(null)

  useEffect(() => { loadProjects(); loadSessions() }, [loadProjects, loadSessions])

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
    useFilesStore.getState().expandProject(currentProjectId)
  }, [currentProjectId])


  /**
   * Рекурсивный листинг каталогов workspace для диалога переноса (maxDepth 10,
   * относительные пути). Кэш на время сессии: повторное открытие проекта
   * показывает список сразу и перепроверяет его в фоне.
   */
  const loadMoveDirs = useCallback(async (projectId: string) => {
    moveLoadProjectRef.current = projectId
    const cached = moveDirsCacheRef.current.get(projectId)
    if (cached) {
      setMoveDirs(cached)
      setMoveDirsFailed(false)
      setMoveDirsLoading(false)
    } else {
      setMoveDirs([])
      setMoveDirsFailed(false)
      setMoveDirsLoading(true)
    }
    try {
      const { showHidden } = useFilesStore.getState()
      const result = await synthApi.listDirectory(projectId, '', showHidden, 10)
      const dirs = result.entries
        .filter((e) => e.isDirectory)
        .map((e) => e.path)
        .sort((a, b) => a.localeCompare(b))
      moveDirsCacheRef.current.set(projectId, dirs)
      if (moveLoadProjectRef.current !== projectId) return
      setMoveDirs(dirs)
      setMoveDirsFailed(false)
    } catch {
      if (moveLoadProjectRef.current !== projectId) return
      // Запрос не удался — не блокируем диалог, отдаём каталоги из дерева.
      if (!cached) {
        setMoveDirs([])
        setMoveDirsFailed(true)
      }
    } finally {
      if (moveLoadProjectRef.current === projectId) setMoveDirsLoading(false)
    }
  }, [])

  const projectDirPaths = useMemo(() => {
    if (!moveTarget) return []
    const pid = moveTarget.projectId
    const src = moveTarget.entry.path
    // Корень workspace — всегда доступная цель (пустая строка = '').
    const all = new Set<string>([''])
    if (!moveDirsFailed) {
      // Полный список из рекурсивного листинга (или уже загруженный кэш).
      for (const d of moveDirs) all.add(d)
    } else {
      // Fallback: каталоги из уже загруженных веток дерева.
      const prefix = `${pid}/`
      for (const [key, entries] of Object.entries(treesByProject)) {
        if (key === pid || key.startsWith(prefix)) {
          for (const e of entries) {
            if (e.isDirectory) all.add(e.path)
          }
        }
        if (key.startsWith(prefix)) {
          all.add(key.slice(prefix.length))
        }
      }
    }
    all.delete(src)
    for (const d of [...all]) {
      if (d.startsWith(`${src}/`)) all.delete(d)
    }
    // Корень — первой строкой, подкаталоги — по алфавиту.
    const rest = [...all].filter((d) => d !== '').sort((a, b) => a.localeCompare(b))
    return ['', ...rest]
  }, [treesByProject, moveDirs, moveDirsFailed, moveTarget])

  const openFilePathSet = useMemo(() => {
    const set = new Set<string>()
    for (const tab of (centerTabs ?? [])) {
      if (tab.data?.projectId && tab.data?.filePath) {
        set.add(`${tab.data.projectId}::${tab.data.filePath}`)
      }
    }
    return set
  }, [centerTabs])

  const activeFilePathKey = useMemo(() => {
    const tab = (centerTabs ?? []).find((t) => t.id === activeCenterTabId)
    if (tab?.data?.projectId && tab?.data?.filePath) {
      return `${tab.data.projectId}::${tab.data.filePath}`
    }
    return null
  }, [centerTabs, activeCenterTabId])

  const activeTabData = useMemo(() => {
    if (!activeCenterTabId) return null
    const tab = (centerTabs ?? []).find((t) => t.id === activeCenterTabId)
    if (tab?.type === 'file-viewer' && tab.data?.projectId && tab.data?.filePath) {
      return { projectId: tab.data.projectId, filePath: tab.data.filePath }
    }
    return null
  }, [centerTabs, activeCenterTabId])

  const scrollTarget = useMemo(() => {
    if (!activeTabData) return null
    return `${activeTabData.projectId}::${activeTabData.filePath}`
  }, [activeTabData])

  useAutoScroll(scrollTarget)

  useEffect(() => {
    if (!activeTabData) return
    const { projectId, filePath } = activeTabData
    const store = useFilesStore.getState()
    if (!store.expandedProjects.has(projectId)) {
      store.toggleProjectExpand(projectId)
    }
    const segments = filePath.split('/').filter(Boolean)
    let partial = ''
    for (const seg of segments.slice(0, -1)) {
      partial = partial ? `${partial}/${seg}` : seg
      useFilesStore.getState().ensureDirExpanded(projectId, partial)
    }
  }, [activeTabData])

  useEffect(() => {
    workspacedProjects.forEach((p) => {
      if (expandedProjects.has(p.id) && !treesByProject[p.id]) loadFileTree(p.id)
    })
  }, [workspacedProjects, expandedProjects, treesByProject, loadFileTree])

  useEffect(() => {
    expandedDirs.forEach((key) => {
      const parts = key.split('/')
      const projectId = parts[0]
      const dirPath = parts.slice(1).join('/')
      if (projectId && dirPath && !treesByProject[key]) {
        loadSubDirectory(projectId, dirPath)
      }
    })
  }, [expandedDirs])

  const toggleDir = (projectId: string, dirPath: string) => {
    toggleDirExpand(projectId, dirPath)
  }

  const fileIconName = (name: string): 'file-text' | 'file-code' | 'image' | 'file-music' => {
    if (/\.(tsx?|jsx?|py|rs|go|java|rb|php|swift|kt)$/i.test(name)) return 'file-code'
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)) return 'image'
    if (/\.(mp3|wav|ogg|flac)$/i.test(name)) return 'file-music'
    return 'file-text'
  }

  const fileSize = (size: number) => size > 1024 ? `${(size / 1024).toFixed(1)}k` : `${size}b`

  const handleUpload = (projectId: string, dirPath = '') => {
    setActiveUploadProject(projectId)
    setActiveUploadPath(dirPath)
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !activeUploadProject) return
    await uploadFile(activeUploadProject, activeUploadPath, file)
    setActiveUploadProject(null)
    setActiveUploadPath('')
    e.target.value = ''
  }

  const handleDownload = (projectId: string, entry: any) => {
    const url = synthApi.downloadFile(projectId, entry.path)
    const a = document.createElement('a')
    a.href = url
    a.download = entry.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handlePopoverSubmit = async () => {
    const name = popoverName.trim()
    if (!name || !popover) return
    const newPath = popover.parentPath ? `${popover.parentPath}/${name}` : name
    if (popover.type === 'newFolder') {
      await createDirectory(popover.projectId, newPath)
    } else {
      await createFile(popover.projectId, newPath)
    }
    setPopover(null)
    setPopoverName('')
  }

  const handleRenameStart = (projectId: string, entry: any) => {
    setRenamingProject(projectId)
    setRenamingPath(entry.path)
    setRenamingEntry(entry)
    setRenameValue(entry.name)
  }

  const handleRenameSubmit = async (projectId: string, entry: any) => {
    const newName = renameValue.trim()
    if (!newName || newName === entry.name) {
      setRenamingPath(null)
      setRenamingProject(null)
      setRenamingEntry(null)
      return
    }
    const parts = entry.path.split('/')
    parts[parts.length - 1] = newName
    const targetPath = parts.join('/')
    const ok = await moveEntry(projectId, entry.path, targetPath)
    if (ok) {
      useUIStore.getState().remapFileTabs(projectId, entry.path, projectId, targetPath)
    } else {
      notify({ text: t('file.moveError'), type: 'error', category: 'error' })
    }
    setRenamingPath(null)
    setRenamingProject(null)
    setRenamingEntry(null)
  }

  const openMoveDialog = (projectId: string, entry: any) => {
    setMoveTarget({ projectId, entry })
    setMoveDest('')
    void loadMoveDirs(projectId)
  }

  const handleMoveSubmit = async () => {
    if (!moveTarget) return
    const { projectId, entry } = moveTarget
    const dest = moveDest.trim().replace(/\/+$/, '')
    const name = entry.path.split('/').pop() || entry.name
    const targetPath = dest ? `${dest}/${name}` : name
    if (targetPath !== entry.path) {
      const ok = await moveEntry(projectId, entry.path, targetPath)
      if (ok) {
        useUIStore.getState().remapFileTabs(projectId, entry.path, projectId, targetPath)
      } else {
        notify({ text: t('file.moveError'), type: 'error', category: 'error' })
      }
    }
    setMoveTarget(null)
    setMoveDest('')
  }

  const handleFileDragStart = (e: React.DragEvent, projectId: string, entry: any) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ projectId, path: entry.path }))
    e.dataTransfer.effectAllowed = 'move'
    setDragState({ projectId, path: entry.path })
  }

  const handleFileDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDropOnDir = async (e: React.DragEvent, targetProjectId: string, targetDirPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragState(null)
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    try {
      const { projectId: srcProject, path: srcPath } = JSON.parse(raw) as { projectId: string; path: string }
      if (srcProject === targetProjectId && srcPath === targetDirPath) return
      const name = srcPath.split('/').pop() || 'moved'
      const targetPath = targetDirPath ? `${targetDirPath}/${name}` : name
      if (srcProject === targetProjectId) {
        const ok = await moveEntry(targetProjectId, srcPath, targetPath)
        if (ok) {
          useUIStore.getState().remapFileTabs(targetProjectId, srcPath, targetProjectId, targetPath)
        } else {
          notify({ text: t('file.moveError'), type: 'error', category: 'error' })
        }
      } else {
        // Перенос между проектами — серверным /fs/move с targetProjectId
        // (черновики переносятся внутри moveEntry через remapPath).
        const ok = await moveEntry(srcProject, srcPath, targetPath, targetProjectId)
        if (ok) {
          useUIStore.getState().remapFileTabs(srcProject, srcPath, targetProjectId, targetPath)
        } else {
          notify({ text: t('file.moveError'), type: 'error', category: 'error' })
        }
      }
    } catch { /* ignore */ }
  }

  const handleDropOnProject = async (e: React.DragEvent, targetProjectId: string) => {
    e.preventDefault()
    setDragState(null)
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    try {
      const { projectId: srcProject, path: srcPath } = JSON.parse(raw) as { projectId: string; path: string }
      if (srcProject === targetProjectId) return
      const name = srcPath.split('/').pop() || 'moved'
      const ok = await moveEntry(srcProject, srcPath, name, targetProjectId)
      if (ok) {
        useUIStore.getState().remapFileTabs(srcProject, srcPath, targetProjectId, name)
      } else {
        notify({ text: t('file.moveError'), type: 'error', category: 'error' })
      }
    } catch { /* ignore */ }
  }

  const renderEntry = (projectId: string, entry: any, depth: number): TreeNodeBase => {
    const isDir = entry.isDirectory
    const dirKey = `${projectId}/${entry.path}`
    const isExpanded = expandedDirs.has(dirKey)
    const isRenaming = renamingPath === entry.path && renamingProject === projectId

    const entryActions: TreeAction[] = []
    if (isDir) {
      entryActions.push({
        id: `upload-${entry.path}`,
        icon: 'upload',
        title: t('file.upload'),
        onClick: () => handleUpload(projectId, entry.path),
      })
      entryActions.push({
        id: `new-file-${entry.path}`,
        icon: 'file-add',
        title: t('files.newFile'),
        onClick: () => setPopover({ type: 'newFile', projectId, parentPath: entry.path }),
      })
      entryActions.push({
        id: `new-folder-${entry.path}`,
        icon: 'folder-add',
        title: t('file.newFolder'),
        onClick: () => setPopover({ type: 'newFolder', projectId, parentPath: entry.path }),
      })
    } else {
      entryActions.push({
        id: `download-${entry.path}`,
        icon: 'download',
        title: t('file.download'),
        onClick: () => handleDownload(projectId, entry),
      })
    }

    const entryContextItems: any[] = [
      { label: t('file.move'), icon: 'folder-received' as const, onClick: () => openMoveDialog(projectId, entry) },
      { label: t('files.rename'), icon: 'pencil-ai' as const, onClick: () => handleRenameStart(projectId, entry) },
      { label: t('common.delete'), icon: 'delete-bin' as const, onClick: () => {
        pendingDeleteRef.current.add(`${projectId}::${entry.path}`)
        setConfirm({
          title: t('common.delete'),
          message: t('file.confirmDelete', { name: entry.name }),
          variant: 'danger',
          onConfirm: async () => {
            useUIStore.getState().closeTab(`file-${projectId}/${entry.path}`)
            await deleteEntry(projectId, entry.path)
            pendingDeleteRef.current.delete(`${projectId}::${entry.path}`)
          },
        })
      }, destructive: true },
    ]

    const isDragging = dragState?.projectId === projectId && dragState?.path === entry.path

    return {
      id: `${projectId}::${entry.path}`,
      label: entry.name,
      depth,
      icon: isDir ? (isExpanded ? 'folder-open' : 'folder') : fileIconName(entry.name),
      isExpanded: isDir ? isExpanded : undefined,
      hasChildren: isDir ? true : undefined,
      onToggle: isDir ? () => toggleDir(projectId, entry.path) : undefined,
      suffix: !isDir ? fileSize(entry.size) : undefined,
      isTabOpen: openFilePathSet.has(`${projectId}::${entry.path}`),
      isActive: activeFilePathKey === `${projectId}::${entry.path}`,
      draggable: !isTouch,
      isRenaming,
      renameValue: isRenaming ? renameValue : '',
      onRenameChange: setRenameValue,
      onRenameCommit: () => handleRenameSubmit(projectId, entry),
      onRenameCancel: () => { setRenamingPath(null); setRenamingProject(null); setRenamingEntry(null) },
      onDragStart: isTouch ? undefined : (e) => handleFileDragStart(e, projectId, entry),
      onDragOver: isDir && !isTouch ? handleFileDragOver : undefined,
      onDrop: isDir && !isTouch ? (e: React.DragEvent) => handleDropOnDir(e, projectId, entry.path) : undefined,
      onClick: () => {
        if (pendingDeleteRef.current.has(`${projectId}::${entry.path}`)) return
        if (isDir) { toggleDir(projectId, entry.path) } else {
          openTab({ id: `file-${projectId}/${entry.path}`, type: 'file-viewer', title: entry.name, data: { filePath: entry.path, projectId } })
        }
      },
      actions: entryActions,
      contextItems: entryContextItems,
      className: isDragging ? 'opacity-40' : undefined,
    }
  }

  const renderSubtree = (projectId: string, entry: any, depth: number): React.ReactNode => {
    const node = renderEntry(projectId, entry, depth)
    const subKey = `${projectId}/${entry.path}`
    const isDirExpanded = expandedDirs.has(subKey)
    const subEntries = entry.isDirectory && isDirExpanded ? (treesByProject[subKey] || []) : []

    return (
      <React.Fragment key={node.id}>
        <TreeNode {...node} />
        {subEntries.length > 0 && (
          <TreeChildren borderOnHover totalCount={subEntries.length}>
            {subEntries.map((child) => renderSubtree(projectId, child, depth + 1))}
          </TreeChildren>
        )}
      </React.Fragment>
    )
  }

  const renderFilesProject = (project: ProjectData) => {
    const isExpanded = expandedProjects.has(project.id)
    const entries = treesByProject[project.id] || []

    return (
      <div key={project.id}>
        <TreeNode
          id={`file-project:${project.id}`}
          label={project.name}
          icon={resolveIconName(project.icon) ?? 'folder-3'}
          iconColor={resolveIconColor(project.color)}
          iconSize="md"
          isExpanded={isExpanded}
          hasChildren={true}
          badge={<OriginBadge origin={project.origin} />}
          onToggle={() => toggleProjectExpand(project.id)}
          onDragOver={isTouch ? undefined : handleFileDragOver}
          onDrop={isTouch ? undefined : (e) => handleDropOnProject(e, project.id)}
          actions={[
            { id: 'upload', icon: 'upload', title: t('file.upload'), onClick: () => handleUpload(project.id) },
            { id: 'new-file-root', icon: 'file-add', title: t('files.newFile'), onClick: () => setPopover({ type: 'newFile', projectId: project.id, parentPath: '' }) },
            { id: 'new-folder-root', icon: 'folder-add', title: t('file.newFolder'), onClick: () => setPopover({ type: 'newFolder', projectId: project.id, parentPath: '' }) },
          ]}
        />
        {isExpanded && (
          <TreeChildren
            indent
            totalCount={entries.length}
            emptyText={t('leftPanel.emptyDirectory')}
          >
            <div className="flex items-center gap-1 px-2 py-0.5">
              <Icon name="folder-3" className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <span className="text-[0.6875rem] text-muted-foreground/60 truncate">{project.workspace || ''}</span>
            </div>
            {entries.map((entry) => {
              const node = renderEntry(project.id, entry, 0)
              const subKey = `${project.id}/${entry.path}`
              const isDirExpanded = expandedDirs.has(subKey)
              const subEntries = entry.isDirectory && isDirExpanded
                ? (treesByProject[subKey] || [])
                : []

              return (
                <React.Fragment key={node.id}>
                  <TreeNode {...node} />
                  {subEntries.length > 0 && (
                    <TreeChildren
                      borderOnHover
                      totalCount={subEntries.length}
                    >
                      {subEntries.map((child) => renderSubtree(project.id, child, 1))}
                    </TreeChildren>
                  )}
                </React.Fragment>
              )
            })}
          </TreeChildren>
        )}
      </div>
    )
  }

  if (workspacedProjects.length === 0) {
    return (
      <TreeContainer>
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Icon name="folder-3" className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('leftPanel.noWorkspace')}</p>
        </div>
      </TreeContainer>
    )
  }

  return (
    <TreeContainer>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        variant={confirm?.variant ?? 'danger'}
        onConfirm={() => { confirm?.onConfirm(); setConfirm(null) }}
      />

      {moveTarget && (
        <Dialog open={!!moveTarget} onOpenChange={(open) => { if (!open) { setMoveTarget(null); setMoveDest('') } }}>
          <DialogContent className="max-w-sm p-4 gap-3" showCloseButton={true}>
            <h3 className="text-sm font-semibold">Переместить «{moveTarget.entry.name}»</h3>
            <p className="text-xs text-muted-foreground">{moveTarget.entry.path || '/'}</p>
            <input
              type="text"
              value={moveDest}
              onChange={(e) => setMoveDest(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleMoveSubmit() }}
              className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none"
            />
            {moveDirsLoading ? (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                <Icon name="loader-2" className="size-3.5 animate-spin" />
                {t('common.loading')}
              </div>
            ) : projectDirPaths.length > 0 && (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {projectDirPaths.map((dir) => {
                  const isRoot = dir === ''
                  return (
                    <button
                      key={dir || '__root__'}
                      onClick={() => setMoveDest(isRoot ? '' : (dir === moveDest ? '' : dir))}
                      title={isRoot ? t('file.workspaceRoot') : dir}
                      className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-accent flex items-center gap-1.5 ${dir === moveDest ? 'bg-accent' : ''}`}
                    >
                      <Icon name={isRoot ? 'folder-3' : 'folder'} className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{isRoot ? '/' : dir}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={handleMoveSubmit} className="flex-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors">{t('file.move')}</button>
              <button onClick={() => { setMoveTarget(null); setMoveDest('') }} className="flex-1 rounded bg-interactive px-2 py-1 text-xs text-foreground hover:bg-interactive-hover transition-colors">{t('common.cancel')}</button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <input ref={fileInputRef} type="file" onChange={handleFileChange} className="hidden" />

      {popover && (
        <Popover open={!!popover} onOpenChange={(open) => { if (!open) setPopover(null) }}>
          <PopoverTrigger asChild>
            <span className="absolute opacity-0 pointer-events-none" />
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" sideOffset={4} className="w-56 p-2 space-y-2">
            <input
              type="text"
              value={popoverName}
              onChange={(e) => setPopoverName(e.target.value)}
              placeholder={popover.type === 'newFolder' ? t('file.folderName') : t('file.fileName')}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handlePopoverSubmit() }}
              className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none"
            />
            <div className="flex gap-2">
              <button onClick={handlePopoverSubmit} className="flex-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors">{t('common.ok')}</button>
              <button onClick={() => setPopover(null)} className="flex-1 rounded bg-interactive px-2 py-1 text-xs text-foreground hover:bg-interactive-hover transition-colors">{t('common.cancel')}</button>
            </div>
          </PopoverContent>
        </Popover>
      )}

      {!currentProject ? (
        <>
          {activeProjectSource === 'session' && !activeProjectId && (
            <ScopeHint text={t('leftPanel.currentProject.none')} />
          )}
          {activeProjectSource !== null && !!activeProjectId && (
            <ScopeHint text={t('leftPanel.currentProject.noWorkspace')} />
          )}
          {workspacedProjects.map(renderFilesProject)}
        </>
      ) : (
        <>
          <CurrentProjectHeader label={t('leftPanel.currentProject')} />
          {renderFilesProject(currentProject)}
          {!onlyActiveProject && otherProjects.length > 0 && (
            <OtherProjectsGroup
              label={t('leftPanel.otherProjects', { count: String(otherProjects.length) })}
              title={collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)
                ? t('leftPanel.otherProjects.expand')
                : t('leftPanel.otherProjects.collapse')}
              collapsed={collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)}
              onToggle={() => toggleProjectCollapse(OTHER_PROJECTS_COLLAPSE_KEY)}
            >
              {otherProjects.map(renderFilesProject)}
            </OtherProjectsGroup>
          )}
        </>
      )}
    </TreeContainer>
  )
}
