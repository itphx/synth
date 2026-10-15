import { useEffect, useState } from 'react'

import type { EntityOrigin, SessionData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { OriginSelector } from '@/components/ui/OriginSelector'
import { useI18n } from '@/lib/i18n'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useUIStore } from '@/stores/useUIStore'

export interface SessionCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Предзаполненный проект (id); `null`/не задан — «без проекта». */
  initialProjectId?: string | null
  /** Вызывается после успешного создания (например, чтобы выбрать новую сессию). */
  onCreated?: (session: SessionData) => void
}

/**
 * ADR-089: единый диалог создания сессии. Используется левой панелью
 * (`ProjectsTabToolbar`) и формами событий/шедулера («+» у селекта сессии).
 * Проект предзаполняется; в гибриде доступен выбор «где создать» (домен origin).
 */
export function SessionCreateDialog({
  open,
  onOpenChange,
  initialProjectId,
  onCreated,
}: SessionCreateDialogProps) {
  const { t } = useI18n()
  const projects = useProjectsStore((s) => s.projects)
  const createSession = useSessionsStore((s) => s.createSession)
  const openTab = useUIStore((s) => s.openTab)
  const hybridEnabled = useHybridStore((s) => s.enabled)
  const isOffline = useHybridStore(selectIsOffline)

  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null)
  const [origin, setOrigin] = useState<EntityOrigin>('local')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void useProjectsStore.getState().loadProjects()
  }, [])

  // Предзаполнение/сброс при каждом открытии диалога.
  useEffect(() => {
    if (!open) return
    const pid = initialProjectId ?? null
    setProjectId(pid)
    setError(null)
    setCreating(false)
    const project = pid ? useProjectsStore.getState().projects.find((p) => p.id === pid) : null
    setOrigin(project?.origin === 'remote' ? 'remote' : 'local')
  }, [open, initialProjectId])

  const selectedProject = projectId ? projects.find((p) => p.id === projectId) : null
  // Remote-сессия не может ссылаться на локальный проект — создаём без проекта.
  const originLocked = selectedProject?.origin === 'remote'

  const handleProjectSelect = (value: string) => {
    const pid = value || null
    setProjectId(pid)
    const project = pid ? projects.find((p) => p.id === pid) : null
    if (project) setOrigin(project.origin === 'remote' ? 'remote' : 'local')
  }

  const handleOriginChange = (next: EntityOrigin) => {
    setOrigin(next)
    if (next === 'remote' && selectedProject && selectedProject.origin !== 'remote') {
      setProjectId(null)
    }
  }

  const handleCreate = async () => {
    const resolvedProjectId =
      origin === 'remote' && selectedProject && selectedProject.origin !== 'remote'
        ? null
        : projectId
    setCreating(true)
    setError(null)
    const result = await createSession({ project_id: resolvedProjectId, origin })
    setCreating(false)
    if (!result) {
      setError(t('common.error'))
      return
    }
    openTab({
      id: 'chat-' + result.id,
      type: 'chat',
      title: result.name || result.id,
      data: { sessionId: result.id, projectId: result.project_id || undefined },
    })
    onCreated?.(result)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="session-create-dialog">
        <h2 className="text-sm font-medium text-foreground break-words">
          {t('leftPanel.newSession')}
        </h2>

        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-xs text-muted-foreground">{t('sessionCreate.project')}</span>
          <Select value={projectId ?? ''} onValueChange={handleProjectSelect}>
            <SelectTrigger size="sm" className="w-full text-xs" data-testid="session-create-project">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedProject?.name ?? t('leftPanel.noProject')}
              </span>
              <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-50" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('leftPanel.noProject')}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {hybridEnabled && (
          <>
            <OriginSelector
              value={origin}
              onChange={handleOriginChange}
              offline={isOffline}
              disabled={originLocked}
            />
            {origin === 'remote' && !projectId && (
              <p className="text-xs text-muted-foreground">{t('hybrid.createRemoteNoProject')}</p>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline-muted"
            onClick={() => onOpenChange(false)}
            disabled={creating}
            data-testid="session-create-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCreate()}
            disabled={creating}
            data-testid="session-create-submit"
          >
            {creating ? t('common.saving') : t('common.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
