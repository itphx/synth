import React, { useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { OriginSelector } from '@/components/ui/OriginSelector'
import { CreateProjectPopover } from '@/components/panels/CreateProjectPopover'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import type { EntityOrigin } from '@/lib/api/synthApi'

type PopoverType = null | 'session'

export const ProjectsTabToolbar: React.FC = () => {
  const { t } = useI18n()
  const sortMode = useSessionsTreeStore(s => s.sortMode)
  const toggleSortMode = useSessionsTreeStore(s => s.toggleSortMode)
  const selectionMode = useSessionsTreeStore(s => s.selectionMode)
  const toggleSelectionMode = useSessionsTreeStore(s => s.toggleSelectionMode)
  const projects = useProjectsStore(s => s.projects)
  const createSession = useSessionsStore(s => s.createSession)
  const collapsedProjects = useUIStore(s => s.collapsedProjects)
  const hybridEnabled = useHybridStore((s) => s.enabled)
  const isOffline = useHybridStore(selectIsOffline)
  const openTab = useUIStore((s) => s.openTab)

  const [popover, setPopover] = useState<PopoverType>(null)
  const [sessionProjectId, setSessionProjectId] = useState<string | null>(null)
  // Гибридный режим: где создать сущность — локально или на удалённом сервере.
  const [createOrigin, setCreateOrigin] = useState<EntityOrigin>('local')

  const handleCreateSession = async () => {
    const selectedProject = sessionProjectId ? projects.find((p) => p.id === sessionProjectId) : null
    // Гибрид: remote-сессия не может ссылаться на ЛОКАЛЬНЫЙ проект (сервер его не
    // знает) — в этом случае создаём на сервере сессию без проекта. Обратная
    // комбинация (origin local + remote-проект) исключена в UI: выбор remote-проекта
    // принудительно фиксирует origin 'remote'.
    const project_id = createOrigin === 'remote' && selectedProject && selectedProject.origin !== 'remote'
      ? null
      : sessionProjectId
    const result = await createSession({ project_id, origin: createOrigin })
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
      setSessionProjectId(null)
      setCreateOrigin('local')
      setPopover(type)
    } else {
      setPopover(null)
    }
  }

  // Выбор проекта в поповере сессии. Проект принадлежит одному из миров: remote-проект
  // может содержать только remote-сессии, локальный — только локальные. Поэтому выбор
  // проекта фиксирует origin (для remote-проекта селектор «где создать» блокируется).
  const handleProjectSelect = (value: string) => {
    const pid = value || null
    setSessionProjectId(pid)
    const project = pid ? projects.find((p) => p.id === pid) : null
    if (project) setCreateOrigin(project.origin === 'remote' ? 'remote' : 'local')
  }

  // Смена «где создать». Remote-мир не знает локальные проекты — если выбран локальный
  // проект, сбрасываем привязку на «без проекта» (иначе получится битая комбинация).
  const handleOriginChange = (origin: EntityOrigin) => {
    setCreateOrigin(origin)
    if (origin === 'remote' && sessionProjectId) {
      const project = projects.find((p) => p.id === sessionProjectId)
      if (project && project.origin !== 'remote') setSessionProjectId(null)
    }
  }

  // Если выбран remote-проект — origin 'remote' обязателен: локальная сессия внутри
  // удалённого проекта невозможна (локальный мир его не знает).
  const originLocked = !!sessionProjectId && projects.find((p) => p.id === sessionProjectId)?.origin === 'remote'

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
      <CreateProjectPopover
        trigger={
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('leftPanel.newProject')}
          >
            <Icon name="folder-add" className="h-4 w-4" />
          </button>
        }
      />

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
            <Select value={sessionProjectId ?? ''} onValueChange={handleProjectSelect}>
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
            {hybridEnabled && (
              <>
                <OriginSelector value={createOrigin} onChange={handleOriginChange} offline={isOffline} disabled={originLocked} />
                {createOrigin === 'remote' && !sessionProjectId && (
                  <p className="text-[0.65rem] text-muted-foreground">{t('hybrid.createRemoteNoProject')}</p>
                )}
              </>
            )}
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
