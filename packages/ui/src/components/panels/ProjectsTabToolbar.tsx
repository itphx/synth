import React, { useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import type { EntityOrigin } from '@/lib/api/synthApi'

type PopoverType = null | 'project' | 'session'

/** Селектор «где создать» (гибридный режим): Локально / На сервере. При offline — только «Локально». */
function OriginSelector({ value, onChange, offline }: { value: EntityOrigin; onChange: (v: EntityOrigin) => void; offline: boolean }) {
  const { t } = useI18n()
  const shownValue = offline ? ('local' as EntityOrigin) : value
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.65rem] text-muted-foreground">{t('hybrid.createWhere')}</span>
      <Select value={shownValue} onValueChange={(v) => onChange((v || 'local') as EntityOrigin)}>
        <SelectTrigger size="sm" disabled={offline} className="w-full text-xs border-0 bg-interactive rounded">
          <span className="truncate flex-1 text-left">
            {shownValue === 'remote' ? t('hybrid.createRemote') : t('hybrid.createLocal')}
          </span>
          <Icon name="arrow-down-s" className="size-3.5 opacity-50 shrink-0" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{t('hybrid.createLocal')}</SelectItem>
          {!offline && <SelectItem value="remote">{t('hybrid.createRemote')}</SelectItem>}
        </SelectContent>
      </Select>
      {offline && <span className="text-[0.65rem] text-destructive">{t('hybrid.offlineShort')}</span>}
    </div>
  )
}

export const ProjectsTabToolbar: React.FC = () => {
  const { t } = useI18n()
  const {
    sortMode,
    toggleSortMode,
    selectionMode,
    toggleSelectionMode,
  } = useSessionsTreeStore()
  const { projects } = useProjectsStore()
  const { createProject } = useProjectsStore()
  const { createSession } = useSessionsStore()
  const { collapsedProjects } = useUIStore()
  const hybridEnabled = useHybridStore((s) => s.enabled)
  const isOffline = useHybridStore(selectIsOffline)
  const openTab = useUIStore((s) => s.openTab)

  const [popover, setPopover] = useState<PopoverType>(null)
  const [projectName, setProjectName] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [sessionProjectId, setSessionProjectId] = useState<string | null>(null)
  // Гибридный режим: где создать сущность — локально или на удалённом сервере.
  const [createOrigin, setCreateOrigin] = useState<EntityOrigin>('local')

  const handleCreateProject = async () => {
    const name = projectName.trim()
    if (!name) return
    await createProject({ name, origin: createOrigin })
    setPopover(null)
  }

  const handleCreateSession = async () => {
    const name = sessionName.trim() || undefined
    const result = await createSession({ name, project_id: sessionProjectId, origin: createOrigin })
    if (result) {
      setPopover(null)
      openTab({
        id: 'chat-' + result.id,
        type: 'chat',
        title: result.name || result.id,
        data: { sessionId: result.id, projectId: result.project_id || undefined },
      })
    }
  }

  const handleOpenChange = (type: PopoverType) => (open: boolean) => {
    if (open) {
      setProjectName('')
      setSessionName('')
      setSessionProjectId(null)
      setCreateOrigin('local')
      setPopover(type)
    } else {
      setPopover(null)
    }
  }

  const handleToggleAll = () => {
    const { projects } = useProjectsStore.getState()
    const { collapsedProjects, toggleProjectCollapse } = useUIStore.getState()
    const allCollapsed = projects.every(p => collapsedProjects.has(p.id)) && collapsedProjects.has('__none__')
    for (const p of projects) {
      if (allCollapsed === collapsedProjects.has(p.id)) {
        toggleProjectCollapse(p.id)
      }
    }
    if (allCollapsed === collapsedProjects.has('__none__')) {
      toggleProjectCollapse('__none__')
    }
  }

  const allCollapsed = collapsedProjects.has('__none__') && projects.every(p => collapsedProjects.has(p.id))

  return (
    <div className="flex items-center gap-0.5 ml-auto">
      <button
        onClick={handleToggleAll}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
        title={allCollapsed ? t('leftPanel.expandAll') : t('leftPanel.collapseAll')}
      >
        <Icon name={allCollapsed ? 'arrow-down-s' : 'arrow-up-s'} className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
      <Popover open={popover === 'project'} onOpenChange={handleOpenChange('project')}>
        <PopoverTrigger asChild>
          <button
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              popover === 'project'
                ? 'bg-interactive-hover text-foreground'
                : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
            }`}
            title={t('leftPanel.newProject')}
          >
            <Icon name="folder-add" className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-56 p-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <form
            onSubmit={(e) => { e.preventDefault(); handleCreateProject() }}
            className="flex flex-col gap-2"
          >
            <input
              autoFocus
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t('leftPanel.projectName')}
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
            />
            {hybridEnabled && <OriginSelector value={createOrigin} onChange={setCreateOrigin} offline={isOffline} />}
            <button type="submit" className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10">
              {t('common.create')}
            </button>
          </form>
        </PopoverContent>
      </Popover>

      <Popover open={popover === 'session'} onOpenChange={handleOpenChange('session')}>
        <PopoverTrigger asChild>
          <button
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              popover === 'session'
                ? 'bg-interactive-hover text-foreground'
                : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
            }`}
            title={t('leftPanel.newSession')}
          >
            <Icon name="chat-new" className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-56 p-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            const target = e.target as HTMLElement
            if (target.closest('[data-slot="select-content"]') || target.closest('[data-slot="select-item"]')) {
              e.preventDefault()
            }
          }}
        >
          <form
            onSubmit={(e) => { e.preventDefault(); handleCreateSession() }}
            className="flex flex-col gap-2"
          >
            <input
              autoFocus
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder={t('leftPanel.sessionName')}
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
            />
            <Select value={sessionProjectId ?? ''} onValueChange={(v) => setSessionProjectId(v || null)}>
              <SelectTrigger size="sm" className="w-full text-xs border-0 bg-interactive rounded">
                <span className="truncate flex-1 text-left">
                  {sessionProjectId ? (projects.find(p => p.id === sessionProjectId)?.name ?? sessionProjectId) : t('leftPanel.noProject')}
                </span>
                <Icon name="arrow-down-s" className="size-3.5 opacity-50 shrink-0" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('leftPanel.noProject')}</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hybridEnabled && <OriginSelector value={createOrigin} onChange={setCreateOrigin} offline={isOffline} />}
            <button type="submit" className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10">
              {t('common.create')}
            </button>
          </form>
        </PopoverContent>
      </Popover>

      <div className="mx-0.5 h-4 w-px bg-sidebar-border" />
      <button
        onClick={toggleSelectionMode}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          selectionMode
            ? 'bg-interactive-hover text-primary'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        }`}
        title={selectionMode ? t('leftPanel.exitSelection') : t('leftPanel.selectSessions')}
      >
        <Icon name="checkbox-multiple" className="h-4 w-4" />
      </button>
      <button
        onClick={toggleSortMode}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          sortMode === 'name'
            ? 'bg-interactive-hover text-primary'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        }`}
        title={sortMode === 'date' ? t('leftPanel.sortByName') : t('leftPanel.sortByDate')}
      >
        <Icon name="expand-up-down" className="h-4 w-4" />
      </button>
    </div>
  )
}
