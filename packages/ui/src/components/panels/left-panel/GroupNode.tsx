import React, { useCallback } from 'react'
import { TreeNode, TreeChildren } from '@/components/tree'
import type { TreeNodeBase, TreeAction } from '@/components/tree'
import { OriginBadge } from '@/components/ui/OriginBadge'
import type { EntityOrigin } from '@/lib/api/synthApi'
import { MAX_VISIBLE_SESSIONS } from './constants'
import { SessionTreeItem } from './SessionTreeItem'

export function GroupNode({
  id, label, icon, iconColor, isCollapsed, onToggle,
  sessions, childrenByParentId, expandedGroups, toggleGroupExpand, renderSessionNode,
  expandedSessions, toggleSessionExpand,
  projectId, onCreateSession, onDropSession,
  projectActions, projectContextItems, t,
  origin, offline, isTouch,
  isRenaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
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
