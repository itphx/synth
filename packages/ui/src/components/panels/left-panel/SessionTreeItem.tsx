import { TreeNode } from '@/components/tree'
import type { TreeNodeBase } from '@/components/tree'

export function SessionTreeItem({
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
