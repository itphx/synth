import React, { useState, useEffect, useRef } from 'react'
import { Icon } from '@/components/icon/Icon'
import { useSessionsTreeStore } from '@/stores/useSessionsTreeStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

type PopoverType = null | 'project' | 'session'

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

  const [popover, setPopover] = useState<PopoverType>(null)
  const [projectName, setProjectName] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [sessionProjectId, setSessionProjectId] = useState<string | null>(null)

  const projectInputRef = useRef<HTMLInputElement>(null)
  const sessionInputRef = useRef<HTMLInputElement>(null)
  const projectRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (popover === 'project') {
      setProjectName('')
      setTimeout(() => projectInputRef.current?.focus(), 0)
    }
    if (popover === 'session') {
      setSessionName('')
      setSessionProjectId(null)
      setTimeout(() => sessionInputRef.current?.focus(), 0)
    }
  }, [popover])

  useEffect(() => {
    if (!popover) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const inProject = projectRef.current?.contains(target)
      const inSession = sessionRef.current?.contains(target)
      const inSelect = target.closest('[data-slot="select-content"]') !== null || target.closest('[data-slot="select-item"]') !== null
      if (!inProject && !inSession && !inSelect) setPopover(null)
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handler)
    }
  }, [popover])

  const handleCreateProject = async () => {
    const name = projectName.trim()
    if (!name) return
    await createProject({ name })
    setPopover(null)
  }

  const handleCreateSession = async () => {
    const name = sessionName.trim() || undefined
    const result = await createSession({ name, project_id: sessionProjectId })
    if (result) setPopover(null)
  }

  const togglePopover = (type: PopoverType) => {
    setPopover(popover === type ? null : type)
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
      <div className="relative" ref={projectRef}>
        <button
          onClick={() => togglePopover('project')}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            popover === 'project'
              ? 'bg-interactive-hover text-foreground'
              : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
          }`}
          title={t('leftPanel.newProject')}
        >
          <Icon name="folder-add" className="h-4 w-4" />
        </button>
        {popover === 'project' && (
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border bg-background shadow-md p-3">
            <form
              onSubmit={(e) => { e.preventDefault(); handleCreateProject() }}
              className="flex flex-col gap-2"
            >
              <input
                ref={projectInputRef}
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t('leftPanel.projectName')}
                className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
                onKeyDown={(e) => { if (e.key === 'Escape') setPopover(null) }}
              />
              <button type="submit" className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10">
                {t('common.create')}
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="relative" ref={sessionRef}>
        <button
          onClick={() => togglePopover('session')}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            popover === 'session'
              ? 'bg-interactive-hover text-foreground'
              : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
          }`}
          title={t('leftPanel.newSession')}
        >
          <Icon name="chat-new" className="h-4 w-4" />
        </button>
        {popover === 'session' && (
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border bg-background shadow-md p-3">
            <form
              onSubmit={(e) => { e.preventDefault(); handleCreateSession() }}
              className="flex flex-col gap-2"
            >
              <input
                ref={sessionInputRef}
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder={t('leftPanel.sessionName')}
                className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
                onKeyDown={(e) => { if (e.key === 'Escape') setPopover(null) }}
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
              <button type="submit" className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10">
                {t('common.create')}
              </button>
            </form>
          </div>
        )}
      </div>

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
