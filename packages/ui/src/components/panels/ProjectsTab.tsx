import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { ContextMenu } from '@/components/ui/contextMenu'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { BulkActionBar } from './BulkActionBar'
import { formatRelativeTime, parseISODate } from '@/lib/formatDate'
import { synthApi, type ProjectData, type SessionData } from '@/lib/api/synthApi'

const MAX_VISIBLE_SESSIONS = 5

export const ProjectsTab: React.FC = () => {
  const { t } = useI18n()
  const { projects, loadProjects } = useProjectsStore()
  const { sessions, loadSessions } = useSessionsStore()
  const { collapsedProjects, toggleProjectCollapse } = useUIStore()
  const {
    sortMode,
    selectionMode,
  } = useSessionsTreeStore()

  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<ProjectData | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    loadProjects()
    loadSessions()
  }, [loadProjects, loadSessions])

  const closeMenu = useCallback(() => setOpenMenuKey(null), [])

  const toggleGroupExpand = (groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  const startRename = (sessionId: string, currentName: string) => {
    setRenamingSessionId(sessionId)
    setRenameValue(currentName)
  }

  const commitRename = async () => {
    if (renamingSessionId && renameValue.trim()) {
      const { renameSession, loadSessions } = useSessionsStore.getState()
      await renameSession(renamingSessionId, renameValue.trim())
      await loadSessions()
      useUIStore.getState().updateTabTitle(`chat-${renamingSessionId}`, renameValue.trim())
    }
    setRenamingSessionId(null)
    setRenameValue('')
  }

  const cancelRename = () => {
    setRenamingSessionId(null)
    setRenameValue('')
  }

  const sessionsByProject = React.useMemo(() => {
    const map: Record<string, SessionData[]> = {}
    const sortFn = sortMode === 'date'
      ? (a: SessionData, b: SessionData) => parseISODate(b.updated_at).getTime() - parseISODate(a.updated_at).getTime()
      : (a: SessionData, b: SessionData) => a.id.localeCompare(b.id)
    map['__none__'] = []
    for (const s of sessions) {
      const pid = s.project_id || '__none__'
      if (!map[pid]) map[pid] = []
      map[pid].push(s)
    }
    for (const pid of Object.keys(map)) {
      map[pid].sort(sortFn)
    }
    return map
  }, [sessions, sortMode])

  const sortedProjects = React.useMemo(() => {
    if (sortMode === 'date') return projects
    return [...projects].sort((a, b) => a.name.localeCompare(b.name))
  }, [projects, sortMode])

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDropOnProject = async (e: React.DragEvent, projectId: string | null) => {
    e.preventDefault()
    const sessionId = e.dataTransfer.getData('text/plain')
    if (sessionId) {
      await useSessionsStore.getState().moveSession(sessionId, projectId)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {selectionMode && <BulkActionBar />}

      <div className="flex-1 overflow-y-auto py-1">
        {(() => {
          const noProjectSessions = sessionsByProject['__none__'] || []
          const isCollapsed = collapsedProjects.has('__none__')
          return (
            <GroupSection
              label={t('leftPanel.noProject')}
              labelIcon="chat-new"
              groupKey="__none__"
              isCollapsed={isCollapsed}
              onToggle={() => toggleProjectCollapse('__none__')}
              sessions={noProjectSessions}
              openMenuKey={openMenuKey}
              setOpenMenuKey={setOpenMenuKey}
              closeMenu={closeMenu}
              handleDragStart={handleDragStart}
              onDrop={(e) => handleDropOnProject(e, null)}
              expandedGroups={expandedGroups}
              toggleGroupExpand={toggleGroupExpand}
              onSessionCreated={(sessionId) => { startRename(sessionId, sessionId) }}
              renamingSessionId={renamingSessionId}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
            />
          )
        })()}

        {sortedProjects.map((project) => {
          const isCollapsed = collapsedProjects.has(project.id)
          const projectSessions = sessionsByProject[project.id] || []
          return (
            <ProjectItem
              key={project.id}
              project={project}
              sessions={projectSessions}
              isCollapsed={isCollapsed}
              openMenuKey={openMenuKey}
              setOpenMenuKey={setOpenMenuKey}
              closeMenu={closeMenu}
              handleDragStart={handleDragStart}
              onDrop={handleDropOnProject}
              onEditProject={() => setEditingProject(project)}
              expandedGroups={expandedGroups}
              toggleGroupExpand={toggleGroupExpand}
              onSessionCreated={(sessionId) => { startRename(sessionId, sessionId) }}
              renamingSessionId={renamingSessionId}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
            />
          )
        })}

        {projects.length === 0 && (sessionsByProject['__none__']?.length ?? 0) === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Icon name="folder-3" className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('leftPanel.empty')}</p>
          </div>
        )}
      </div>

      {editingProject && (
        <ProjectEditPopup
          project={editingProject}
          onClose={() => setEditingProject(null)}
        />
      )}
    </div>
  )
}

