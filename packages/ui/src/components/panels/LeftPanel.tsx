import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useFilesStore } from '@/stores/filesStore'
import { useGitStore } from '@/stores/gitStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useAdaptiveIcons } from '@/hooks/useAdaptiveIcons'
import { synthApi } from '@/lib/api/synthApi'
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta'
import { formatRelativeTime, parseISODate } from '@/lib/formatDate'
import { TreeNode, TreeChildren, TreeContainer } from '@/components/tree'
import type { TreeNodeBase, TreeAction } from '@/components/tree'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ConfirmDialog, type ConfirmVariant } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'

const LEFT_TABS = [
  { id: 'projects' as const, icon: 'folder-3' as const, labelKey: 'leftPanel.tab.projects' },
  { id: 'files' as const, icon: 'file-text' as const, labelKey: 'leftPanel.tab.files' },
  { id: 'git' as const, icon: 'git-branch' as const, labelKey: 'leftPanel.tab.git' },
]

const MAX_VISIBLE_SESSIONS = 5
const MAX_VISIBLE_COMMITS = 10

type ConfirmAction = {
  title: string
  message?: string
  variant: ConfirmVariant
  onConfirm: () => void
}

function useAutoScroll(targetId: string | null) {
  const pendingRef = useRef<string | null>(null)

  useEffect(() => {
    pendingRef.current = targetId
  }, [targetId])

  useEffect(() => {
    const id = pendingRef.current
    if (!id) return
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-tree-node="${CSS.escape(id)}"]`)
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        pendingRef.current = null
      }
    }, 80)
    return () => clearTimeout(timer)
  }, [])
}

// ---- Projects tab ----

function ProjectsTab() {
  const { t } = useI18n()
  const { projects, loadProjects, deleteProject } = useProjectsStore()
  const { sessions, loadSessions, createSession, forkSession, deleteSession, moveSession } = useSessionsStore()
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapse = useUIStore((s) => s.toggleProjectCollapse)
  const openTab = useUIStore((s) => s.openTab)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const forwardMode = useUIStore((s) => s.forwardMode)
  const { sortMode, selectionMode, selectedIds, toggleSelected } = useSessionsTreeStore()
  const streamingBySession = useChatStore((s) => s.streamingBySession)
  const queueBySession = useChatStore((s) => s.queueBySession)
  const sessionUnread = useNotificationStore((s) => s.sessionUnread)
  const clearSessionUnread = useNotificationStore((s) => s.clearSessionUnread)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editingProject, setEditingProject] = useState<any>(null)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const pendingDeleteRef = useRef<Set<string>>(new Set())
  const [forwardTarget, setForwardTarget] = useState<{ sessionId: string; sessionName: string } | null>(null)
  const [summarizeChecked, setSummarizeChecked] = useState(false)

  // Switch to Projects tab when forward mode activates
  useEffect(() => {
    if (forwardMode.active) {
      useUIStore.getState().setLeftPanelTab('projects')
    }
  }, [forwardMode.active])

  useEffect(() => { loadProjects(); loadSessions() }, [loadProjects, loadSessions])

  useEffect(() => {
    if (projects.length === 0) return
    const validIds = new Set(projects.map((p) => p.id))
    validIds.add('__none__')
    const next = new Set([...collapsedProjects].filter((id) => validIds.has(id)))
    if (next.size !== collapsedProjects.size) {
      useUIStore.setState({ collapsedProjects: next })
    }
  }, [projects])

  const sessionsByProject = useMemo(() => {
    const map: Record<string, any[]> = {}
    const sortFn = sortMode === 'date'
      ? (a: any, b: any) => parseISODate(b.updated_at).getTime() - parseISODate(a.updated_at).getTime()
      : (a: any, b: any) => a.id.localeCompare(b.id)
    const seen = new Set<string>()
    map['__none__'] = []
    for (const s of sessions) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      const pid = s.project_id || '__none__'
      if (!map[pid]) map[pid] = []
      map[pid].push(s)
    }
    for (const pid of Object.keys(map)) map[pid].sort(sortFn)
    return map
  }, [sessions, sortMode])

  const childrenByParentId = useMemo(() => {
    const map: Record<string, any[]> = {}
    for (const s of sessions) {
      if (s.parent_id && s.session_origin === 'subagent') {
        if (!map[s.parent_id]) map[s.parent_id] = []
        map[s.parent_id].push(s)
      }
    }
    return map
  }, [sessions])

  const toggleSessionExpand = useCallback((sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

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

  const scrollTarget = useMemo(() => {
    if (!activeCenterTabId?.startsWith('chat-')) return null
    return `session:${activeCenterTabId.replace('chat-', '')}`
  }, [activeCenterTabId])

  useAutoScroll(scrollTarget)

  useEffect(() => {
    if (!activeCenterTabId?.startsWith('chat-')) return
    const sessionId = activeCenterTabId.replace('chat-', '')
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return
    const pid = session.project_id || '__none__'
    const { collapsedProjects: cp, toggleProjectCollapse: tpc } = useUIStore.getState()
    if (cp.has(pid)) {
      // Use getState() to avoid re-render cascade — the toggle is purely visual
      tpc(pid)
    }
  }, [activeCenterTabId])

  const handleProjectSave = async () => {
    if (!editingProject) return
    await synthApi.updateProject(editingProject.id, {
      name: editingProject.name,
      description: editingProject.description,
      icon: editingProject.icon,
      color: editingProject.color,
    })
    setEditingProject(null)
    loadProjects()
  }

  const renderSessionNode = (session: any, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void): TreeNodeBase => {
    const isSubagent = session.session_origin === 'subagent'
    const isForwardSource = forwardMode.active && session.id === forwardMode.sourceSessionId
    const isForwardTarget = forwardMode.active && !isForwardSource
    return {
      id: `session:${session.id}`,
      label: session.name || session.id,
      depth,
      icon: isSubagent ? 'cpu' : 'chat-new',
      subtitle: formatRelativeTime(session.updated_at),
      isSelected: selectedIds.has(session.id),
      isTabOpen: sessionTabOpenSet.has(session.id),
      isActive: activeCenterTabId === `chat-${session.id}`,
      selectionMode,
      status: getSessionStatus(session.id),
      unreadCount: sessionUnread[session.id] || 0,
      hasChildren: hasChildren || undefined,
      isExpanded: hasChildren ? isExpanded : undefined,
      onToggle: hasChildren ? onToggle : undefined,
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
      className: cn(
        isForwardSource && 'opacity-40 pointer-events-none',
        isForwardTarget && 'cursor-pointer hover:bg-primary/10',
      ),
      contextItems: [
        { label: t('leftPanel.rename'), icon: 'pencil-ai', onClick: () => { setRenamingId(session.id); setRenameValue(session.name || session.id) } },
        { label: t('leftPanel.forkSession'), icon: 'git-branch', onClick: async () => {
          const result = await forkSession(session.id)
          if (result) {
            openTab({ id: `chat-${result.id}`, type: 'chat', title: result.name || result.id, data: { sessionId: result.id, projectId: result.project_id || undefined } })
          }
        }},
        { label: t('leftPanel.clearSession'), icon: 'close', onClick: () => setConfirm({
          title: t('leftPanel.clearSession'),
          message: t('leftPanel.confirmClearSession'),
          variant: 'warning',
          onConfirm: async () => {
            await synthApi.clearSession(session.id)
            useChatStore.getState().clearSession(session.id)
            const result = await synthApi.getSessionMessages(session.id)
            useChatStore.getState().setMessages(session.id, result.messages)
          },
        })},
        'separator' as const,
        { label: t('leftPanel.delete'), icon: 'delete-bin', onClick: () => {
          pendingDeleteRef.current.add(session.id)
          setConfirm({
            title: t('leftPanel.delete'),
            message: t('leftPanel.confirmDeleteSession'),
            variant: 'danger',
            onConfirm: async () => {
              useUIStore.getState().closeTab(`chat-${session.id}`)
              await deleteSession(session.id)
              pendingDeleteRef.current.delete(session.id)
            },
          })
        }, destructive: true },
      ],
      onClick: () => {
        if (forwardMode.active && !isForwardSource) {
          setForwardTarget({ sessionId: session.id, sessionName: session.name || session.id })
          return
        }
        if (isForwardSource) return
        if (selectionMode) { toggleSelected(session.id); return }
        if (pendingDeleteRef.current.has(session.id)) return
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
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        variant={confirm?.variant ?? 'danger'}
        onConfirm={() => { confirm?.onConfirm(); setConfirm(null) }}
      />

      {forwardTarget && (
        <Dialog open={!!forwardTarget} onOpenChange={(open) => { if (!open) { setForwardTarget(null); setSummarizeChecked(false) } }}>
          <DialogContent className="max-w-sm p-4 gap-3" showCloseButton={true}>
            <h3 className="text-sm font-semibold">
              Куда вставить{forwardMode.mode === 'merge' ? ' ссылку' : ' сообщения'}?
            </h3>
            <p className="text-xs text-muted-foreground">Сессия: {forwardTarget.sessionName}</p>
            {forwardMode.mode === 'merge' && (
              <label className="flex items-center gap-2 text-sm cursor-pointer px-3 py-1">
                <input type="checkbox" checked={summarizeChecked} onChange={e => setSummarizeChecked(e.target.checked)} />
                Суммаризировать
              </label>
            )}
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => {
                  useUIStore.getState().forwardConfirmAction?.(forwardTarget.sessionId, 'before', summarizeChecked)
                  setForwardTarget(null)
                  setSummarizeChecked(false)
                }}
                className="w-full text-left px-3 py-2 rounded text-sm hover:bg-accent"
              >
                Вставить в начало
              </button>
              <button
                onClick={() => {
                  useUIStore.getState().forwardConfirmAction?.(forwardTarget.sessionId, 'after', summarizeChecked)
                  setForwardTarget(null)
                  setSummarizeChecked(false)
                }}
                className="w-full text-left px-3 py-2 rounded text-sm hover:bg-accent"
              >
                Вставить в конец
              </button>
              <button
                onClick={() => setForwardTarget(null)}
                className="w-full text-left px-3 py-2 rounded text-sm hover:bg-accent"
              >
                Выбрать другую сессию
              </button>
              <div className="border-t my-1" />
              <button
                onClick={() => {
                  useUIStore.getState().cancelForwardMode()
                  setForwardTarget(null)
                  setSummarizeChecked(false)
                }}
                className="w-full text-left px-3 py-2 rounded text-sm text-destructive hover:bg-destructive/10"
              >
                Отменить
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {editingProject && (
        <Popover open={!!editingProject} onOpenChange={(open) => { if (!open) setEditingProject(null) }}>
          <PopoverTrigger asChild>
            <span className="absolute opacity-0 pointer-events-none" />
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" sideOffset={4} className="w-72 p-3 space-y-2">
            <div>
              <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('project.name')}</label>
              <input
                type="text"
                value={editingProject.name || ''}
                onChange={(e) => setEditingProject((prev: any) => ({ ...prev, name: e.target.value }))}
                className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[0.65rem] text-muted-foreground mb-0.5">{t('project.description')}</label>
              <input
                type="text"
                value={editingProject.description || ''}
                onChange={(e) => setEditingProject((prev: any) => ({ ...prev, description: e.target.value }))}
                className="w-full rounded bg-interactive px-2 py-1.5 text-xs text-foreground outline-none"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={handleProjectSave} className="flex-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors">{t('project.save')}</button>
              <button onClick={() => setEditingProject(null)} className="flex-1 rounded bg-interactive px-3 py-1.5 text-xs text-foreground hover:bg-interactive-hover transition-colors">{t('common.cancel')}</button>
            </div>
          </PopoverContent>
        </Popover>
      )}

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
        childrenByParentId={childrenByParentId}
        expandedSessions={expandedSessions}
        toggleSessionExpand={toggleSessionExpand}
        projectId={null}
        onCreateSession={async () => {
          const uiState = useUIStore.getState()
          if (uiState.collapsedProjects.has('__none__')) uiState.toggleProjectCollapse('__none__')
          const result = await createSession({ project_id: null })
          if (result) openTab({ id: 'chat-' + result.id, type: 'chat', title: result.name || result.id, data: { sessionId: result.id, projectId: result.project_id || undefined } })
        }}
        onDropSession={async (sessionId) => { await moveSession(sessionId, null) }}
        t={t}
      />

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
            childrenByParentId={childrenByParentId}
            expandedSessions={expandedSessions}
            toggleSessionExpand={toggleSessionExpand}
            projectId={project.id}
            onCreateSession={async () => {
              const uiState = useUIStore.getState()
              if (uiState.collapsedProjects.has(project.id)) uiState.toggleProjectCollapse(project.id)
              const result = await createSession({ project_id: project.id })
              if (result) openTab({ id: 'chat-' + result.id, type: 'chat', title: result.name || result.id, data: { sessionId: result.id, projectId: result.project_id || undefined } })
            }}
            onDropSession={async (sessionId) => { await moveSession(sessionId, project.id) }}
            projectActions={[
              { id: 'new-session', icon: 'add' as const, title: t('leftPanel.newSession'), onClick: async () => {
                const result = await createSession({ project_id: project.id })
                if (result) openTab({ id: 'chat-' + result.id, type: 'chat', title: result.name || result.id, data: { sessionId: result.id, projectId: result.project_id || undefined } })
              }},
            ]}
            projectContextItems={[
              { label: t('leftPanel.editProject'), icon: 'settings-3' as const, onClick: () => { setEditingProject({ ...project }) } },
              { label: t('leftPanel.newSession'), icon: 'add' as const, onClick: async () => {
                const result = await createSession({ project_id: project.id })
                if (result) openTab({ id: 'chat-' + result.id, type: 'chat', title: result.name || result.id, data: { sessionId: result.id, projectId: result.project_id || undefined } })
              }},
              'separator' as const,
              { label: t('leftPanel.delete'), icon: 'delete-bin' as const, onClick: () => setConfirm({
                title: t('leftPanel.delete'),
                message: t('leftPanel.confirmDelete'),
                variant: 'danger',
                onConfirm: async () => { await deleteProject(project.id) },
              }), destructive: true },
            ]}
            t={t}
          />
        )
      })}
    </TreeContainer>
  )
}

function SessionTreeItem({
  session,
  depth,
  childrenByParentId,
  renderSessionNode,
  expandedSessions,
  onToggleExpand,
}: {
  session: any
  depth: number
  childrenByParentId: Record<string, any[]>
  renderSessionNode: (session: any, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void) => TreeNodeBase
  expandedSessions: Set<string>
  onToggleExpand: (id: string) => void
}) {
  const childSessions = depth < 2 ? (childrenByParentId[session.id] || []) : []
  const hasChildren = childSessions.length > 0
  const isExpanded = expandedSessions.has(session.id)
  const node = renderSessionNode(session, depth, hasChildren, isExpanded, () => onToggleExpand(session.id))

  return (
    <>
      <TreeNode {...node} />
      {hasChildren && isExpanded && (
        <div className="ml-[15px] border-l border-sidebar-border pl-4">
          {childSessions.map((child) => (
            <SessionTreeItem
              key={child.id}
              session={child}
              depth={depth + 1}
              childrenByParentId={childrenByParentId}
              renderSessionNode={renderSessionNode}
              expandedSessions={expandedSessions}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </>
  )
}

function GroupNode({
  id, label, icon, iconColor, isCollapsed, onToggle,
  sessions, childrenByParentId, expandedGroups, toggleGroupExpand, renderSessionNode,
  expandedSessions, toggleSessionExpand,
  projectId, onCreateSession, onDropSession,
  projectActions, projectContextItems, t,
}: {
  id: string; label: string; icon: string; iconColor?: string
  isCollapsed: boolean; onToggle: () => void
  sessions: any[]; childrenByParentId: Record<string, any[]>
  expandedGroups: Set<string>; toggleGroupExpand: (k: string) => void
  renderSessionNode: (session: any, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void) => TreeNodeBase
  expandedSessions: Set<string>; toggleSessionExpand: (id: string) => void
  projectId: string | null; onCreateSession: () => void; onDropSession: (sid: string) => void
  projectActions?: TreeAction[]; projectContextItems?: any[]
  t: any
}) {
  const expandKey = projectId ? `project:${projectId}` : `group:__none__`
  const isExpanded = expandedGroups.has(expandKey)
  const rootSessions = sessions.filter((s) => s.session_origin !== 'subagent')
  const visibleSessions = isExpanded ? rootSessions : rootSessions.slice(0, MAX_VISIBLE_SESSIONS)
  const remaining = rootSessions.length - visibleSessions.length
  const totalCount = sessions.length

  const actions = projectActions ?? [
    { id: 'new-session', icon: 'add' as const, title: t('leftPanel.newSession'), onClick: onCreateSession },
  ]

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const sid = e.dataTransfer.getData('text/plain')
    if (sid) onDropSession(sid)
  }, [onDropSession])

  const groupNode: TreeNodeBase = {
    id: `group:${id}`,
    label,
    icon: icon,
    iconColor,
    iconSize: 'md',
    isExpanded: !isCollapsed,
    hasChildren: true,
    onToggle,
    count: totalCount,
    actions,
    contextItems: projectContextItems,
  }

  return (
    <div onDragOver={handleDragOver} onDrop={handleDrop}>
      <TreeNode {...groupNode} />
      {!isCollapsed && (
        <TreeChildren
          totalCount={totalCount}
          maxVisible={MAX_VISIBLE_SESSIONS}
          expanded={isExpanded}
          showMoreLabel={t('leftPanel.showMore', { count: String(remaining) })}
          collapseLabel={t('leftPanel.showFewer')}
          onShowMore={remaining > 0 ? () => toggleGroupExpand(expandKey) : undefined}
          onCollapse={isExpanded ? () => toggleGroupExpand(expandKey) : undefined}
          emptyText={t('leftPanel.noSessions')}
        >
          {visibleSessions.map((s) => (
            <SessionTreeItem
              key={s.id}
              session={s}
              depth={1}
              childrenByParentId={childrenByParentId}
              renderSessionNode={renderSessionNode}
              expandedSessions={expandedSessions}
              onToggleExpand={toggleSessionExpand}
            />
          ))}
        </TreeChildren>
      )}
    </div>
  )
}

// ---- Files tab ----

function FilesTab() {
  const { t } = useI18n()
  const { projects, loadProjects } = useProjectsStore()
  const { treesByProject, loadFileTree, loadSubDirectory, expandedProjects, expandedDirs, toggleProjectExpand, toggleDirExpand, createFile, createDirectory, moveEntry, deleteEntry, uploadFile } = useFilesStore()
  const openTab = useUIStore((s) => s.openTab)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
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
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const pendingDeleteRef = useRef<Set<string>>(new Set())
  const [dragState, setDragState] = useState<{ projectId: string; path: string } | null>(null)

  useEffect(() => { loadProjects() }, [loadProjects])

  const workspacedProjects = useMemo(() => projects.filter((p) => p.workspace), [projects])

  const projectDirPaths = useMemo(() => {
    if (!moveTarget) return []
    const pid = moveTarget.projectId
    const prefix = `${pid}/`
    const dirs = new Set<string>()
    for (const [key, entries] of Object.entries(treesByProject)) {
      if (key === pid || key.startsWith(prefix)) {
        for (const e of entries) {
          if (e.isDirectory) dirs.add(e.path)
        }
      }
      if (key.startsWith(prefix)) {
        dirs.add(key.slice(prefix.length))
      }
    }
    const src = moveTarget.entry.path
    dirs.delete(src)
    for (const d of [...dirs]) {
      if (d.startsWith(`${src}/`)) dirs.delete(d)
    }
    return [...dirs].sort((a, b) => a.localeCompare(b))
  }, [treesByProject, moveTarget])

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
    await moveEntry(projectId, entry.path, targetPath)
    const oldTabId = `file-${projectId}/${entry.path}`
    const ui = useUIStore.getState()
    const existing = ui.centerTabs.find((tab) => tab.id === oldTabId)
    if (existing) {
      ui.closeTab(oldTabId)
      ui.openTab({ id: `file-${projectId}/${targetPath}`, type: 'file-viewer', title: newName, data: { filePath: targetPath, projectId } })
    }
    setRenamingPath(null)
    setRenamingProject(null)
    setRenamingEntry(null)
  }

  const openMoveDialog = (projectId: string, entry: any) => {
    setMoveTarget({ projectId, entry })
    setMoveDest('')
  }

  const handleMoveSubmit = async () => {
    if (!moveTarget) return
    const { projectId, entry } = moveTarget
    const dest = moveDest.trim().replace(/\/+$/, '')
    const name = entry.path.split('/').pop() || entry.name
    const targetPath = dest ? `${dest}/${name}` : name
    if (targetPath !== entry.path) {
      await moveEntry(projectId, entry.path, targetPath)
      const oldTabId = `file-${projectId}/${entry.path}`
      const ui = useUIStore.getState()
      const existing = ui.centerTabs.find((tab) => tab.id === oldTabId)
      if (existing) {
        ui.closeTab(oldTabId)
        ui.openTab({ id: `file-${projectId}/${targetPath}`, type: 'file-viewer', title: name, data: { filePath: targetPath, projectId } })
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
      const ui = useUIStore.getState()
      if (srcProject === targetProjectId) {
        await moveEntry(targetProjectId, srcPath, targetPath)
        const oldTabId = `file-${targetProjectId}/${srcPath}`
        const newTabId = `file-${targetProjectId}/${targetPath}`
        const existing = ui.centerTabs.find((t) => t.id === oldTabId)
        if (existing) {
          ui.closeTab(oldTabId)
          ui.openTab({ id: newTabId, type: 'file-viewer', title: name, data: { filePath: targetPath, projectId: targetProjectId } })
        }
      } else {
        const { content } = await synthApi.readFile(srcProject, srcPath)
        await synthApi.writeFile(targetProjectId, targetPath, content)
        await deleteEntry(srcProject, srcPath)
        const oldTabId = `file-${srcProject}/${srcPath}`
        if (ui.centerTabs.some((t) => t.id === oldTabId)) {
          ui.closeTab(oldTabId)
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
      const { content } = await synthApi.readFile(srcProject, srcPath)
      await synthApi.writeFile(targetProjectId, name, content)
      await deleteEntry(srcProject, srcPath)
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
    }

    const entryContextItems: any[] = [
      ...(isDir ? [] : [
        { label: t('file.download'), icon: 'download' as const, onClick: () => {
          const url = synthApi.downloadFile(projectId, entry.path)
          const a = document.createElement('a'); a.href = url; a.download = entry.name; document.body.appendChild(a); a.click(); document.body.removeChild(a)
        }},
      ] as any),
      'separator' as const,
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
      draggable: true,
      isRenaming,
      renameValue: isRenaming ? renameValue : '',
      onRenameChange: setRenameValue,
      onRenameCommit: () => handleRenameSubmit(projectId, entry),
      onRenameCancel: () => { setRenamingPath(null); setRenamingProject(null); setRenamingEntry(null) },
      onDragStart: (e) => handleFileDragStart(e, projectId, entry),
      onDragOver: isDir ? handleFileDragOver : undefined,
      onDrop: isDir ? (e: React.DragEvent) => handleDropOnDir(e, projectId, entry.path) : undefined,
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
            {projectDirPaths.length > 0 && (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {projectDirPaths.map((dir) => (
                  <button
                    key={dir}
                    onClick={() => setMoveDest(dir === moveDest ? '' : dir)}
                    className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-accent flex items-center gap-1.5 ${dir === moveDest ? 'bg-accent' : ''}`}
                  >
                    <Icon name="folder" className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{dir}</span>
                  </button>
                ))}
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
              onDragOver={handleFileDragOver}
              onDrop={(e) => handleDropOnProject(e, project.id)}
              actions={[
                { id: 'upload', icon: 'upload', title: t('file.upload'), onClick: () => handleUpload(project.id) },
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

// ---- Git tab ----

type AddRepoMode = 'scan' | 'clone' | 'init' | null

function GitTab() {
  const { t } = useI18n()
  const { projects, loadProjects } = useProjectsStore()
  const { reposByProject, commitsByRepo, expandedProjects, expandedRepos, loadRepos, loadCommitLog, toggleProjectExpand, toggleRepoExpand, initRepo } = useGitStore()
  const openTab = useUIStore((s) => s.openTab)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const [commitShowMore, setCommitShowMore] = useState<Record<string, boolean>>({})
  const [addRepoProjectId, setAddRepoProjectId] = useState<string | null>(null)
  const [popoverMode, setPopoverMode] = useState<AddRepoMode>(null)
  const [scanResults, setScanResults] = useState<{ path: string; currentBranch?: string }[] | null>(null)
  const [scanSelected, setScanSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [clonePath, setClonePath] = useState('')
  const [cloneBranch, setCloneBranch] = useState('')
  const [initPath, setInitPath] = useState('')
  const [initBranch, setInitBranch] = useState('main')
  const [actionError, setActionError] = useState<string | null>(null)
  const projectRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => { loadProjects() }, [loadProjects])

  const workspacedProjects = useMemo(() => projects.filter((p) => p.workspace), [projects])

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
      setAddRepoProjectId(projectId)
      setPopoverMode('clone')
      setScanResults(null)
      setActionError(null)
    }
  }

  const closePopover = () => {
    setAddRepoProjectId(null)
    setPopoverMode(null)
    setScanResults(null)
    setScanSelected(new Set())
    setScanning(false)
    setCloneUrl('')
    setClonePath('')
    setCloneBranch('')
    setInitPath('')
    setInitBranch('main')
    setActionError(null)
  }

  const handleDoScan = async (projectId: string) => {
    setScanning(true)
    setActionError(null)
    try {
      const result = await synthApi.scanGitRepos(projectId)
      const known = new Set((reposByProject[projectId] || []).map((r: any) => r.path))
      setScanResults(result.repos.filter((r: { path: string }) => !known.has(r.path)))
    } catch {
      setActionError(t('common.error'))
    } finally {
      setScanning(false)
    }
  }

  const handleAddScanned = async (projectId: string) => {
    if (scanSelected.size === 0) return
    const reposToAdd = scanResults?.filter((r) => scanSelected.has(r.path)) ?? []
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const currentRepos = (project.repos || []).map((r: any) => (typeof r === 'string' ? r : r.path))
    const newRepos = reposToAdd.map((r) => (typeof r === 'string' ? r : r.path))
    await synthApi.updateProject(projectId, { repos: [...currentRepos, ...newRepos] })
    await loadProjects()
    closePopover()
  }

  const handleDoClone = async (projectId: string) => {
    if (!cloneUrl) return
    setActionError(null)
    try {
      await synthApi.cloneGitRepo(projectId, cloneUrl, clonePath || undefined, cloneBranch || undefined)
      await loadProjects()
      closePopover()
    } catch {
      setActionError(t('common.error'))
    }
  }

  const handleDoInit = async (projectId: string) => {
    setActionError(null)
    try {
      await initRepo(projectId, initPath || '.', initBranch)
      await loadProjects()
      closePopover()
    } catch {
      setActionError(t('common.error'))
    }
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
    <TreeContainer>
      {workspacedProjects.map((project) => {
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
                  icon={project.icon ? PROJECT_ICON_MAP[project.icon] : 'folder-3'}
                  iconColor={project.color ? PROJECT_COLOR_MAP[project.color] : undefined}
                  iconSize="md"
                  isExpanded={isExpanded}
                  hasChildren={repos.length > 0 ? true : undefined}
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
                      onClick={(e) => { e.stopPropagation(); setPopoverMode(mode.id); setActionError(null) }}
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
                  <p className="text-xs text-destructive mt-2">{actionError}</p>
                )}
              </PopoverContent>
            </Popover>

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

// ---- LeftPanel ----

export const LeftPanel: React.FC = () => {
  const { t } = useI18n()
  const { leftPanelTab, setLeftPanelTab } = useUIStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const iconsOnly = useAdaptiveIcons(containerRef)

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="flex h-8 shrink-0 items-center px-2">
        <div data-tab-row className="flex w-full rounded-lg border border-sidebar-border overflow-hidden">
          {LEFT_TABS.map((tab) => {
            const active = leftPanelTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setLeftPanelTab(tab.id)}
                title={t(tab.labelKey)}
                className={`flex items-center justify-center gap-1.5 py-1 text-xs transition-colors
                  border-r border-sidebar-border last:border-r-0
                  flex-1
                  ${iconsOnly ? 'min-w-0 px-2' : 'min-w-[72px] px-3'}
                  ${active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
                `}
              >
                <Icon name={tab.icon} className="h-3.5 w-3.5 shrink-0" />
                {!iconsOnly && <span data-tab-label className="truncate">{t(tab.labelKey)}</span>}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-col flex-1 overflow-hidden">
        {leftPanelTab === 'projects' && <ProjectsTab />}
        {leftPanelTab === 'files' && <FilesTab />}
        {leftPanelTab === 'git' && <GitTab />}
      </div>
    </div>
  )
}
