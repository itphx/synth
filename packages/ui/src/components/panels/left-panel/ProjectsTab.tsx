import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useDevice } from '@/hooks/useDevice'
import { synthApi } from '@/lib/api/synthApi'
import type { EntityOrigin, ProjectData } from '@/lib/api/synthApi'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { formatRelativeTime, parseISODate } from '@/lib/formatDate'
import { TreeContainer } from '@/components/tree'
import type { TreeNodeBase, TreeAction } from '@/components/tree'
import { OriginBadge } from '@/components/ui/OriginBadge'
import type { ContextMenuItem } from '@/components/ui/contextMenu'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { PublishProjectDialog } from '@/components/projects/PublishProjectDialog'
import { ForkProjectDialog } from '@/components/projects/ForkProjectDialog'
import { useAutoScroll } from './useAutoScroll'
import type { ConfirmAction } from './types'
import { GroupNode } from './GroupNode'

// ---- Projects tab ----
export function ProjectsTab() {
  const { t } = useI18n()
  const projects = useProjectsStore(s => s.projects)
  const loadProjects = useProjectsStore(s => s.loadProjects)
  const deleteProject = useProjectsStore(s => s.deleteProject)
  const sessions = useSessionsStore(s => s.sessions)
  const loadSessions = useSessionsStore(s => s.loadSessions)
  const createSession = useSessionsStore(s => s.createSession)
  const forkSession = useSessionsStore(s => s.forkSession)
  const deleteSession = useSessionsStore(s => s.deleteSession)
  const moveSession = useSessionsStore(s => s.moveSession)
  const { isTouch } = useDevice()
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapse = useUIStore((s) => s.toggleProjectCollapse)
  const openTab = useUIStore((s) => s.openTab)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const forwardMode = useUIStore((s) => s.forwardMode)
  const sortMode = useSessionsTreeStore(s => s.sortMode)
  const selectionMode = useSessionsTreeStore(s => s.selectionMode)
  const selectedIds = useSessionsTreeStore(s => s.selectedIds)
  const toggleSelected = useSessionsTreeStore(s => s.toggleSelected)
  const streamingBySession = useChatStore((s) => s.streamingBySession)
  const queueBySession = useChatStore((s) => s.queueBySession)
  const sessionUnread = useNotificationStore((s) => s.sessionUnread)
  const clearSessionUnread = useNotificationStore((s) => s.clearSessionUnread)
  const isOffline = useHybridStore(selectIsOffline)
  const hybridEnabled = useHybridStore((s) => s.enabled)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const pendingDeleteRef = useRef<Set<string>>(new Set())
  const [forwardTarget, setForwardTarget] = useState<{ sessionId: string; sessionName: string } | null>(null)
  const [summarizeChecked, setSummarizeChecked] = useState(false)
  // Гибрид: перенос проектов между мирами — проект, для которого открыт диалог.
  const [publishTarget, setPublishTarget] = useState<ProjectData | null>(null)
  const [forkTarget, setForkTarget] = useState<ProjectData | null>(null)

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
    // Ключ-обёртка «Другие проекты» (variant C, Files/Git) — не проектный id, но
    // должен переживать очистку, иначе сворачивание обёртки теряется.
    validIds.add(OTHER_PROJECTS_COLLAPSE_KEY)
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

  // Инлайн-переименование проекта (быстрый путь, как у сессий): коммит по Enter
  // или галочке, отмена по Esc/крестику.
  const commitProjectRename = async () => {
    const id = renamingProjectId
    const name = renameValue.trim()
    if (id && name) {
      await useProjectsStore.getState().updateProject(id, { name })
      await loadProjects()
    }
    setRenamingProjectId(null)
    setRenameValue('')
  }

  const cancelProjectRename = () => {
    setRenamingProjectId(null)
    setRenameValue('')
  }

  const renderSessionNode = (session: any, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void): TreeNodeBase => {
    const isSubagent = session.session_origin === 'subagent'
    const isForwardSource = forwardMode.active && session.id === forwardMode.sourceSessionId
    const isForwardTarget = forwardMode.active && !isForwardSource
    // Offline-деградация: remote-сессии недоступны — приглушаем и помечаем тултипом.
    const isOfflineRemote = isOffline && session.origin === 'remote'
    const isTabOpen = sessionTabOpenSet.has(session.id)
    const isActive = activeCenterTabId === `chat-${session.id}`
    return {
      id: `session:${session.id}`,
      label: session.name || session.id,
      depth,
      icon: resolveIconName(session.icon) ?? (isSubagent ? 'cpu' : 'chat-new'),
      // Кастомный цвет иконки — только у «открытой» сессии (активный таб или открытый
      // в фоне). У закрытой — undefined, чтобы работал класс TreeNode (серая иконка).
      iconColor: (isTabOpen || isActive) ? resolveIconColor(session.color) : undefined,
      subtitle: formatRelativeTime(session.updated_at),
      badge: <OriginBadge origin={session.origin} />,
      isSelected: selectedIds.has(session.id),
      isTabOpen,
      isActive,
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
      draggable: !selectionMode && !isTouch,
      onDragStart: isTouch ? undefined : (e) => { e.dataTransfer.setData('text/plain', session.id); e.dataTransfer.effectAllowed = 'move' },
      className: cn(
        isForwardSource && 'opacity-40 pointer-events-none',
        isForwardTarget && 'cursor-pointer hover:bg-primary/10',
        isOfflineRemote && 'opacity-60',
      ),
      title: isOfflineRemote ? t('hybrid.unavailableNode') : undefined,
      contextItems: [
        { label: t('leftPanel.rename'), icon: 'pencil-ai', onClick: () => { setRenamingId(session.id); setRenameValue(session.name || session.id) } },
        { label: t('leftPanel.editSession'), icon: 'settings-3', onClick: () => useEntityEditStore.getState().openEntityEdit({
          kind: 'session',
          id: session.id,
          name: session.name || session.id,
          icon: session.icon ?? null,
          color: session.color ?? null,
        }) },
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

  // Сервер доступен (гибрид включён и не offline) — доступно создание на сервере.
  const hybridOnline = hybridEnabled && !isOffline

  // Гибрид: создание сессии из узла дерева. Каждый мир знает только свои проекты,
  // поэтому «свой» мир создаёт сессию ВНУТРИ проекта узла, а «чужой» — БЕЗ проекта
  // (в группе «Без проекта»), иначе получится битая связка project_id из другого мира:
  //   локальный проект: local → в проекте, remote → на сервере без проекта;
  //   remote-проект:    remote → в проекте (на сервере), local → локально без проекта;
  //   группа «Без проекта»: local/remote → без проекта в соответствующем мире.
  const handleCreateSession = async (projectId: string | null, projectOrigin: EntityOrigin | undefined, target: EntityOrigin) => {
    const inOwnWorld = (projectOrigin ?? 'local') === target
    const boundProjectId = inOwnWorld ? projectId : null
    // Разворачиваем группу, куда попадёт новая сессия (проект или «Без проекта»).
    const uiState = useUIStore.getState()
    const groupKey = boundProjectId ?? '__none__'
    if (uiState.collapsedProjects.has(groupKey)) uiState.toggleProjectCollapse(groupKey)
    const result = await createSession({
      project_id: boundProjectId,
      origin: target === 'remote' ? 'remote' : undefined,
    })
    if (result) openTab({ id: 'chat-' + result.id, type: 'chat', title: result.name || result.id, data: { sessionId: result.id, projectId: result.project_id || undefined } })
  }

  // Пункты меню создания сессии для узла (проект или «Без проекта»). В гибриде —
  // оба мира (локально/на сервере); вне гибрида/offline для доступных узлов — один
  // пункт «Новая сессия» в мире узла.
  const makeSessionMenuItems = (projectId: string | null, projectOrigin: EntityOrigin | undefined): ContextMenuItem[] => {
    if (!hybridOnline) return []
    return [
      { label: t('hybrid.createSessionLocal'), icon: 'chat-new' as const, onClick: () => void handleCreateSession(projectId, projectOrigin, 'local') },
      { label: t('hybrid.createSessionRemote'), icon: 'server' as const, onClick: () => void handleCreateSession(projectId, projectOrigin, 'remote') },
    ]
  }

  // Действие «+» для узла: в гибриде раскрывает меню выбора мира; вне гибрида и в
  // offline создаёт сразу в мире узла. Для remote-узла в offline действия нет —
  // remote-создание недоступно (502), а «локально из remote-проекта» запутывает
  // (узел и так помечен «недоступен»).
  const makeSessionAction = (projectId: string | null, projectOrigin: EntityOrigin | undefined): TreeAction | null => {
    const isRemoteOffline = isOffline && projectOrigin === 'remote'
    if (isRemoteOffline) return null
    const menuItems = makeSessionMenuItems(projectId, projectOrigin)
    const ownTarget = projectOrigin ?? 'local'
    if (menuItems.length > 0) {
      return { id: 'new-session', icon: 'add' as const, title: t('leftPanel.newSession'), menuItems }
    }
    return {
      id: 'new-session',
      icon: 'add' as const,
      title: t('leftPanel.newSession'),
      onClick: () => void handleCreateSession(projectId, projectOrigin, ownTarget),
    }
  }

  // Пункты контекстного меню узла проекта (…): в гибриде — выбор мира, иначе —
  // «Новая сессия» в мире проекта. В offline у remote-проекта создание скрыто.
  const makeProjectCreateItems = (projectId: string | null, projectOrigin: EntityOrigin | undefined): ContextMenuItem[] => {
    const isRemoteOffline = isOffline && projectOrigin === 'remote'
    if (isRemoteOffline) return []
    const menuItems = makeSessionMenuItems(projectId, projectOrigin)
    if (menuItems.length > 0) return menuItems
    const ownTarget = projectOrigin ?? 'local'
    return [{ label: t('leftPanel.newSession'), icon: 'add' as const, onClick: () => void handleCreateSession(projectId, projectOrigin, ownTarget) }]
  }

  const noneSessionAction = makeSessionAction(null, undefined)

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

      {publishTarget && (
        <PublishProjectDialog
          open={!!publishTarget}
          onOpenChange={(open) => { if (!open) setPublishTarget(null) }}
          project={publishTarget}
          remoteProjects={projects.filter((p) => p.origin === 'remote')}
        />
      )}

      {forkTarget && (
        <ForkProjectDialog
          open={!!forkTarget}
          onOpenChange={(open) => { if (!open) setForkTarget(null) }}
          project={forkTarget}
          localProjects={projects.filter((p) => p.origin !== 'remote')}
        />
      )}

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
        onCreateSession={() => void handleCreateSession(null, undefined, 'local')}
        projectActions={noneSessionAction ? [noneSessionAction] : undefined}
        onDropSession={async (sessionId) => { await moveSession(sessionId, null) }}
        isTouch={isTouch}
        t={t}
      />

      {sortedProjects.map((project) => {
        const isCollapsed = collapsedProjects.has(project.id)
        const sessionAction = makeSessionAction(project.id, project.origin)
        // В offline remote-проект недоступен — «+» скрываем, создание сессии не предлагаем.
        const projectActions = sessionAction ? [sessionAction] : []
        const createItems = makeProjectCreateItems(project.id, project.origin)
        // Гибрид: перенос проекта между мирами. Локальный → «Опубликовать на сервер»,
        // remote → «Склонировать локально». В offline/вне гибрида пунктов нет.
        const transferItem: ContextMenuItem | null = hybridOnline && project.origin === 'local'
          ? { label: t('hybrid.publishProject'), icon: 'upload' as const, onClick: () => setPublishTarget(project) }
          : hybridOnline && project.origin === 'remote'
            ? { label: t('hybrid.cloneProject'), icon: 'download' as const, onClick: () => setForkTarget(project) }
            : null
        const projectContextItems: any[] = [
          { label: t('leftPanel.rename'), icon: 'pencil-ai' as const, onClick: () => { setRenamingProjectId(project.id); setRenameValue(project.name) } },
          { label: t('leftPanel.editProject'), icon: 'settings-3' as const, onClick: () => useEntityEditStore.getState().openEntityEdit({
            kind: 'project',
            id: project.id,
            name: project.name,
            description: project.description ?? '',
            icon: project.icon ?? null,
            color: project.color ?? null,
          }) },
        ]
        if (transferItem) {
          projectContextItems.push('separator' as const, transferItem)
        }
        if (createItems.length > 0) {
          projectContextItems.push('separator' as const, ...createItems)
        }
        if (transferItem || createItems.length > 0) {
          projectContextItems.push('separator' as const)
        }
        projectContextItems.push({
          label: t('leftPanel.delete'), icon: 'delete-bin' as const, onClick: () => setConfirm({
            title: t('leftPanel.delete'),
            message: t('leftPanel.confirmDelete'),
            variant: 'danger',
            onConfirm: async () => { await deleteProject(project.id) },
          }), destructive: true,
        })
        return (
          <GroupNode
            key={project.id}
            id={project.id}
            label={project.name}
            icon={resolveIconName(project.icon) ?? 'folder-3'}
            iconColor={resolveIconColor(project.color)}
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
            origin={project.origin}
            offline={isOffline}
            onCreateSession={() => void handleCreateSession(project.id, project.origin, project.origin ?? 'local')}
            projectActions={projectActions}
            onDropSession={async (sessionId) => { await moveSession(sessionId, project.id) }}
            projectContextItems={projectContextItems}
            isRenaming={renamingProjectId === project.id}
            renameValue={renamingProjectId === project.id ? renameValue : ''}
            onRenameChange={setRenameValue}
            onRenameCommit={() => void commitProjectRename()}
            onRenameCancel={cancelProjectRename}
            isTouch={isTouch}
            t={t}
          />
        )
      })}
    </TreeContainer>
  )
}
