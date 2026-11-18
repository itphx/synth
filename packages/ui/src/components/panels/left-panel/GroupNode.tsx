import React, { useCallback } from 'react'
import { TreeNode, TreeChildren } from '@/components/tree'
import type { TreeNodeBase, TreeAction, ContextMenuEntry } from '@/components/tree'
import { OriginBadge } from '@/components/ui/OriginBadge'
import { ProjectAccessBadge } from '@/components/ui/ProjectAccessBadge'
import { useProjectsStore } from '@/stores/projectsStore'
import type { EntityOrigin, ProjectVisibility } from '@/lib/api/synthApi'
import type { useI18n } from '@/lib/i18n'
import { MAX_VISIBLE_SESSIONS } from './constants'
import { SessionTreeItem } from './SessionTreeItem'

/**
 * Минимум полей сессии, который нужен узлу группы: строка дерева и фильтр
 * саб-агентов. Дженерик позволяет прокидывать как сводку из стора
 * (`SessionData`), так и урезанную запись в изолированных тестах компонента.
 */
interface GroupSessionLike {
  id: string
  session_origin?: string | null
}

export function GroupNode<T extends GroupSessionLike>({
  id, label, icon, iconColor, isCollapsed, onToggle,
  sessions, childrenByParentId, expandedGroups, toggleGroupExpand, renderSessionNode,
  expandedSessions, toggleSessionExpand,
  projectId, onCreateSession, onDropSession,
  projectActions, projectContextItems, t,
  origin, visibility, offline, isTouch,
  isActive, onClick,
  isRenaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
}: {
  id: string; label: string; icon: string; iconColor?: string
  isCollapsed: boolean; onToggle: () => void
  sessions: T[]; childrenByParentId: Record<string, T[]>
  expandedGroups: Set<string>; toggleGroupExpand: (k: string) => void
  renderSessionNode: (session: T, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void) => TreeNodeBase
  expandedSessions: Set<string>; toggleSessionExpand: (id: string) => void
  projectId: string | null; onCreateSession: () => void; onDropSession: (sid: string) => void
  projectActions?: TreeAction[]; projectContextItems?: ContextMenuEntry[]
  origin?: EntityOrigin
  /** PROP-133: режим доступа к проекту (бейдж в строке дерева). */
  visibility?: ProjectVisibility
  offline?: boolean
  isTouch?: boolean
  t: ReturnType<typeof useI18n>['t']
  /** Проект выделен в дереве (визуал выделения + приоритет контекста). */
  isActive?: boolean
  /** Клик по строке проекта (выделение проекта). */
  onClick?: () => void
  isRenaming?: boolean; renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void
}) {
  const expandKey = projectId ? `project:${projectId}` : `group:__none__`
  const isExpanded = expandedGroups.has(expandKey)
  const rootSessions = sessions.filter((s) => s.session_origin !== 'subagent')
  const visibleSessions = isExpanded ? rootSessions : rootSessions.slice(0, MAX_VISIBLE_SESSIONS)
  const remaining = rootSessions.length - visibleSessions.length
  const totalCount = sessions.length

  // ADR-140 Ф2: состав грантов для бейджа доступа — из проекта в сторе
  // (по группам и по пользователям: подпись бейджа зависит от обеих осей).
  const accessProject = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  )

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
    badge: (
      <>
        <OriginBadge origin={origin} />
        <ProjectAccessBadge
          visibility={visibility}
          groupMembers={accessProject?.group_members}
          members={accessProject?.members}
        />
      </>
    ),
    actions,
    contextItems: projectContextItems,
    isActive,
    onClick,
    isRenaming,
    renameValue,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
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
