import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useFilesStore } from '@/stores/filesStore'
import { useGitStore } from '@/stores/gitStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta'
import { formatRelativeTime, parseISODate } from '@/lib/formatDate'
import { TreeNode, TreeChildren, TreeContainer } from '@/components/tree'
import type { TreeNodeBase, TreeAction } from '@/components/tree'

import { ProjectsTab } from './ProjectsTab'
import { FilesTab } from './FilesTab'
import { GitTab } from './GitTab'

const LEFT_TABS = [
  { id: 'projects' as const, icon: 'folder-3' as const, labelKey: 'leftPanel.tab.projects' },
  { id: 'files' as const, icon: 'file-text' as const, labelKey: 'leftPanel.tab.files' },
  { id: 'git' as const, icon: 'git-branch' as const, labelKey: 'leftPanel.tab.git' },
]

// ---- Debug: Projects tab using TreeNode ----

const MAX_VISIBLE_SESSIONS = 5
const MAX_VISIBLE_COMMITS = 10

function DebugProjectsTab() {
  const { t } = useI18n()
  const { projects, loadProjects, deleteProject } = useProjectsStore()
  const { sessions, loadSessions, createSession, deleteSession, moveSession } = useSessionsStore()
  const { collapsedProjects, toggleProjectCollapse, openTab, centerTabs, activeCenterTabId } = useUIStore()
  const { sortMode, selectionMode, selectedIds, toggleSelected } = useSessionsTreeStore()
  const streamingBySession = useChatStore((s) => s.streamingBySession)
  const queueBySession = useChatStore((s) => s.queueBySession)
  const sessionUnread = useNotificationStore((s) => s.sessionUnread)
  const clearSessionUnread = useNotificationStore((s) => s.clearSessionUnread)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => { loadProjects(); loadSessions() }, [loadProjects, loadSessions])

  const sessionsByProject = useMemo(() => {
    const map: Record<string, any[]> = {}
    const sortFn = sortMode === 'date'
      ? (a: any, b: any) => parseISODate(b.updated_at).getTime() - parseISODate(a.updated_at).getTime()
      : (a: any, b: any) => a.id.localeCompare(b.id)
    map['__none__'] = []
    for (const s of sessions) {
      const pid = s.project_id || '__none__'
      if (!map[pid]) map[pid] = []
      map[pid].push(s)
    }
    for (const pid of Object.keys(map)) map[pid].sort(sortFn)
    return map
  }, [sessions, sortMode])

  const sortedProjects = useMemo(() => {
    if (sortMode === 'date') return projects
    return [...projects].sort((a, b) => a.name.localeCompare(b.name))
  }, [projects, sortMode])

  const sessionTabOpenSet = useMemo(() => {
    const set = new Set<string>()
    for (const tab of (centerTabs ?? [])) {
      if (tab.type === 'chat' && tab.data?.sessionId) set.add(tab.data.sessionId)
    }
    return set
  }, [centerTabs])

  const getSessionStatus = (sessionId: string) => {
    const streams = streamingBySession[sessionId]
    if (streams && Object.keys(streams).length > 0) return 'streaming' as const
    const qi = queueBySession[sessionId]
    if (qi?.isStalled) return 'stalled' as const
    const pendingCount = qi?.pendingCount || 0
    if (pendingCount > 0) return 'pending' as const
    return undefined
  }

  const renderSessionNode = (session: any): TreeNodeBase => {
    const isStreaming = getSessionStatus(session.id) === 'streaming'
    const hasUnread = (sessionUnread[session.id] || 0) > 0

    return {
      id: `session:${session.id}`,
      label: session.name || session.id,
      depth: 1,
      icon: 'chat-new',
      iconColor: isStreaming ? undefined : hasUnread ? undefined : undefined,
      subtitle: formatRelativeTime(session.updated_at),
      isSelected: selectedIds.has(session.id),
      isTabOpen: sessionTabOpenSet.has(session.id),
      isActive: activeCenterTabId === `chat-${session.id}`,
      selectionMode,
      status: getSessionStatus(session.id),
      unreadCount: sessionUnread[session.id] || 0,
      isRenaming: renamingId === session.id,
      renameValue: renamingId === session.id ? renameValue : '',
      onRenameStart: () => { setRenamingId(session.id); setRenameValue(session.name || session.id) },
      onRenameChange: setRenameValue,
      onRenameCommit: async () => {
        if (renameValue.trim() && renamingId) {
          await useSessionsStore.getState().renameSession(renamingId, renameValue.trim())
          await loadSessions()
          useUIStore.getState().updateTabTitle(`chat-${renamingId}`, renameValue.trim())
        }
        setRenamingId(null)
        setRenameValue('')
      },
      onRenameCancel: () => { setRenamingId(null); setRenameValue('') },
      draggable: !selectionMode,
      onDragStart: (e) => { e.dataTransfer.setData('text/plain', session.id); e.dataTransfer.effectAllowed = 'move' },
      contextItems: [
        { label: t('leftPanel.rename'), icon: 'pencil-ai', onClick: () => { setRenamingId(session.id); setRenameValue(session.name || session.id) } },
        { label: t('leftPanel.clearSession'), icon: 'close', onClick: async () => {
          if (!window.confirm(t('leftPanel.confirmClearSession'))) return
          await synthApi.clearSession(session.id)
          useChatStore.getState().clearSession(session.id)
          const result = await synthApi.getSessionMessages(session.id)
          useChatStore.getState().setMessages(session.id, result.messages)
        }},
        'separator' as const,
        { label: t('leftPanel.delete'), icon: 'delete-bin', onClick: async () => {
          if (!window.confirm(t('leftPanel.confirmDeleteSession'))) return
          await deleteSession(session.id)
        }, destructive: true },
      ],
      onClick: () => {
        if (selectionMode) { toggleSelected(session.id); return }
        clearSessionUnread(session.id)
        openTab({ id: `chat-${session.id}`, type: 'chat', title: session.name || session.id, data: { sessionId: session.id, projectId: session.project_id || undefined } })
      },
    }
  }

  const hasItems =
    (sessionsByProject['__none__']?.length ?? 0) > 0 ||
    sortedProjects.some((p) => (sessionsByProject[p.id]?.length ?? 0) > 0)

  if (!hasItems) {
    return (
      <TreeContainer>
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Icon name="folder-3" className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('leftPanel.empty')}</p>
        </div>
      </TreeContainer>
    )
  }

  return (
    <TreeContainer>
      {/* No project group */}
      <GroupNode
        id="__none__"
        label={t('leftPanel.noProject')}
        icon="chat-new"
        isCollapsed={collapsedProjects.has('__none__')}
        onToggle={() => toggleProjectCollapse('__none__')}
        sessions={sessionsByProject['__none__'] || []}
        expandedGroups={expandedGroups}
        toggleGroupExpand={(k) => setExpandedGroups(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })}
        renderSessionNode={renderSessionNode}
        projectId={null}
        onCreateSession={async () => {
          const result = await createSession({ project_id: null })
          if (result) { toggleProjectCollapse('__none__'); setRenamingId(result.id); setRenameValue(result.id) }
        }}
        onDropSession={async (sessionId) => { await moveSession(sessionId, null) }}
        t={t}
      />

      {/* Projects */}
      {sortedProjects.map((project) => {
        const isCollapsed = collapsedProjects.has(project.id)
        return (
          <GroupNode
            key={project.id}
            id={project.id}
            label={project.name}
            icon={project.icon ? PROJECT_ICON_MAP[project.icon] : 'folder-3'}
            iconColor={project.color ? PROJECT_COLOR_MAP[project.color] : undefined}
            isCollapsed={isCollapsed}
            onToggle={() => toggleProjectCollapse(project.id)}
            sessions={sessionsByProject[project.id] || []}
            expandedGroups={expandedGroups}
            toggleGroupExpand={(k) => setExpandedGroups(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })}
            renderSessionNode={renderSessionNode}
            projectId={project.id}
            onCreateSession={async () => {
              const { toggleProjectCollapse: tpc } = useUIStore.getState()
              if (collapsedProjects.has(project.id)) tpc(project.id)
              const result = await createSession({ project_id: project.id })
              if (result) { setRenamingId(result.id); setRenameValue(result.id) }
            }}
            onDropSession={async (sessionId) => { await moveSession(sessionId, project.id) }}
            projectActions={[
              { id: 'new-session', icon: 'add' as const, title: t('leftPanel.newSession'), onClick: async () => {
                const result = await createSession({ project_id: project.id })
                if (result) { setRenamingId(result.id); setRenameValue(result.id) }
              }},
            ]}
            projectContextItems={[
              { label: t('leftPanel.editProject'), icon: 'settings-3' as const, onClick: () => {} },
              { label: t('leftPanel.newSession'), icon: 'add' as const, onClick: async () => {
                const result = await createSession({ project_id: project.id })
                if (result) { setRenamingId(result.id); setRenameValue(result.id) }
              }},
              'separator' as const,
              { label: t('leftPanel.delete'), icon: 'delete-bin' as const, onClick: async () => {
                if (!window.confirm(t('leftPanel.confirmDelete'))) return
                await deleteProject(project.id)
              }, destructive: true },
            ]}
            t={t}
          />
        )
      })}
    </TreeContainer>
  )
}

