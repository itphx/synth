import { TreeNode } from '@/components/tree'
import type { TreeNodeBase } from '@/components/tree'

/**
 * Минимум полей сессии для строки дерева: `id` (ключ и адрес раскрытия).
 * Дженерик — чтобы принимать и сводку из стора (`SessionData`), и урезанную
 * запись в изолированных тестах компонента.
 */
interface SessionTreeItemLike {
  id: string
}

export function SessionTreeItem<T extends SessionTreeItemLike>({
  session,
  depth,
  childrenByParentId,
  renderSessionNode,
  expandedSessions,
  onToggleExpand,
}: {
  session: T
  depth: number
  childrenByParentId: Record<string, T[]>
  renderSessionNode: (session: T, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void) => TreeNodeBase
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