interface ProjectItemProps {
  project: ProjectData
  sessions: SessionData[]
  isCollapsed: boolean
  openMenuKey: string | null
  setOpenMenuKey: (k: string | null) => void
  closeMenu: () => void
  handleDragStart: (e: React.DragEvent, sessionId: string) => void
  onDrop: (e: React.DragEvent, projectId: string) => void
  onEditProject: () => void
  expandedGroups: Set<string>
  toggleGroupExpand: (key: string) => void
  onSessionCreated: (sessionId: string) => void
  renamingSessionId: string | null
  renameValue: string
  onRenameValueChange: (v: string) => void
  onStartRename: (sessionId: string, currentName: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
}

function ProjectItem({
  project,
  sessions,
  isCollapsed,
  openMenuKey,
  setOpenMenuKey,
  closeMenu,
  handleDragStart,
  onDrop,
  onEditProject,
  expandedGroups,
  toggleGroupExpand,
  onSessionCreated,
  renamingSessionId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: ProjectItemProps) {
  const { t } = useI18n()
  const { deleteProject } = useProjectsStore()
  const { createSession } = useSessionsStore()
  const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : 'folder-3'
  const colorVar = project.color ? PROJECT_COLOR_MAP[project.color] : 'var(--muted-foreground)'
  const menuKey = `project:${project.id}`
  const isMenuOpen = openMenuKey === menuKey
  const isExpanded = expandedGroups.has(`project:${project.id}`)
  const visibleSessions = isExpanded ? sessions : sessions.slice(0, MAX_VISIBLE_SESSIONS)
  const remaining = sessions.length - visibleSessions.length

  const handleDelete = async () => {
    closeMenu()
    if (window.confirm(t('leftPanel.confirmDelete'))) {
      await deleteProject(project.id)
    }
  }

  const handleNewSession = async () => {
    closeMenu()
    const { collapsedProjects: cp, toggleProjectCollapse: tpc } = useUIStore.getState()
    if (cp.has(project.id)) tpc(project.id)
    const result = await createSession({ project_id: project.id })
    if (result) {
      toggleGroupExpand(`project:${project.id}`)
      onSessionCreated(result.id)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  return (
    <div className="group/project" onDragOver={handleDragOver} onDrop={(e) => onDrop(e, project.id)}>
      <div
        className="relative flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition-colors hover:bg-interactive-hover rounded-md mx-1"
        onClick={() => useUIStore.getState().toggleProjectCollapse(project.id)}
      >
        <span className="group-hover/project:hidden h-3.5 w-3.5 flex items-center justify-center text-muted-foreground">
          <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span>
        <span className="group-hover/project:inline-flex hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground">
          <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span>

        <Icon name={iconName} className="h-4 w-4 shrink-0" style={{ color: colorVar }} />
        <span className="truncate text-sm font-medium text-foreground flex-1 min-w-0" title={project.name}>
          {project.name}
        </span>
        <span className="text-xs text-muted-foreground shrink-0 group-hover/project:hidden">{sessions.length}</span>

        <div className={`shrink-0 flex items-center gap-0.5 bg-sidebar rounded ${isMenuOpen ? '' : 'hidden group-hover/project:flex'}`}>
          <button
            onClick={(e) => { e.stopPropagation(); handleNewSession() }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            title={t('leftPanel.newSession')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </button>
          <ContextMenu
            trigger={
              <button
                onClick={(e) => { e.stopPropagation(); setOpenMenuKey(isMenuOpen ? null : menuKey) }}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Icon name="more-2" className="h-3.5 w-3.5" />
              </button>
            }
            items={[
              { label: t('leftPanel.configure'), icon: 'settings-3', onClick: () => { closeMenu(); onEditProject() } },
              { label: t('leftPanel.newSession'), icon: 'add', onClick: handleNewSession },
              'separator',
              { label: t('leftPanel.delete'), icon: 'delete-bin', onClick: handleDelete, destructive: true },
            ]}
            align="end"
          />
        </div>
      </div>

      {!isCollapsed && visibleSessions.length > 0 && (
        <div className="ml-5 border-l border-sidebar-border pl-2">
          {visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              openMenuKey={openMenuKey}
              setOpenMenuKey={setOpenMenuKey}
              closeMenu={closeMenu}
              handleDragStart={handleDragStart}
              renamingSessionId={renamingSessionId}
              renameValue={renameValue}
              onRenameValueChange={onRenameValueChange}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
          {remaining > 0 && !isExpanded && (
            <button
              onClick={() => toggleGroupExpand(`project:${project.id}`)}
              className="mt-0.5 px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:underline text-left"
            >
              {t('leftPanel.showMore', { count: String(remaining) })}
            </button>
          )}
          {isExpanded && sessions.length > MAX_VISIBLE_SESSIONS && (
            <button
              onClick={() => toggleGroupExpand(`project:${project.id}`)}
              className="mt-0.5 px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:underline text-left"
            >
              {t('leftPanel.showFewer')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface GroupSectionProps {
  label: string
  labelIcon: string
  groupKey: string
  isCollapsed: boolean
  onToggle: () => void
  sessions: SessionData[]
  openMenuKey: string | null
  setOpenMenuKey: (k: string | null) => void
  closeMenu: () => void
  handleDragStart: (e: React.DragEvent, sessionId: string) => void
  onDrop: (e: React.DragEvent, projectId: string | null) => void
  expandedGroups: Set<string>
  toggleGroupExpand: (key: string) => void
  onSessionCreated: (sessionId: string) => void
  renamingSessionId: string | null
  renameValue: string
  onRenameValueChange: (v: string) => void
  onStartRename: (sessionId: string, currentName: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
}

function GroupSection({
  label,
  labelIcon,
  groupKey,
  isCollapsed,
  onToggle,
  sessions,
  openMenuKey,
  setOpenMenuKey,
  closeMenu,
  handleDragStart,
  onDrop,
  expandedGroups,
  toggleGroupExpand,
  onSessionCreated,
  renamingSessionId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: GroupSectionProps) {
  const { t } = useI18n()
  const { createSession } = useSessionsStore()
  const menuKey = `group:${groupKey}`
  const isMenuOpen = openMenuKey === menuKey
  const expandKey = `group:${groupKey}`
  const isExpanded = expandedGroups.has(expandKey)
  const visibleSessions = isExpanded ? sessions : sessions.slice(0, MAX_VISIBLE_SESSIONS)
  const remaining = sessions.length - visibleSessions.length

  const handleNewSession = async () => {
    closeMenu()
    const isNoProject = groupKey === '__none__'
    if (!isNoProject) {
      const { collapsedProjects: cp, toggleProjectCollapse: tpc } = useUIStore.getState()
      if (cp.has(groupKey)) tpc(groupKey)
    }
    const result = await createSession({ project_id: isNoProject ? null : groupKey })
    if (result) {
      const expandKey = isNoProject ? 'group:__none__' : `project:${groupKey}`
      if (!expandedGroups.has(expandKey)) toggleGroupExpand(expandKey)
      onSessionCreated(result.id)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  return (
    <div className="group/gh mb-1" onDragOver={handleDragOver} onDrop={(e) => onDrop(e, groupKey === '__none__' ? null : groupKey)}>
      <div
        className="relative flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors hover:bg-interactive-hover rounded-md mx-1"
        onClick={onToggle}
      >
        <span className="group-hover/gh:hidden h-3.5 w-3.5 flex items-center justify-center text-muted-foreground">
          <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span>
        <span className="group-hover/gh:inline-flex hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground">
          <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span>

        <Icon name={labelIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground flex-1 min-w-0" title={label}>{label}</span>
        <span className="text-xs text-muted-foreground shrink-0 group-hover/gh:hidden">{sessions.length}</span>

        <div className={`shrink-0 flex items-center gap-0.5 bg-sidebar rounded ${isMenuOpen ? '' : 'hidden group-hover/gh:flex'}`}>
          <button
            onClick={(e) => { e.stopPropagation(); handleNewSession() }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            title={t('leftPanel.newSession')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </button>
          <ContextMenu
            trigger={
              <button
                onClick={(e) => { e.stopPropagation(); setOpenMenuKey(isMenuOpen ? null : menuKey) }}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Icon name="more-2" className="h-3.5 w-3.5" />
              </button>
            }
            items={[
              { label: t('leftPanel.newSession'), icon: 'add', onClick: handleNewSession },
            ]}
            align="end"
          />
        </div>
      </div>

      {!isCollapsed && (
        <div className="ml-5 border-l border-sidebar-border pl-2">
          {visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              openMenuKey={openMenuKey}
              setOpenMenuKey={setOpenMenuKey}
              closeMenu={closeMenu}
              handleDragStart={handleDragStart}
              renamingSessionId={renamingSessionId}
              renameValue={renameValue}
              onRenameValueChange={onRenameValueChange}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
          {sessions.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t('leftPanel.noSessions')}
            </div>
          )}
          {remaining > 0 && !isExpanded && (
            <button
              onClick={() => toggleGroupExpand(expandKey)}
              className="mt-0.5 px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:underline text-left"
            >
              {t('leftPanel.showMore', { count: String(remaining) })}
            </button>
          )}
          {isExpanded && sessions.length > MAX_VISIBLE_SESSIONS && (
            <button
              onClick={() => toggleGroupExpand(expandKey)}
              className="mt-0.5 px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:underline text-left"
            >
              {t('leftPanel.showFewer')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface SessionItemProps {
  session: SessionData
  openMenuKey: string | null
  setOpenMenuKey: (k: string | null) => void
  closeMenu: () => void
  handleDragStart: (e: React.DragEvent, sessionId: string) => void
  renamingSessionId: string | null
  renameValue: string
  onRenameValueChange: (v: string) => void
  onStartRename: (sessionId: string, currentName: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
}

function SessionItem({
  session,
  openMenuKey,
  setOpenMenuKey,
  closeMenu,
  handleDragStart,
  renamingSessionId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: SessionItemProps) {
  const { t } = useI18n()
  const { deleteSession } = useSessionsStore()
  const { openTab } = useUIStore()
  const { selectionMode, selectedIds, toggleSelected } = useSessionsTreeStore()
  const streamingBySession = useChatStore((s) => s.streamingBySession)
  const queueBySession = useChatStore((s) => s.queueBySession)
  const sessionUnread = useNotificationStore((s) => s.sessionUnread)
  const clearSessionUnread = useNotificationStore((s) => s.clearSessionUnread)
  const menuKey = `session:${session.id}`
  const isMenuOpen = openMenuKey === menuKey
  const isSelected = selectedIds.has(session.id)
  const isRenaming = renamingSessionId === session.id
  const renameInputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  const isStreaming = useMemo(() => {
    const streams = streamingBySession[session.id]
    return streams && Object.keys(streams).length > 0
  }, [streamingBySession, session.id])

  const queueInfo = queueBySession[session.id]
  const isStalled = queueInfo?.isStalled
  const pendingCount = queueInfo?.pendingCount || session.pending_messages?.length || 0
  const isBlocked = session.status?.blocked != null

  const unreadCount = sessionUnread[session.id] || 0
  const hasUnread = unreadCount > 0

  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          renameInputRef.current?.focus()
          renameInputRef.current?.select()
        })
      })
    }
  }, [isRenaming])

  useEffect(() => {
    if (!isRenaming) return
    const handler = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        onCancelRename()
      }
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handler)
    }
  }, [isRenaming, onCancelRename])

  const timeLabel = formatRelativeTime(session.updated_at)

  const handleDelete = async () => {
    closeMenu()
    if (window.confirm(t('leftPanel.confirmDeleteSession'))) {
      await deleteSession(session.id)
    }
  }

  const handleClear = async () => {
    closeMenu()
    if (!window.confirm(t('leftPanel.confirmClearSession'))) return
    try {
      await synthApi.clearSession(session.id)
      useChatStore.getState().clearSession(session.id)
      const result = await synthApi.getSessionMessages(session.id)
      useChatStore.getState().setMessages(session.id, result.messages)
    } catch {
      // silently ignore
    }
  }

  const handleClick = () => {
    if (selectionMode) {
      toggleSelected(session.id)
    } else {
      clearSessionUnread(session.id)
      openTab({
        id: `chat-${session.id}`,
        type: 'chat',
        title: session.name || session.id,
        data: { sessionId: session.id, projectId: session.project_id || undefined },
      })
    }
  }

  return (
    <div
      ref={rowRef}
      className={`group relative flex items-center gap-1.5 rounded px-2 py-1 cursor-pointer transition-colors hover:bg-interactive-hover ${
        isSelected ? 'bg-primary/15' : ''
      }`}
      draggable={!selectionMode}
      onDragStart={(e) => !selectionMode && handleDragStart(e, session.id)}
      onClick={handleClick}
    >
      {selectionMode && (
        <Icon
          name={isSelected ? 'checkbox' : 'checkbox-blank'}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <Icon
        name="chat-new"
        className={`h-3.5 w-3.5 shrink-0 ${
          isStreaming ? 'text-syntax-keyword animate-notification-blink' : hasUnread ? 'text-orange-400' : 'text-muted-foreground'
        }`}
      />
      <div className="flex flex-col min-w-0 flex-1">
        {isRenaming ? (
          <div className="flex items-center gap-0.5">
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => onRenameValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename()
                if (e.key === 'Escape') onCancelRename()
              }}
              className="flex-1 rounded bg-interactive px-1 py-0 text-sm text-foreground outline-none"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={(e) => { e.stopPropagation(); onCommitRename() }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-status-success"
              title={t('leftPanel.confirm')}
            >
              <Icon name="check" className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onCancelRename() }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
              title={t('leftPanel.cancel')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <span className={`truncate text-sm ${hasUnread ? 'text-orange-400' : 'text-foreground'}`} title={session.name || session.id}>{session.name || session.id}</span>
            <span className="text-[0.65rem] text-muted-foreground leading-none">{timeLabel}</span>
          </>
        )}
      </div>

      {!selectionMode && !isRenaming && (
        <div className={`shrink-0 bg-sidebar rounded ${isMenuOpen ? '' : 'hidden group-hover:block'}`}>
          <ContextMenu
            trigger={
              <button
                onClick={(e) => { e.stopPropagation(); setOpenMenuKey(isMenuOpen ? null : menuKey) }}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Icon name="more-2" className="h-3.5 w-3.5" />
              </button>
            }
            items={[
              { label: t('leftPanel.rename'), icon: 'pencil-ai', onClick: () => { onStartRename(session.id, session.name || session.id) } },
              { label: t('leftPanel.configure'), icon: 'settings-3', onClick: () => { closeMenu() } },
              { label: t('leftPanel.clearSession'), icon: 'close', onClick: handleClear },
              'separator',
              { label: t('leftPanel.delete'), icon: 'delete-bin', onClick: handleDelete, destructive: true },
            ]}
            align="end"
          />
        </div>
      )}

      {isStreaming && (
        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-syntax-keyword animate-notification-blink" title={t('leftPanel.streaming')} />
      )}
      {isBlocked && !isStreaming && (
        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-destructive" title={t('leftPanel.blocked')} />
      )}
      {isStalled && !isStreaming && !isBlocked && (
        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-syntax-element animate-notification-blink" title={t('leftPanel.attentionNeeded')} />
      )}
      {!isStreaming && !isStalled && !isBlocked && pendingCount > 0 && (
        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-syntax-accent" title={t('leftPanel.answerReady')} />
      )}
    </div>
  )
}

function ProjectEditPopup({ project, onClose }: { project: ProjectData; onClose: () => void }) {
  const { t } = useI18n()
  const { updateProject, deleteProject } = useProjectsStore()
  const [page, setPage] = useState<'general' | 'appearance'>('general')
  const [name, setName] = useState(project.name)
  const [icon, setIcon] = useState<string | null>(project.icon)
  const [color, setColor] = useState<string | null>(project.color)
  const [workspace, setWorkspace] = useState(project.workspace || '')

  const CATEGORIES = [
    { id: 'general' as const, labelKey: 'leftPanel.editProject.general' as const, icon: 'file-text' as const },
    { id: 'appearance' as const, labelKey: 'leftPanel.editProject.appearance' as const, icon: 'palette' as const },
  ]

  const handleSave = async () => {
    await updateProject(project.id, {
      name: name || undefined,
      icon,
      color,
      workspace: workspace || null,
    })
    onClose()
  }

  const handleDelete = async () => {
    if (window.confirm(t('leftPanel.confirmDelete'))) {
      await deleteProject(project.id)
      onClose()
    }
  }

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 max-w-lg w-[90vw] h-[65vh] max-h-[65vh]">
        <div className="flex h-full overflow-hidden">
          {/* Left sidebar */}
          <div className="w-40 border-r border-border flex flex-col shrink-0">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-border">
              <Icon name="settings-3" className="size-4 text-muted-foreground" />
              <span className="font-medium text-xs">{t('leftPanel.editProject.title')}</span>
            </div>
            <nav className="flex-1 overflow-y-auto p-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setPage(cat.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left transition-colors ${
                    page === cat.id
                      ? 'bg-interactive-hover text-foreground'
                      : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
                  }`}
                >
                  <Icon name={cat.icon} className="size-3.5 shrink-0" />
                  {t(cat.labelKey)}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4">
              {page === 'general' && (
                <div className="space-y-4">
                  <div>
                    <label className="block mb-1.5 text-xs font-medium text-muted-foreground">{t('leftPanel.name')}</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded bg-interactive px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                  <div>
                    <label className="block mb-1.5 text-xs font-medium text-muted-foreground">{t('leftPanel.workspace')}</label>
                    <input
                      type="text"
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                      placeholder="/home/user/project"
                      className="w-full rounded bg-interactive px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                </div>
              )}
              {page === 'appearance' && (
                <div className="space-y-4">
                  <div>
                    <label className="block mb-2 text-xs font-medium text-muted-foreground">{t('leftPanel.icon')}</label>
                    <div className="grid grid-cols-5 gap-1">
                      <button
                        onClick={() => setIcon(null)}
                        className={`flex items-center justify-center rounded p-2 transition-colors ${
                          !icon ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-interactive-hover'
                        }`}
                      >
                        <Icon name="folder-3" className="size-5 text-foreground" />
                      </button>
                      {Object.entries(PROJECT_ICON_MAP).map(([key, iconName]) => (
                        <button
                          key={key}
                          onClick={() => setIcon(key)}
                          className={`flex items-center justify-center rounded p-2 transition-colors ${
                            icon === key ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-interactive-hover'
                          }`}
                        >
                          <Icon name={iconName} className="size-5 text-foreground" />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block mb-2 text-xs font-medium text-muted-foreground">{t('leftPanel.color')}</label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setColor(null)}
                        className={`size-6 rounded border border-sidebar-border transition-colors ${
                          !color ? 'ring-2 ring-foreground' : ''
                        }`}
                      />
                      {Object.entries(PROJECT_COLOR_MAP).map(([key, cssVar]) => (
                        <button
                          key={key}
                          onClick={() => setColor(key)}
                          className={`size-6 rounded transition-colors ${
                            color === key ? 'ring-2 ring-foreground' : ''
                          }`}
                          style={{ backgroundColor: cssVar }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom actions */}
            <div className="flex items-center gap-2 border-t border-border p-3 shrink-0">
              <button
                onClick={handleDelete}
                className="rounded px-3 py-1.5 text-xs text-status-error hover:bg-status-error/10 transition-colors"
              >
                {t('common.delete')}
              </button>
              <div className="flex-1" />
              <button onClick={onClose} className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={handleSave} className="rounded bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors">
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