function GroupNode({
  id, label, icon, iconColor, isCollapsed, onToggle,
  sessions, expandedGroups, toggleGroupExpand, renderSessionNode,
  projectId, onCreateSession, onDropSession,
  projectActions, projectContextItems, t,
}: {
  id: string; label: string; icon: string; iconColor?: string
  isCollapsed: boolean; onToggle: () => void
  sessions: any[]; expandedGroups: Set<string>; toggleGroupExpand: (k: string) => void
  renderSessionNode: (s: any) => TreeNodeBase
  projectId: string | null; onCreateSession: () => void; onDropSession: (sid: string) => void
  projectActions?: TreeAction[]; projectContextItems?: any[]
  t: any
}) {
  const expandKey = projectId ? `project:${projectId}` : `group:__none__`
  const isExpanded = expandedGroups.has(expandKey)
  const visibleSessions = isExpanded ? sessions : sessions.slice(0, MAX_VISIBLE_SESSIONS)
  const remaining = sessions.length - visibleSessions.length

  const actions = projectActions ?? [
    { id: 'new-session', icon: 'add' as const, title: t('leftPanel.newSession'), onClick: onCreateSession },
  ]

  const groupNode: TreeNodeBase = {
    id: `group:${id}`,
    label,
    icon: icon,
    iconColor,
    iconSize: 'md',
    isExpanded: !isCollapsed,
    hasChildren: true,
    onToggle,
    count: sessions.length,
    actions,
    contextItems: projectContextItems,
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' },
    onDrop: (e) => {
      e.preventDefault()
      const sid = e.dataTransfer.getData('text/plain')
      if (sid) onDropSession(sid)
    },
  }

  return (
    <div>
      <TreeNode {...groupNode} />
      {!isCollapsed && (
        <TreeChildren
          totalCount={sessions.length}
          maxVisible={MAX_VISIBLE_SESSIONS}
          expanded={isExpanded}
          showMoreLabel={t('leftPanel.showMore', { count: String(remaining) })}
          collapseLabel={t('leftPanel.showFewer')}
          onShowMore={remaining > 0 ? () => toggleGroupExpand(expandKey) : undefined}
          onCollapse={isExpanded ? () => toggleGroupExpand(expandKey) : undefined}
          emptyText={t('leftPanel.noSessions')}
        >
          {visibleSessions.map((s) => <TreeNode key={s.id} {...renderSessionNode(s)} />)}
        </TreeChildren>
      )}
    </div>
  )
}

