import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useChatStore } from '@/stores/chatStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useQuestionStore } from '@/stores/questionStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useProcessesStore } from '@/stores/processesStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import { useTimersStore } from '@/stores/timersStore'
import { countSessionActivity, type SessionActivityCounts } from '@/lib/sessionActivity'
import { sessionBadgeState } from '@/lib/sessionBadgeState'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import type { IconName } from '@/components/icon/Icon'
import { useDevice } from '@/hooks/useDevice'
import { STALE_TURN_SILENCE_MS } from '@/hooks/useStaleTurnGuard'
import { synthApi } from '@/lib/api/synthApi'
import { MESSAGES_PAGE_LIMIT } from '@/lib/api/messages'
import { applyHistoryPage, sessionSilenceMs } from '@/stores/transportStore'
import type { EntityOrigin, ProjectData, SessionData } from '@/lib/api/synthApi'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { formatRelativeTime, parseISODate } from '@/lib/formatDate'
import { TreeContainer } from '@/components/tree'
import type { TreeNodeBase, TreeAction, ContextMenuEntry } from '@/components/tree'
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

/** Период обновления реестра активных прогонов (значки в дереве), мс. */
const ACTIVITY_RUNS_REFRESH_MS = 30_000
/** Период обновления списка живых терминалов (значки в дереве), мс. */
const ACTIVITY_TERMINALS_REFRESH_MS = 60_000
/** Период обновления списка активных таймеров (значки в дереве), мс. */
const ACTIVITY_TIMERS_REFRESH_MS = 30_000

/**
 * Значки активной фоновой работы в строке сессии.
 *
 * Показывают только то, что идёт **сейчас**: выполняющиеся фоновые процессы
 * и саб-агенты, живые терминалы и активные таймеры/будильники сессии. Цвет —
 * не единственный сигнал: у каждой иконки есть текстовая подпись
 * (`aria-label` + тултип) с числом.
 */
function SessionActivityBadge({ activity }: { activity?: SessionActivityCounts }) {
  const { t } = useI18n()
  if (!activity) return null

  const items: Array<{
    key: keyof SessionActivityCounts
    icon: IconName
    color: string
    labelKey: string
    testId: string
  }> = [
    {
      key: 'processes',
      icon: 'command',
      color: 'text-status-caution',
      labelKey: 'leftPanel.activity.process',
      testId: 'session-activity-processes',
    },
    {
      key: 'subagents',
      icon: 'robot-2',
      color: 'text-primary',
      labelKey: 'leftPanel.activity.subagent',
      testId: 'session-activity-subagents',
    },
    {
      key: 'terminals',
      icon: 'terminal-box',
      color: 'text-status-success',
      labelKey: 'leftPanel.activity.terminal',
      testId: 'session-activity-terminals',
    },
    // PROP-141: активные таймеры и будильники сессии.
    {
      key: 'timers',
      icon: 'time',
      color: 'text-status-info',
      labelKey: 'leftPanel.activity.timer',
      testId: 'session-activity-timers',
    },
    {
      key: 'alarms',
      icon: 'alarm',
      color: 'text-status-warning',
      labelKey: 'leftPanel.activity.alarm',
      testId: 'session-activity-alarms',
    },
  ]

  const visible = items.filter((item) => (activity[item.key] ?? 0) > 0)
  if (visible.length === 0) return null

  return (
    <span className="flex items-center gap-1" data-testid="session-activity">
      {visible.map((item) => {
        const count = activity[item.key] ?? 0
        const label = t(item.labelKey, { count })
        return (
          <Icon
            key={item.key}
            name={item.icon}
            className={cn('h-3 w-3 shrink-0', item.color)}
            role="img"
            aria-label={label}
            title={label}
            data-testid={item.testId}
          />
        )
      })}
    </span>
  )
}

