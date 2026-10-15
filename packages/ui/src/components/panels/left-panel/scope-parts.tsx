import React from 'react'
import { Icon } from '@/components/icon/Icon'
import { TreeNode } from '@/components/tree'
import { OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'

// ---- Project scope (variant C) — общие блоки для вкладок Files/Git ----

/** Закреплённая шапка блока «Текущий проект». */
export function CurrentProjectHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1 px-2 pt-1 pb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
      <Icon name="pushpin" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  )
}

/** Инфо-строка фоллбеков «нет проекта / нет workspace». */
export function ScopeHint({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon name="information" className="size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </div>
  )
}

/** Сворачиваемая обёртка «Другие проекты (N)». */
export function OtherProjectsGroup({
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
