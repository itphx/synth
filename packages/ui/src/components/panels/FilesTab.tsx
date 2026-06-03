import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useFilesStore } from '@/stores/filesStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { Icon } from '@/components/icon/Icon'
import { ContextMenu } from '@/components/ui/contextMenu'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useI18n } from '@/lib/i18n'
import { PROJECT_COLOR_MAP } from '@/lib/projectMeta'
import { synthApi } from '@/lib/api/synthApi'
import type { FileEntry } from '@/lib/api/synthApi'

const MAX_VISIBLE_ENTRIES = 12

type PopoverMode = null | { type: 'newFolder' | 'newFile'; projectId: string; parentPath: string }

export const FilesTab: React.FC = () => {
  const { t } = useI18n()
  const { projects, loadProjects } = useProjectsStore()
  const {
    treesByProject, loadFileTree, loadSubDirectory, uploadFile, createDirectory, createFile, deleteEntry, moveEntry,
    loading, expandedProjects, toggleProjectExpand,
    selectionMode, selectedPaths, toggleSelectionMode, toggleSelectedPath, clearSelection,
    deleteSelectedEntries,
  } = useFilesStore()
  const { openTab } = useUIStore()
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [showMoreLimits, setShowMoreLimits] = useState<Record<string, number>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [activeUploadProject, setActiveUploadProject] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragState, setDragState] = useState<{ projectId: string; path: string } | null>(null)
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [popover, setPopover] = useState<PopoverMode>(null)
  const [popoverName, setPopoverName] = useState('')

  const workspacedProjects = projects.filter((p) => p.workspace)
  const closeMenu = useCallback(() => setOpenMenuKey(null), [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    workspacedProjects.forEach((p) => {
      if (expandedProjects.has(p.id) && !treesByProject[p.id]) {
        loadFileTree(p.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacedProjects, expandedProjects])

  const toggleDir = (projectId: string, dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      const key = `${projectId}/${dirPath}`
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        loadSubDirectory(projectId, dirPath)
      }
      return next
    })
  }

  const handleFileClick = useCallback((projectId: string, entry: FileEntry) => {
    if (selectionMode) {
      toggleSelectedPath(`${projectId}::${entry.path}`)
      return
    }
    if (entry.isDirectory) {
      toggleDir(projectId, entry.path)
    } else {
      openTab({
        id: `file-${projectId}/${entry.path}`,
        type: 'file-viewer',
        title: entry.name,
        data: { filePath: entry.path, projectId },
      })
    }
  }, [selectionMode, toggleSelectedPath, openTab])

  const handleUpload = useCallback((projectId: string) => {
    setActiveUploadProject(projectId)
    fileInputRef.current?.click()
  }, [])

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const projectId = activeUploadProject
    e.target.value = ''
    setActiveUploadProject(null)
    if (!file || !projectId) return
    await uploadFile(projectId, '', file)
  }, [activeUploadProject, uploadFile])

  const handlePopoverSubmit = async () => {
    const name = popoverName.trim()
    const mode = popover
    setPopover(null)
    setPopoverName('')
    if (!name || !mode) return
    const newPath = mode.parentPath ? `${mode.parentPath}/${name}` : name
    if (mode.type === 'newFolder') {
      await createDirectory(mode.projectId, newPath)
    } else {
      await createFile(mode.projectId, newPath)
    }
  }

  const handlePopoverOpen = (mode: PopoverMode) => (open: boolean) => {
    if (open) {
      setPopoverName('')
      setPopover(mode)
    } else {
      setPopover(null)
      setPopoverName('')
    }
  }

  const handleDelete = useCallback(async (projectId: string, entry: FileEntry) => {
    closeMenu()
    if (!window.confirm(t('file.confirmDelete', { name: entry.name }))) return
    await deleteEntry(projectId, entry.path)
  }, [deleteEntry, t, closeMenu])

  const handleRenameStart = useCallback((entry: FileEntry) => {
    closeMenu()
    setRenaming(entry.path)
    setRenameValue(entry.name)
  }, [closeMenu])

  const handleRenameSubmit = useCallback(async (projectId: string, entry: FileEntry) => {
    const newName = renameValue.trim()
    if (!newName || newName === entry.name) { setRenaming(null); return }
    const parts = entry.path.split('/')
    parts[parts.length - 1] = newName
    const targetPath = parts.join('/')
    await moveEntry(projectId, entry.path, targetPath)
    setRenaming(null)
  }, [renameValue, moveEntry])

  const handleBulkDelete = useCallback(async () => {
    const count = Object.keys(selectedPaths).length
    if (!window.confirm(t('files.confirmBulkDelete', { count: String(count) }))) return
    const projectIds = new Set<string>()
    for (const key of Object.keys(selectedPaths)) {
      const sepIdx = key.indexOf('::')
      if (sepIdx !== -1) projectIds.add(key.slice(0, sepIdx))
    }
    for (const pid of projectIds) {
      await deleteSelectedEntries(pid)
    }
    clearSelection()
    toggleSelectionMode()
  }, [selectedPaths, deleteSelectedEntries, clearSelection, toggleSelectionMode, t])

  const handleDownload = useCallback((projectId: string, entry: FileEntry) => {
    closeMenu()
    const url = synthApi.downloadFile(projectId, entry.path)
    const a = document.createElement('a')
    a.href = url
    a.download = entry.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [closeMenu])

  const handleDragStart = useCallback((e: React.DragEvent, projectId: string, entry: FileEntry) => {
    if (selectionMode) return
    e.dataTransfer.setData('text/plain', JSON.stringify({ projectId, path: entry.path }))
    e.dataTransfer.effectAllowed = 'move'
    setDragState({ projectId, path: entry.path })
  }, [selectionMode])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDropOnDir = useCallback(async (e: React.DragEvent, targetProjectId: string, targetDirPath: string) => {
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
        await moveEntry(targetProjectId, srcPath, targetPath)
      } else {
        // cross-project
        const { content } = await synthApi.readFile(srcProject, srcPath)
        await synthApi.writeFile(targetProjectId, targetPath, content)
        await deleteEntry(srcProject, srcPath)
      }
    } catch { /* ignore */ }
  }, [moveEntry, deleteEntry])

  const handleDropOnProject = useCallback(async (e: React.DragEvent, targetProjectId: string) => {
    e.preventDefault()
    setDragState(null)
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    try {
      const { projectId: srcProject, path: srcPath } = JSON.parse(raw) as { projectId: string; path: string }
      if (srcProject === targetProjectId) return
      const name = srcPath.split('/').pop() || 'moved'
      const { content } = await synthApi.readFile(srcProject, srcPath)
      await synthApi.writeFile(targetProjectId, name, content)
      await deleteEntry(srcProject, srcPath)
    } catch { /* ignore */ }
  }, [deleteEntry])

  const fileIconName = (name: string): 'file-text' | 'file-code' | 'image' | 'file-music' => {
    if (/\.(tsx?|jsx?|py|rs|go|java|rb|php|swift|kt)$/i.test(name)) return 'file-code'
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)) return 'image'
    if (/\.(mp3|wav|ogg|flac)$/i.test(name)) return 'file-music'
    return 'file-text'
  }

  const isEntrySelected = (projectId: string, entry: FileEntry) =>
    !!selectedPaths[`${projectId}::${entry.path}`]

  const getEntryLimit = (projectId: string) => showMoreLimits[projectId] || MAX_VISIBLE_ENTRIES

  const renderEntry = (projectId: string, entry: FileEntry, depth: number = 0, hideOverflow: boolean = false, overflowIndex: number = 0) => {
    const dirKey = `${projectId}/${entry.path}`
    const isExpanded = expandedDirs.has(dirKey)
    const isSelected = isEntrySelected(projectId, entry)
    const isRenaming = renaming === entry.path
    const menuKey = `${projectId}::${entry.path}`
    const isMenuOpen = openMenuKey === menuKey

    if (hideOverflow && overflowIndex >= getEntryLimit(projectId)) return null

    return (
      <div key={`${projectId}::${entry.path}`}>
        <div
          className={`group/entry flex items-center gap-1 rounded px-2 py-0.5 text-sm cursor-pointer transition-colors ${
            isSelected ? 'bg-primary/15' : 'hover:bg-interactive-hover'
          } ${dragState?.projectId === projectId && dragState?.path === entry.path ? 'opacity-40' : ''}`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => !isRenaming && handleFileClick(projectId, entry)}
          draggable={!selectionMode && !isRenaming}
          onDragStart={(e) => handleDragStart(e, projectId, entry)}
          {...(entry.isDirectory ? { onDragOver: handleDragOver, onDrop: (e: React.DragEvent) => handleDropOnDir(e, projectId, entry.path) } : {})}
        >
          {selectionMode && (
            <Icon
              name={isSelected ? 'checkbox' : 'checkbox-blank'}
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
          )}
          {entry.isDirectory && (
            <span className="h-3.5 w-3.5 flex items-center justify-center text-muted-foreground shrink-0">
              <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
            </span>
          )}
          <Icon
            name={!entry.isDirectory ? fileIconName(entry.name) : (isExpanded ? 'folder-open' : 'folder')}
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
          {isRenaming ? (
            <div className="flex items-center gap-0.5 flex-1 min-w-0">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit(projectId, entry)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => handleRenameSubmit(projectId, entry)}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 bg-interactive rounded px-1 py-0 text-sm text-foreground outline-none"
              />
              <button onClick={(e) => { e.stopPropagation(); handleRenameSubmit(projectId, entry) }} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-status-success" title={t('leftPanel.confirm')}>
                <Icon name="check" className="h-3.5 w-3.5" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); setRenaming(null) }} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive" title={t('leftPanel.cancel')}>
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <span className="truncate text-foreground">{entry.name}</span>
          )}
          {!entry.isDirectory && !selectionMode && !isRenaming && (
            <span className="text-xs text-muted-foreground shrink-0 group-hover/entry:hidden">
              {entry.size > 1024 ? `${(entry.size / 1024).toFixed(1)}k` : `${entry.size}b`}
            </span>
          )}

          {!selectionMode && !isRenaming && (
            <div className={`shrink-0 flex items-center gap-0.5 bg-sidebar rounded ml-auto ${isMenuOpen ? '' : 'hidden group-hover/entry:flex'}`}>
              <button
                onClick={(e) => { e.stopPropagation(); setPopover({ type: 'newFile', projectId, parentPath: entry.isDirectory ? entry.path : entry.path.split('/').slice(0, -1).join('/') }) }}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                title={t('files.newFile')}
              >
                <Icon name="file-add" className="h-3.5 w-3.5" />
              </button>
              {entry.isDirectory && (
                <button
                  onClick={(e) => { e.stopPropagation(); setPopover({ type: 'newFolder', projectId, parentPath: entry.path }) }}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                  title={t('file.newFolder')}
                >
                  <Icon name="folder-add" className="h-3.5 w-3.5" />
                </button>
              )}
              <ContextMenu
                trigger={
                  <button
                    onClick={(e) => { e.stopPropagation(); setOpenMenuKey(isMenuOpen ? null : menuKey) }}
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Icon name="more-2" className="h-3.5 w-3.5" />
                  </button>
                }
                items={[
                  ...(entry.isDirectory ? [] : [
                    { label: t('file.download'), icon: 'download' as const, onClick: () => handleDownload(projectId, entry) },
                  ]),
                  'separator' as const,
                  { label: t('files.rename'), icon: 'pencil-ai' as const, onClick: () => handleRenameStart(entry) },
                  { label: t('common.delete'), icon: 'delete-bin' as const, onClick: () => handleDelete(projectId, entry), destructive: true },
                ] as any}
                align="end"
              />
            </div>
          )}
        </div>
        {entry.isDirectory && isExpanded && (
          <div>
            {(treesByProject[`${projectId}/${entry.path}`] || [])
              .map((e, i) => renderEntry(projectId, e, depth + 1, true, i))}
            {hideOverflow && (treesByProject[`${projectId}/${entry.path}`] || []).length > getEntryLimit(projectId) && (
              <button
                onClick={() => setShowMoreLimits((prev) => ({
                  ...prev,
                  [projectId]: (prev[projectId] || MAX_VISIBLE_ENTRIES) + MAX_VISIBLE_ENTRIES,
                }))}
                className="w-full text-left rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-interactive-hover transition-colors"
                style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}
              >
                {t('files.showMore', { count: String((treesByProject[`${projectId}/${entry.path}`] || []).length - getEntryLimit(projectId)) })}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  if (workspacedProjects.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Icon name="folder-3" className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('leftPanel.noWorkspace')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {selectionMode && (
        <div className="flex shrink-0 items-center gap-1 px-2 py-1 border-b border-border">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t('files.bulkSelectedCount', { count: String(Object.keys(selectedPaths).length) })}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button onClick={handleBulkDelete} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-status-error/10 hover:text-status-error transition-colors">
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => { clearSelection(); toggleSelectionMode() }} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors">
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}...</div>
        )}
        {workspacedProjects.map((project) => {
          const isExpanded = expandedProjects.has(project.id)
          const entries = treesByProject[project.id] || []
          const entryLimit = getEntryLimit(project.id)

          return (
            <div key={project.id} className="group/project">
              <div
                className="relative flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition-colors hover:bg-interactive-hover rounded-md mx-1"
                onClick={() => {
                  toggleProjectExpand(project.id)
                  setShowMoreLimits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== project.id)))
                }}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDropOnProject(e, project.id)}
              >
                <span className="h-3.5 w-3.5 flex items-center justify-center text-muted-foreground">
                  <Icon
                    name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                    className="h-3.5 w-3.5"
                  />
                </span>
                <Icon
                  name={project.icon ? project.icon : 'folder-3'}
                  className="h-4 w-4 shrink-0"
                  style={{ color: project.color ? PROJECT_COLOR_MAP[project.color] : 'var(--muted-foreground)' }}
                />
                <span className="truncate text-sm font-medium text-foreground flex-1 min-w-0">{project.name}</span>
                <div className="shrink-0 hidden group-hover/project:flex items-center gap-0.5 bg-sidebar rounded">
                  <button onClick={(e) => { e.stopPropagation(); handleUpload(project.id) }} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors" title={t('file.upload')}>
                    <Icon name="upload" className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setPopover({ type: 'newFolder', projectId: project.id, parentPath: '' }) }} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors" title={t('file.newFolder')}>
                    <Icon name="folder-add" className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="ml-5 border-l border-sidebar-border pl-2">
                  <div className="flex items-center gap-1 px-2 py-0.5">
                    <Icon name="folder-3" className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                    <span className="text-[11px] text-muted-foreground/60 truncate" title={project.workspace || ''}>
                      {project.workspace || ''}
                    </span>
                  </div>

                  {entries.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {t('leftPanel.emptyDirectory')}
                    </div>
                  ) : (
                    <>
                      {entries.slice(0, entryLimit).map((e, i) => renderEntry(project.id, e, 0, true, i))}
                      {entries.length > entryLimit && (
                        <button
                          onClick={() => setShowMoreLimits((prev) => ({ ...prev, [project.id]: (prev[project.id] || MAX_VISIBLE_ENTRIES) + MAX_VISIBLE_ENTRIES }))}
                          className="w-full text-left rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-interactive-hover transition-colors"
                        >
                          {t('files.showMore', { count: String(entries.length - entryLimit) })}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelected} />

      {/* Popover for create file/folder */}
      <Popover open={!!popover} onOpenChange={handlePopoverOpen(popover)}>
        <PopoverTrigger asChild><span className="hidden" /></PopoverTrigger>
        <PopoverContent className="w-48 p-3" onOpenAutoFocus={(e) => e.preventDefault()} align="start">
          <form onSubmit={(e) => { e.preventDefault(); handlePopoverSubmit() }} className="flex flex-col gap-2">
            <input
              autoFocus
              type="text"
              value={popoverName}
              onChange={(e) => setPopoverName(e.target.value)}
              placeholder={popover?.type === 'newFolder' ? t('file.newFolder') : t('files.newFile')}
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
            />
            <button type="submit" className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10">
              {t('common.create')}
            </button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  )
}