export function ProjectsTab() {
  const { t } = useI18n()
  const projects = useProjectsStore(s => s.projects)
  const loadProjects = useProjectsStore(s => s.loadProjects)
  const loadMoreProjects = useProjectsStore(s => s.loadMoreProjects)
  const projectsNextOffset = useProjectsStore(s => s.nextOffset)
  const loadingMoreProjects = useProjectsStore(s => s.loadingMore)
  const deleteProject = useProjectsStore(s => s.deleteProject)
  const sessions = useSessionsStore(s => s.sessions)
  const loadSessions = useSessionsStore(s => s.loadSessions)
  const loadMoreSessions = useSessionsStore(s => s.loadMoreSessions)
  const nextOffset = useSessionsStore(s => s.nextOffset)
  const loadingMoreSessions = useSessionsStore(s => s.loadingMore)
  const createSession = useSessionsStore(s => s.createSession)
  const forkSession = useSessionsStore(s => s.forkSession)
  const deleteSession = useSessionsStore(s => s.deleteSession)
  const moveSession = useSessionsStore(s => s.moveSession)
  const { isTouch } = useDevice()
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapse = useUIStore((s) => s.toggleProjectCollapse)
  const selectedProjectId = useUIStore((s) => s.selectedProjectId)
  const selectProject = useUIStore((s) => s.selectProject)
  const openTab = useUIStore((s) => s.openTab)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const forwardMode = useUIStore((s) => s.forwardMode)
  const sortMode = useSessionsTreeStore(s => s.sortMode)
  const selectionMode = useSessionsTreeStore(s => s.selectionMode)
  const selectedIds = useSessionsTreeStore(s => s.selectedIds)
  const toggleSelected = useSessionsTreeStore(s => s.toggleSelected)
  const turnBySession = useChatStore((s) => s.turnBySession)
  const queueBySession = useChatStore((s) => s.queueBySession)
  // Запросы подтверждения прав (`permission.asked`): ждём действия пользователя.
  const requestsBySession = usePermissionStore((s) => s.requestsBySession)
  // Открытые вопросы агента (`question`/`user_question.*`) — тоже «требуется
  // действие человека» и вход модели бейджа.
  const questionsBySession = useQuestionStore((s) => s.bySession)
  const sessionUnread = useNotificationStore((s) => s.sessionUnread)
  const clearSessionUnread = useNotificationStore((s) => s.clearSessionUnread)
  // Локальные метки «просмотрено» (вход модели бейджа): ключ увиденного исхода
  // совпал с текущим — человек его уже видел, красить нечего. Карта персистится
  // (переживает reload) — см. `notificationStore.ts`.
  const ackedTurnBySession = useNotificationStore((s) => s.ackedTurnBySession)
  // Фоновая активность сессий: значки в дереве (процессы, саб-агенты,
  // терминалы, таймеры/будильники). Реестры подгружаются уже при монтировании
  // панели — значки видны до открытия панели «Процессы»/«Автоматизация».
  const loadActiveRuns = useProcessesStore((s) => s.loadActive)
  const loadTerminals = useTerminalsStore((s) => s.load)
  const loadActiveTimers = useTimersStore((s) => s.loadActive)
  const runsById = useProcessesStore((s) => s.byId)
  const terminalsById = useTerminalsStore((s) => s.terminalsById)
  const timersById = useTimersStore((s) => s.byId)
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

  /**
   * Фоновая активность: активные прогоны, живые терминалы и активные
   * таймеры/будильники.
   *
   * Подгружаются при монтировании панели и обновляются таймерами (прогоны и
   * таймеры — раз в 30 с, терминалы — раз в 60 с). Live-события
   * `terminal.*`/`process.*`/`child.*`/`timer.*` обновляют сторы сами — значки
   * появляются сразу.
   */
  useEffect(() => {
    void loadActiveRuns()
    void loadTerminals()
    void loadActiveTimers()
    const runsTimer = setInterval(() => {
      void loadActiveRuns()
    }, ACTIVITY_RUNS_REFRESH_MS)
    const terminalsTimer = setInterval(() => {
      void loadTerminals()
    }, ACTIVITY_TERMINALS_REFRESH_MS)
    const timersTimer = setInterval(() => {
      void loadActiveTimers()
    }, ACTIVITY_TIMERS_REFRESH_MS)
    return () => {
      clearInterval(runsTimer)
      clearInterval(terminalsTimer)
      clearInterval(timersTimer)
    }
  }, [loadActiveRuns, loadTerminals, loadActiveTimers])

  /** Счётчики активной фоновой работы по сессиям. */
  const sessionActivity = useMemo(
    () =>
      countSessionActivity(
        Object.values(runsById),
        Object.values(terminalsById),
        Object.values(timersById),
      ),
    [runsById, terminalsById, timersById],
  )

  /**
   * Выделение не должно «висеть» после удаления проекта: если выделенного
   * проекта больше нет в списке — снимаем выделение (иначе панели остались
   * бы в проектном контексте удалённого проекта).
   */
  useEffect(() => {
    const selected = useUIStore.getState().selectedProjectId
    if (!selected) return
    if (projects.some((p) => p.id === selected)) return
    // Список ещё грузится — выделение сбрасывать рано (проект мог просто
    // не попасть в первую страницу до перезагрузки списка).
    if (useProjectsStore.getState().loading) return
    useUIStore.getState().selectProject(null)
  }, [projects])

  /**
   * Клик по строке проекта — выделение проекта (повторный клик снимает).
   * В bulk-режиме и в режиме пересылки клик по проекту ничего не меняет.
   */
  const handleProjectClick = useCallback((projectId: string) => {
    if (selectionMode) return
    if (forwardMode.active) return
    selectProject(useUIStore.getState().selectedProjectId === projectId ? null : projectId)
  }, [forwardMode.active, selectProject, selectionMode])

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
    const map: Record<string, SessionData[]> = {}
    const sortFn = sortMode === 'date'
      ? (a: SessionData, b: SessionData) => parseISODate(b.updated_at).getTime() - parseISODate(a.updated_at).getTime()
      : (a: SessionData, b: SessionData) => a.id.localeCompare(b.id)
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
    const map: Record<string, SessionData[]> = {}
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

  /**
   * Живость локального хода сессии.
   *
   * Статус `streaming` у записи хода — необходимое, но **не достаточное**
   * условие: терминальное событие может не дойти или не примениться
   * (несовпадение `turnId`/`stream_id`, разрыв транспорта), и запись навсегда
   * остаётся `streaming`. Второе условие — свежесть: тишина по сессии
   * (`sessionSilenceMs` — от последнего события или от старта хода) не больше
   * порога сторожа `STALE_TURN_SILENCE_MS`.
   *
   * Зачем здесь, а не только в стороже: сторож закрывает ход раз в 30 с и
   * только после сетевой сверки, а точка в дереве всё это время мигала бы.
   * Тишина — достаточный повод перестать мигать: точка становится статичным
   * `busy` (если сервер всё ещё говорит `busy`) или исчезает вовсе.
   *
   * «Молчащий» ход самым скорым тиком сторожа будет закрыт — оба механизма
   * согласованы по одному и тому же порогу.
   */
  const isLiveStreaming = (sessionId: string): boolean => {
    if (turnBySession[sessionId]?.status !== 'streaming') return false
    return sessionSilenceMs(sessionId) <= STALE_TURN_SILENCE_MS
  }

  /**
   * Состояние бейджа сессии: тон названия, точка статуса и ключ подписи.
   *
   * Единственный источник правил — чистая модель `sessionBadgeState`
   * (`lib/sessionBadgeState.ts`): приоритеты (подтверждение → вопрос →
   * остановка → ошибка → работа → завершение → очередь) живут там, а не в
   * дереве. Здесь только сборка входа: DTO сессии + живые счётчики клиента +
   * локальная метка «просмотрено».
   *
   * Счётчик подтверждений в DTO (`pending_approvals`) модель читает сама из
   * `session` — отдельная карта над ним больше не нужна (после перезагрузки
   * страницы живого стора нет, и метку даёт именно DTO).
   */
  const getSessionBadge = (session: SessionData) =>
    sessionBadgeState({
      session,
      live: {
        // ADR-118 §1: единственный живой признак «идёт генерация» — активный ход
        // **и** он не молчит. Статус хода сам по себе — не доказательство: при
        // зависшем ходе (терминальное событие не дошло/не применилось) он
        // остаётся `streaming` навсегда. Отсюда баг: серверный `activity: busy`
        // плюс живой (по сторам) ход держат мигание бесконечно. Тишина больше
        // порога — ход не подтверждён: точка станет `busy`/пропадёт, а сам ход
        // закроет сторож (`useStaleTurnGuard`).
        streaming: isLiveStreaming(session.id),
        queuePending: queueBySession[session.id]?.pendingCount || 0,
        queueStalled: queueBySession[session.id]?.isStalled === true,
        approvalRequests: requestsBySession[session.id]?.length ?? 0,
        hasOpenQuestion: (questionsBySession[session.id] ?? []).some(
          (q) => q.status === 'pending',
        ),
      },
      ackedTurnKey: ackedTurnBySession[session.id] ?? null,
    })

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

  const renderSessionNode = (session: SessionData, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void): TreeNodeBase => {
    const isSubagent = session.session_origin === 'subagent'
    const badge = getSessionBadge(session)
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
      badge: (
        <>
          <OriginBadge origin={session.origin} />
          <SessionActivityBadge activity={sessionActivity.get(session.id)} />
        </>
      ),
      isSelected: selectedIds.has(session.id),
      isTabOpen,
      isActive,
      selectionMode,
      status: badge.dot ?? undefined,
      // Тон названия и ключ подписи — из той же модели (один источник правды
      // с точкой): `error`/`success` смысл несут только цветом + `title`.
      labelTone: badge.labelTone,
      labelAriaKey: badge.ariaKey,
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
        // Перегенерация авто-названия: сервер генерирует заголовок по диалогу
        // и возвращает DTO сессии — заголовок обновляем из ответа.
        { label: t('leftPanel.regenerateTitle'), icon: 'refresh', onClick: async () => {
          await useSessionsStore.getState().regenerateSessionTitle(session.id)
          await loadSessions()
        }},
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
            const result = await synthApi.getSessionMessages(session.id, { limit: MESSAGES_PAGE_LIMIT })
            // История очищена: снимок авторитетен, пагинация сбрасывается.
            applyHistoryPage(session.id, result)
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
        // Переход в сессионный контекст снимает выделение проекта.
        selectProject(null)
        openTab({ id: `chat-${session.id}`, type: 'chat', title: session.name || session.id, data: { sessionId: session.id, projectId: session.project_id || undefined } })
      },
    }
  }

  // Список проектов и список сессий пагинированы (ADR-089): дерево показывает
  // первые страницы обоих списков и кнопки «Показать ещё».
  const hasItems = projects.length > 0 || sessions.length > 0

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
        const projectContextItems: ContextMenuEntry[] = [
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
            visibility={project.visibility}
            offline={isOffline}
            isActive={selectedProjectId === project.id}
            onClick={() => handleProjectClick(project.id)}
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

      {/*
        Пагинация списка проектов: первая страница загружена целиком, дальше —
        по кнопке. Раскрытые проекты и выбранная сессия при этом сохраняются:
        страница дописывается в стор, а не перезагружается.
      */}
      {projectsNextOffset !== null && (
        <div className="px-2 py-1">
          <button
            type="button"
            data-testid="load-more-projects"
            onClick={() => { void loadMoreProjects() }}
            disabled={loadingMoreProjects}
            className="w-full text-left rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-60"
          >
            {loadingMoreProjects ? t('leftPanel.loadingMoreProjects') : t('leftPanel.loadMoreProjects')}
          </button>
        </div>
      )}

      {/*
        Пагинация списка сессий (ADR-089): первая страница загружена целиком,
        дальше — по кнопке. Раскрытые проекты и выбранная сессия при этом
        сохраняются: страница дописывается в стор, а не перезагружается.
      */}
      {nextOffset !== null && (
        <div className="px-2 py-1">
          <button
            type="button"
            data-testid="load-more-sessions"
            onClick={() => { void loadMoreSessions() }}
            disabled={loadingMoreSessions}
            className="w-full text-left rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-60"
          >
            {loadingMoreSessions ? t('leftPanel.loadingMoreSessions') : t('leftPanel.loadMoreSessions')}
          </button>
        </div>
      )}
    </TreeContainer>
  )
}
