import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useActiveProject } from '@/hooks/useActiveProject'
import { useFilesStore } from '@/stores/filesStore'
import { useGitStore, type GitRepoView } from '@/stores/gitStore'
import { useChatStore } from '@/stores/chatStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useNotification } from '@/hooks/useNotification'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { useAdaptiveIcons } from '@/hooks/useAdaptiveIcons'
import { useDevice } from '@/hooks/useDevice'
import { synthApi } from '@/lib/api/synthApi'
import type { EntityOrigin, ProjectData } from '@/lib/api/synthApi'
import type { SSHKeyMeta } from '@itphx/synth-shared'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { EntityIconPicker } from '@/components/ui/EntityIconPicker'
import { formatDateTime, formatRelativeTime, parseISODate } from '@/lib/formatDate'
import { TreeNode, TreeChildren, TreeContainer } from '@/components/tree'
import type { TreeNodeBase, TreeAction } from '@/components/tree'
import { OriginBadge } from '@/components/ui/OriginBadge'
import type { ContextMenuItem } from '@/components/ui/contextMenu'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ConfirmDialog, type ConfirmVariant } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { PublishProjectDialog } from '@/components/projects/PublishProjectDialog'
import { ForkProjectDialog } from '@/components/projects/ForkProjectDialog'

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
      // Безопасность окружения: в jsdom/SSR и после teardown jsdom глобальные
      // `CSS`/`document` и `Element.scrollIntoView` могут отсутствовать —
      // тихо выходим, наблюдаемое поведение в браузере не меняется.
      if (typeof document === 'undefined') return
      const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
      const el = document.querySelector(`[data-tree-node="${escaped}"]`)
      if (el) {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
        pendingRef.current = null
      }
    }, 80)
    return () => clearTimeout(timer)
  }, [])
}

// ---- Project scope (variant C) — общие блоки для вкладок Files/Git ----

/** Закреплённая шапка блока «Текущий проект». */
function CurrentProjectHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1 px-2 pt-1 pb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
      <Icon name="pushpin" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  )
}

/** Инфо-строка фоллбеков «нет проекта / нет workspace». */
function ScopeHint({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon name="information" className="size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </div>
  )
}

/** Сворачиваемая обёртка «Другие проекты (N)». */
function OtherProjectsGroup({
  label,
  title,
  collapsed,
  onToggle,
  children,
}: {
  label: string
  title?: string
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <TreeNode
        id={`group:${OTHER_PROJECTS_COLLAPSE_KEY}`}
        label={label}
        icon="folder-3"
        iconSize="md"
        isExpanded={!collapsed}
        hasChildren={true}
        onToggle={onToggle}
        title={title}
      />
      {!collapsed && children}
    </div>
  )
}