// ---- Debug: Files tab using TreeNode ----

function DebugFilesTab() {
  const { t } = useI18n()
  const { projects, loadProjects } = useProjectsStore()
  const { treesByProject, loadFileTree, loadSubDirectory, expandedProjects, toggleProjectExpand } = useFilesStore()
  const { openTab, centerTabs, activeCenterTabId } = useUIStore()
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  useEffect(() => { loadProjects() }, [loadProjects])

  const workspacedProjects = useMemo(() => projects.filter((p) => p.workspace), [projects])

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

  useEffect(() => {
    workspacedProjects.forEach((p) => {
      if (expandedProjects.has(p.id) && !treesByProject[p.id]) loadFileTree(p.id)
    })
  }, [workspacedProjects, expandedProjects, treesByProject, loadFileTree])

  const toggleDir = (projectId: string, dirPath: string) => {
    const key = `${projectId}/${dirPath}`
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key); loadSubDirectory(projectId, dirPath) }
      return next
    })
  }

  const fileIconName = (name: string): 'file-text' | 'file-code' | 'image' | 'file-music' => {
    if (/\.(tsx?|jsx?|py|rs|go|java|rb|php|swift|kt)$/i.test(name)) return 'file-code'
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)) return 'image'
    if (/\.(mp3|wav|ogg|flac)$/i.test(name)) return 'file-music'
    return 'file-text'
  }

  const fileSize = (size: number) => size > 1024 ? `${(size / 1024).toFixed(1)}k` : `${size}b`

  const renderEntry = (projectId: string, entry: any, depth: number): TreeNodeBase => {
    const isDir = entry.isDirectory
    const dirKey = `${projectId}/${entry.path}`
    const isExpanded = expandedDirs.has(dirKey)

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
      draggable: true,
      onDragStart: (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ projectId, path: entry.path })); e.dataTransfer.effectAllowed = 'move' },
      onClick: () => {
        if (isDir) { toggleDir(projectId, entry.path) } else {
          openTab({ id: `file-${projectId}/${entry.path}`, type: 'file-viewer', title: entry.name, data: { filePath: entry.path, projectId } })
        }
      },
      contextItems: [
        { label: t('file.download'), icon: 'download', onClick: () => {
          const url = synthApi.downloadFile(projectId, entry.path)
          const a = document.createElement('a'); a.href = url; a.download = entry.name; document.body.appendChild(a); a.click(); document.body.removeChild(a)
        }},
        'separator' as const,
        { label: t('files.rename'), icon: 'pencil-ai', onClick: () => {} },
        { label: t('common.delete'), icon: 'delete-bin', onClick: async () => {
          if (!window.confirm(t('file.confirmDelete', { name: entry.name }))) return
          await useFilesStore.getState().deleteEntry(projectId, entry.path)
        }, destructive: true },
      ],
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
      {workspacedProjects.map((project) => {
        const isExpanded = expandedProjects.has(project.id)
        const entries = treesByProject[project.id] || []

        return (
          <div key={project.id}>
            <TreeNode
              id={`file-project:${project.id}`}
              label={project.name}
              icon={project.icon || 'folder-3'}
              iconColor={project.color ? PROJECT_COLOR_MAP[project.color] : undefined}
              iconSize="md"
              isExpanded={isExpanded}
              hasChildren={true}
              onToggle={() => toggleProjectExpand(project.id)}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
            />
            {isExpanded && (
              <TreeChildren
                indent
                totalCount={entries.length}
                emptyText={t('leftPanel.emptyDirectory')}
              >
                <div className="flex items-center gap-1 px-2 py-0.5">
                  <Icon name="folder-3" className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                  <span className="text-[11px] text-muted-foreground/60 truncate">{project.workspace || ''}</span>
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
      })}
    </TreeContainer>
  )
}

// ---- Debug: Git tab using TreeNode ----

function DebugGitTab() {
  const { t } = useI18n()
  const { projects, loadProjects } = useProjectsStore()
  const { reposByProject, commitsByRepo, expandedProjects, expandedRepos, loadRepos, loadCommitLog, toggleProjectExpand, toggleRepoExpand } = useGitStore()
  const { openTab, activeCenterTabId, centerTabs } = useUIStore()
  const [commitShowMore, setCommitShowMore] = useState<Record<string, boolean>>({})

  useEffect(() => { loadProjects() }, [loadProjects])

  const workspacedProjects = useMemo(() => projects.filter((p) => p.workspace), [projects])

  useEffect(() => {
    for (const p of workspacedProjects) {
      if (!reposByProject[p.id] && p.repos) loadRepos(p.id, p.repos)
    }
  }, [workspacedProjects, reposByProject, loadRepos])

  const commitTabOpenSet = useMemo(() => {
    const set = new Set<string>()
    for (const tab of (centerTabs ?? [])) {
      if (tab.type === 'commit-detail' && tab.data?.projectId && tab.data?.repoPath && tab.data?.commitHash) {
        set.add(`${tab.data.projectId}::${tab.data.repoPath}::${tab.data.commitHash}`)
      }
    }
    return set
  }, [centerTabs])

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
    <TreeContainer>
      {workspacedProjects.map((project) => {
        const repos = reposByProject[project.id] || []
        const isExpanded = expandedProjects.has(project.id)

        return (
          <div key={project.id}>
            <TreeNode
              id={`git-project:${project.id}`}
              label={project.name}
              icon={project.icon ? PROJECT_ICON_MAP[project.icon] : 'folder-3'}
              iconColor={project.color ? PROJECT_COLOR_MAP[project.color] : undefined}
              iconSize="md"
              isExpanded={isExpanded}
              hasChildren={repos.length > 0 ? true : undefined}
              onToggle={() => toggleProjectExpand(project.id)}
              count={repos.length > 0 ? repos.length : undefined}
            />
            {isExpanded && (
              <TreeChildren indent totalCount={repos.length} emptyText={t('leftPanel.noRepos')}>
                {repos.length === 0 && <></>}
                {repos.map((repo: any) => {
                  const repoName = repo.path || '.'
                  const rkey = `${project.id}::${repo.path}`
                  const isRepoExpanded = expandedRepos.has(rkey)
                  const commits = commitsByRepo[rkey] || []

                  return (
                    <div key={rkey}>
                      <TreeNode
                        id={`repo:${rkey}`}
                        label={repoName === '.' ? t('git.workspaceRoot') : repoName}
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
                          { id: 'refresh', icon: 'refresh', title: t('git.refresh'), onClick: () => loadCommitLog(project.id, repo.path) },
                        ]}
                        subtitle={repo.lastCommitSubject?.slice(0, 30)}
                      />
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
      })}
    </TreeContainer>
  )
}

// ---- LeftPanelDebug ----

export const LeftPanelDebug: React.FC = () => {
  const { t } = useI18n()
  const { leftPanelTab, setLeftPanelTab } = useUIStore()
  const [splitPercent, setSplitPercent] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const y = ev.clientY - rect.top
      const pct = Math.max(20, Math.min(80, (y / rect.height) * 100))
      setSplitPercent(pct)
    }

    const onUp = () => {
      dragging.current = false
      el.releasePointerCapture(e.pointerId)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [])

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      {/* Tab selector */}
      <div className="flex h-8 shrink-0 items-center justify-center px-2">
        <div className="inline-flex rounded-lg border border-sidebar-border overflow-hidden">
          {LEFT_TABS.map((tab) => {
            const active = leftPanelTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setLeftPanelTab(tab.id)}
                title={t(tab.labelKey)}
                className={`flex items-center justify-center gap-1.5 px-3 py-1 text-xs transition-colors
                  border-r border-sidebar-border last:border-r-0 flex-1 min-w-0 max-w-[150px]
                  ${active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
                `}
              >
                <Icon name={tab.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t(tab.labelKey)}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Top half: old implementation */}
      <div style={{ height: `${splitPercent}%` }} className="overflow-auto border-b-2 border-orange-500 shrink-0">
        <div className="px-1 py-0.5 text-[10px] text-orange-400 font-medium text-right sticky top-0 bg-sidebar/80 backdrop-blur-sm z-10">
          OLD
        </div>
        {leftPanelTab === 'projects' && <ProjectsTab />}
        {leftPanelTab === 'files' && <FilesTab />}
        {leftPanelTab === 'git' && <GitTab />}
      </div>

      {/* Resize handle */}
      <div
        className="h-1.5 bg-orange-500/30 hover:bg-orange-500 cursor-row-resize shrink-0 transition-colors flex items-center justify-center group"
        onPointerDown={onPointerDown}
      >
        <div className="w-6 h-0.5 rounded-full bg-orange-500/50 group-hover:bg-orange-500 transition-colors" />
      </div>

      {/* Bottom half: new implementation */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="px-1 py-0.5 text-[10px] text-green-400 font-medium text-right sticky top-0 bg-sidebar/80 backdrop-blur-sm z-10">
          NEW
        </div>
        {leftPanelTab === 'projects' && <DebugProjectsTab />}
        {leftPanelTab === 'files' && <DebugFilesTab />}
        {leftPanelTab === 'git' && <DebugGitTab />}
      </div>
    </div>
  )
}
