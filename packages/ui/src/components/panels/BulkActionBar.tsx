import React from 'react'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { Icon } from '@/components/icon/Icon'
import { ContextMenu } from '@/components/ui/contextMenu'
import { PROJECT_ICON_MAP } from '@/lib/projectMeta'
import { useI18n } from '@/lib/i18n'

export const BulkActionBar: React.FC = () => {
  const { t } = useI18n()
  const { projects } = useProjectsStore()
  const { moveSession, deleteSession } = useSessionsStore()
  const { selectedIds, clearSelection, toggleSelectionMode } = useSessionsTreeStore()
  const count = selectedIds.size

  const handleMove = async (projectId: string | null) => {
    for (const id of selectedIds) {
      await moveSession(id, projectId)
    }
    clearSelection()
    toggleSelectionMode()
  }

  const handleDelete = async () => {
    if (!window.confirm(t('leftPanel.confirmBulkDelete', { count: String(count) }))) return
    for (const id of selectedIds) {
      await deleteSession(id)
    }
    clearSelection()
    toggleSelectionMode()
  }

  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-1">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {t('leftPanel.bulkSelectedCount', { count: String(count) })}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <ContextMenu
          trigger={
            <button className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
              <Icon name="folder-received" className="h-3.5 w-3.5" />
            </button>
          }
          items={[
            { label: t('leftPanel.noProject'), icon: 'chat-new' as const, onClick: () => handleMove(null) },
            'separator' as const,
            ...projects.map((p) => ({
              label: p.name,
              icon: (p.icon ? PROJECT_ICON_MAP[p.icon] : 'folder-3') as typeof PROJECT_ICON_MAP[keyof typeof PROJECT_ICON_MAP],
              onClick: () => handleMove(p.id),
            })),
          ]}
          align="end"
          sideOffset={4}
        />
        <button
          onClick={handleDelete}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-status-error/10 hover:text-status-error"
        >
          <Icon name="delete-bin" className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={toggleSelectionMode}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
