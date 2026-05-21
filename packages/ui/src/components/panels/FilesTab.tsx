import React, { useEffect, useState } from 'react'
import { useFilesStore } from '@/stores/filesStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import type { FileEntry } from '@/lib/api/synthApi'

export const FilesTab: React.FC = () => {
  const { t } = useI18n()
  const { projects } = useProjectsStore()
  const { treesByProject, loadFileTree, loading } = useFilesStore()
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  const workspacedProjects = projects.filter((p) => p.workspace)

  useEffect(() => {
    if (!activeProjectId && workspacedProjects.length > 0) {
      setActiveProjectId(workspacedProjects[0].id)
    }
  }, [workspacedProjects, activeProjectId])

  useEffect(() => {
    if (activeProjectId && !treesByProject[activeProjectId]) {
      loadFileTree(activeProjectId)
    }
  }, [activeProjectId, treesByProject, loadFileTree])

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const entries = activeProjectId ? treesByProject[activeProjectId] || [] : []

  const toggleDir = async (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
  }

  const fileIconName = (name: string): 'file-text' | 'file-code' | 'image' | 'file-music' => {
    if (/\.(tsx?|jsx?|py|rs|go|java|rb|php|swift|kt)$/i.test(name)) return 'file-code'
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)) return 'image'
    if (/\.(mp3|wav|ogg|flac)$/i.test(name)) return 'file-music'
    return 'file-text'
  }

  const renderEntry = (entry: FileEntry, depth: number = 0) => (
    <div key={entry.path}>
      <div
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-sm cursor-pointer transition-colors hover:bg-interactive-hover`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => entry.isDirectory && toggleDir(entry.path)}
      >
        <Icon
          name={entry.isDirectory ? (expandedDirs.has(entry.path) ? 'folder-open' : 'folder') : fileIconName(entry.name)}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate text-foreground">{entry.name}</span>
        {!entry.isDirectory && (
          <span className="ml-auto text-xs text-muted-foreground">
            {entry.size > 1024 ? `${(entry.size / 1024).toFixed(1)}k` : `${entry.size}b`}
          </span>
        )}
      </div>
      {entry.isDirectory && expandedDirs.has(entry.path) && (
        <div>
          {(treesByProject[`${activeProjectId}/${entry.path}`] || []).map((e) => renderEntry(e, depth + 1))}
        </div>
      )}
    </div>
  )

  if (workspacedProjects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Icon name="folder-3" className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('leftPanel.noWorkspace')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {workspacedProjects.length > 1 && (
        <select
          value={activeProjectId || ''}
          onChange={(e) => setActiveProjectId(e.target.value)}
          className="m-1 rounded bg-interactive px-2 py-1 text-xs text-foreground outline-none"
        >
          {workspacedProjects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}...</div>
        )}
        {!loading && activeProject && (
          <div>
            <div className="px-2 py-0.5 text-xs font-medium text-muted-foreground truncate" title={activeProject.workspace || ''}>
              {activeProject.workspace || '/'}
            </div>
            {entries.map((e) => renderEntry(e))}
            {entries.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('leftPanel.emptyDirectory')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