// ---- Projects tab ----
function ProjectsTab() {
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
  const { notify } = useNotification()
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
  const [renameValue, setRenameValue] = useState('')
  const [editingProject, setEditingProject] = useState<any>(null)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const pendingDeleteRef = useRef<Set<string>>(new Set())
  const [forwardTarget, setForwardTarget] = useState<{ sessionId: string; sessionName: string } | null>(null)
  const [summarizeChecked, setSummarizeChecked] = useState(false)
  // Гибрид: перенос проектов между мирами — проект, для которого открыт диалог.
  const [publishTarget, setPublishTarget] = useState<ProjectData | null>(null)
  const [forkTarget, setForkTarget] = useState<ProjectData | null>(null)
  // Единый пикер «Иконка и цвет» для проекта/сессии (контекстное меню дерева).
  const [iconColorTarget, setIconColorTarget] = useState<{
    kind: 'session' | 'project'
    id: string
    name: string
    icon: string | null
    color: string | null
  } | null>(null)
  const [iconDraft, setIconDraft] = useState<string | null>(null)
  const [colorDraft, setColorDraft] = useState<string | null>(null)

  const openIconColor = (target: NonNullable<typeof iconColorTarget>) => {
    setIconColorTarget(target)
    setIconDraft(target.icon)
    setColorDraft(target.color)
  }

  // Немедленное сохранение иконки/цвета из диалога дерева. Оптимистично меняем
  // драфт, а при ошибке откатываемся к актуальному серверному значению.
  const persistIconColor = async (icon: string | null, color: string | null) => {
    const target = iconColorTarget
    if (!target) return
    const ok = target.kind === 'session'
      ? await useSessionsStore.getState().updateSessionMeta(target.id, { icon, color })
      : await useProjectsStore.getState().updateProject(target.id, { icon, color })
    if (ok) {
      setIconColorTarget({ ...target, icon: icon ?? null, color: color ?? null })
    } else {
      notify({ text: t('panel.saveError'), type: 'error', category: 'error' })
      setIconDraft(target.icon)
      setColorDraft(target.color)
    }
  }

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
    // Offline-деградация: remote-сессии недоступны — приглушаем и помечаем тултипом.
    const isOfflineRemote = isOffline && session.origin === 'remote'
    return {
      id: `session:${session.id}`,
      label: session.name || session.id,
      depth,
      icon: resolveIconName(session.icon) ?? (isSubagent ? 'cpu' : 'chat-new'),
      iconColor: resolveIconColor(session.color),
      subtitle: formatRelativeTime(session.updated_at),
      badge: <OriginBadge origin={session.origin} />,
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
        { label: t('leftPanel.iconColor'), icon: 'palette', onClick: () => openIconColor({
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
            <EntityIconPicker
              icon={editingProject.icon}
              color={editingProject.color}
              onIconChange={(icon) => setEditingProject((prev: any) => ({ ...prev, icon }))}
              onColorChange={(color) => setEditingProject((prev: any) => ({ ...prev, color }))}
            />
            <div className="flex gap-2">
              <button onClick={handleProjectSave} className="flex-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors">{t('project.save')}</button>
              <button onClick={() => setEditingProject(null)} className="flex-1 rounded bg-interactive px-3 py-1.5 text-xs text-foreground hover:bg-interactive-hover transition-colors">{t('common.cancel')}</button>
            </div>
          </PopoverContent>
        </Popover>
      )}

      {iconColorTarget && (
        <Dialog open={!!iconColorTarget} onOpenChange={(open) => { if (!open) setIconColorTarget(null) }}>
          <DialogContent className="max-w-sm p-4 gap-3" showCloseButton={true} data-testid="entity-icon-dialog">
            <h3 className="text-sm font-semibold">{t('leftPanel.iconColor')}</h3>
            <p className="truncate text-xs text-muted-foreground">{iconColorTarget.name}</p>
            <EntityIconPicker
              icon={iconDraft}
              color={colorDraft}
              onIconChange={(icon) => { setIconDraft(icon); void persistIconColor(icon, colorDraft) }}
              onColorChange={(color) => { setColorDraft(color); void persistIconColor(iconDraft, color) }}
            />
            <div className="flex justify-end">
              <button
                onClick={() => setIconColorTarget(null)}
                className="rounded bg-interactive px-3 py-1.5 text-xs text-foreground hover:bg-interactive-hover transition-colors"
              >
                {t('common.close')}
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
          { label: t('leftPanel.editProject'), icon: 'settings-3' as const, onClick: () => { setEditingProject({ ...project }) } },
          { label: t('leftPanel.iconColor'), icon: 'palette' as const, onClick: () => openIconColor({
            kind: 'project',
            id: project.id,
            name: project.name,
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
            isTouch={isTouch}
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
        <div className="ml-[0.9375rem] border-l border-sidebar-border pl-4">
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
  origin, offline, isTouch,
}: {
  id: string; label: string; icon: string; iconColor?: string
  isCollapsed: boolean; onToggle: () => void
  sessions: any[]; childrenByParentId: Record<string, any[]>
  expandedGroups: Set<string>; toggleGroupExpand: (k: string) => void
  renderSessionNode: (session: any, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void) => TreeNodeBase
  expandedSessions: Set<string>; toggleSessionExpand: (id: string) => void
  projectId: string | null; onCreateSession: () => void; onDropSession: (sid: string) => void
  projectActions?: TreeAction[]; projectContextItems?: any[]
  origin?: EntityOrigin
  offline?: boolean
  isTouch?: boolean
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

  // Offline-деградация: remote-проект недоступен — приглушаем и помечаем тултипом.
  const isOfflineNode = offline && origin === 'remote'

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isTouch) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [isTouch])

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
    badge: <OriginBadge origin={origin} />,
    actions,
    contextItems: projectContextItems,
    className: isOfflineNode ? 'opacity-60' : undefined,
    title: isOfflineNode ? t('hybrid.unavailableNode') : undefined,
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

// ---- Git tab ----

type AddRepoMode = 'scan' | 'clone' | 'init' | null

/** AD-076: нормализация пути репозитория (корень workspace — `''`/`.`). */
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

/** AD-076: клиентская проверка ssh-URL (зеркалит серверный `isSshUrl`). */
function isSshRepoUrl(url: string): boolean {
  const v = url.trim()
  return v.startsWith('git@') || v.startsWith('ssh://')
}

function GitTab() {
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
  const projectRefs = useRef<Record<string, HTMLDivElement | null>>({})

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
    setCloneName('')
    setCloneSshKeyId('')
    setInitPath('')
    setInitBranch('main')
    setInitName('')
    setActionError(null)
  }

  /** Перечитать реестр проекта после мутации: список проектов + записи gitStore. */
  const refreshRepos = useCallback(async (projectId: string) => {
    await loadProjects()
    const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
    await loadRepos(projectId, project?.repos ?? [])
  }, [loadProjects, loadRepos])

  const storeError = () => useGitStore.getState().error ?? t('common.error')

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

  const handleDoClone = async (projectId: string) => {
    if (!cloneUrl.trim()) return
    if (isSshRepoUrl(cloneUrl) && !cloneSshKeyId) {
      setActionError(t('git.ssh_key_required', { path: cloneName.trim() || clonePath.trim() || t('git.repo') }))
      return
    }
    setActionError(null)
    const repo = await cloneRepo(
      projectId,
      cloneUrl.trim(),
      clonePath.trim() || undefined,
      cloneBranch.trim() || undefined,
      cloneName.trim() || undefined,
      cloneSshKeyId || undefined,
    )
    if (!repo) {
      setActionError(storeError())
      return
    }
    await refreshRepos(projectId)
    notify({ text: t('git.cloneSuccess'), type: 'success', category: 'system' })
    closePopover()
  }

  const handleDoInit = async (projectId: string) => {
    setActionError(null)
    const path = initPath.trim() || '.'
    const derivedName = path === '.' || path === '' ? '' : basenameOf(path)
    const repo = await initRepo(
      projectId,
      path,
      initBranch.trim() || undefined,
      initName.trim() || derivedName || undefined,
    )
    if (!repo) {
      setActionError(storeError())
      return
    }
    await refreshRepos(projectId)
    notify({ text: t('git.initSuccess'), type: 'success', category: 'system' })
    closePopover()
  }

  const handleRemoveRepo = async () => {
    if (!removeTarget) return
    const { projectId, repo } = removeTarget
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
  }

  const handleFetchRepo = async (projectId: string, repo: GitRepoView) => {
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
                    type="text"
                    value={clonePath}
                    onChange={(e) => setClonePath(e.target.value)}
                    placeholder={t('git.pathHint')}
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
                <button
                  onClick={() => handleDoClone(project.id)}
                  disabled={!cloneUrl.trim() || (isSshRepoUrl(cloneUrl) && !cloneSshKeyId)}
                  className="w-full rounded bg-primary px-3 py-2 min-h-[40px] text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
                  className="w-full rounded bg-primary px-3 py-2 min-h-[40px] text-xs text-primary-foreground hover:bg-primary/90 transition-colors"
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
            {repos.map((repo) => {
              const rkey = `${project.id}::${repo.path}`
              const isRepoExpanded = expandedRepos.has(rkey)
              const commits = commitsByRepo[rkey] || []
              const destination = repoDestination(repo.path, t('git.workspaceRoot'))
              const displayName = repo.name || destination
              const keyLabel = sshKeyLabel(repo.sshKeyId)

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
                      { id: 'remove', icon: 'delete-bin', title: t('git.remove'), variant: 'destructive', onClick: () => { setDeleteLocal(false); setRemoveTarget({ projectId: project.id, repo }) } },
                    ]}
                    subtitle={repo.lastCommitSubject?.slice(0, 30)}
                  />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pb-1 -mt-0.5 text-[0.65rem] text-muted-foreground">
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

// ---- LeftPanel ----

export const LeftPanel: React.FC = () => {
  const { t } = useI18n()
  const leftPanelTab = useUIStore(s => s.leftPanelTab)
  const setLeftPanelTab = useUIStore(s => s.setLeftPanelTab)

  const containerRef = useRef<HTMLDivElement>(null)
  const iconsOnly = useAdaptiveIcons(containerRef)

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="left-tabs flex shrink-0 px-2 py-1">
        <div data-tab-row className="flex w-full rounded-lg border border-sidebar-border overflow-hidden">
          {LEFT_TABS.map((tab) => {
            const active = leftPanelTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setLeftPanelTab(tab.id)}
                title={t(tab.labelKey)}
                data-compact
                className={`flex items-center justify-center gap-1.5 py-1.5 text-xs transition-colors
                  border-r border-sidebar-border last:border-r-0
                  flex-1
                  ${iconsOnly ? 'min-w-0 px-2' : 'min-w-[4.5rem] px-3'}
                  ${active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'}
                `}
              >
                <Icon name={tab.icon} className="h-4 w-4 shrink-0" />
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
