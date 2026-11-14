import { useEffect, useRef, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { OriginSelector } from '@/components/ui/OriginSelector'
import { DirectoryPickerDialog } from '@/components/ui/DirectoryPickerDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MultiSelectField } from '@/components/ui/settings'
import { Toggle } from '@/components/ui/Toggle'
import { useProjectsStore } from '@/stores/projectsStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useAuthStore } from '@/stores/authStore'
import { selectHasFeature, useInstanceCapabilitiesStore } from '@/stores/instanceCapabilitiesStore'
import { useI18n } from '@/lib/i18n'
import { useUsersDirectory } from '@/hooks/useUsersDirectory'
import {
  buildProjectAccessBody,
  projectAccessDraftAfterProjection,
  type ProjectAccessProjection,
  type ProjectGrantRole,
} from '@/lib/projectAccess'
import { ProjectAccessProjectionField } from '@/components/ui/ProjectAccessProjectionField'
import type { ProjectData, EntityOrigin } from '@/lib/api/synthApi'

/**
 * Переиспользуемый поповер создания проекта: имя + (ADR-075) рабочий каталог +
 * (в гибриде) выбор «где создать» + (PROP-133 §4) проекция доступа.
 * Используется и в левой панели (ProjectsTabToolbar), и в правой (ProjectTab).
 */
export function CreateProjectPopover({
  trigger,
  align = 'end',
  onCreated,
  onError,
}: {
  trigger: React.ReactNode
  align?: 'start' | 'center' | 'end'
  onCreated?: (project: ProjectData) => void | Promise<void>
  onError?: (error?: unknown) => void
}) {
  const { t } = useI18n()
  const createProject = useProjectsStore(s => s.createProject)
  const hybridEnabled = useHybridStore((s) => s.enabled)
  const isOffline = useHybridStore(selectIsOffline)
  const deployment = useAuthStore((s) => s.deployment)

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [origin, setOrigin] = useState<EntityOrigin>('local')
  const [workspace, setWorkspace] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // PROP-133 §4: проекция доступа при создании. По умолчанию «Только автору» —
  // состояние, одинаковое у всех существующих проектов (совместимость).
  const [projection, setProjection] = useState<ProjectAccessProjection>('author')
  const [members, setMembers] = useState<Record<string, ProjectGrantRole>>({})
  const [everyoneRole, setEveryoneRole] = useState<ProjectGrantRole>('viewer')

  // Признак «инстанс обслуживает /users*» (PROP-125): без него выбирать
  // участников нечем — предлагается только «Только автору».
  const hasUsers = useInstanceCapabilitiesStore(selectHasFeature('users'))
  useEffect(() => {
    void useInstanceCapabilitiesStore.getState().load()
  }, [])
  const directory = useUsersDirectory(hasUsers, { limit: 50 })

  // Пикер каталога и подтверждение рендерятся порталом: фокус уходит из поповера,
  // и Radix (non-modal Popover) шлёт onOpenChange(false). Пока вложенный диалог
  // открыт, закрытие поповера игнорируем — иначе диалог закрывается вместе с ним.
  const nestedDialogOpenRef = useRef(false)
  nestedDialogOpenRef.current = pickerOpen || confirmOpen

  // ADR-075: managed — ФС принадлежит backend, remote-проект живёт на сервере;
  // в обоих случаях каталог создаётся автоматически, путь не передаём.
  const workspaceReadOnly = deployment === 'managed' || origin === 'remote'

  const handleOpenChange = (next: boolean) => {
    if (!next && nestedDialogOpenRef.current) return
    if (next) {
      setName('')
      setOrigin('local')
      setWorkspace('')
      setError(null)
      setProjection('author')
      setMembers({})
      setEveryoneRole('viewer')
    } else {
      setPickerOpen(false)
      setConfirmOpen(false)
    }
    setOpen(next)
  }

  const preventNestedDismiss = (event: Event) => {
    if (nestedDialogOpenRef.current) event.preventDefault()
  }

  /** Смена проекции — переход между состояниями одного списка доступа. */
  const handleProjectionChange = (next: ProjectAccessProjection) => {
    if (next === projection) return
    // Правило перехода — в `lib/projectAccess` (единственный источник правды).
    const draft = projectAccessDraftAfterProjection(next, projection, members, everyoneRole)
    setProjection(draft.projection)
    setMembers(draft.members)
    setEveryoneRole(draft.everyoneRole)
  }

  const handleMembersChange = (next: string[]) => {
    setMembers((prev) => {
      const out: Record<string, ProjectGrantRole> = {}
      for (const id of next) out[id] = prev[id] ?? 'viewer'
      return out
    })
  }

  /**
   * ADR-075: создание проекта. При 409 `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`
   * (путь вне `workspacesRoot`, политика confirm) показывает ConfirmDialog и
   * повторяет запрос с `confirmOutsideRoot: true`.
   */
  const doCreate = async (confirmOutsideRoot = false) => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // PROP-133: состояние доступа уходит только когда проекция выбрана явно
      // («выбранным»/«всем»); «только автору» — обычное создание, поля не
      // нужны (совместимость с прежним поведением).
      const accessBody =
        projection === 'author' ? {} : buildProjectAccessBody(projection, members, everyoneRole)
      const created = await createProject({
        name: trimmed,
        origin,
        ...(!workspaceReadOnly && workspace.trim() ? { workspace: workspace.trim() } : {}),
        ...(confirmOutsideRoot ? { confirmOutsideRoot: true } : {}),
        ...accessBody,
      })
      setError(null)
      setOpen(false)
      await onCreated?.(created)
    } catch (err) {
      if (!confirmOutsideRoot && (err as { code?: string })?.code === 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED') {
        setConfirmOpen(true)
        return
      }
      const detail = err instanceof Error ? err.message : String(err)
      setError(t('createProject.error', { error: detail }))
      onError?.(err)
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = async () => {
    await doCreate(false)
  }

  const confirmOutsideCreate = () => {
    void doCreate(true)
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          align={align}
          className="w-64 p-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={preventNestedDismiss}
          onEscapeKeyDown={preventNestedDismiss}
        >
          <form
            onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}
            className="flex flex-col gap-2"
          >
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('leftPanel.projectName')}
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none w-full"
            />
            {hybridEnabled && <OriginSelector value={origin} onChange={setOrigin} offline={isOffline} />}

            {workspaceReadOnly ? (
              <div
                className="text-[0.65rem] text-muted-foreground/80 break-words"
                data-testid="create-project-workspace-readonly"
              >
                {t('workspace.autoManaged')}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="text-[0.65rem] text-muted-foreground">{t('projectTab.workspace.title')}</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                    placeholder={t('projectTab.workspace.placeholder')}
                    className="flex-1 min-w-0 rounded bg-interactive px-2 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground outline-none"
                    data-testid="create-project-workspace"
                  />
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-interactive-hover transition-colors"
                    data-testid="create-project-workspace-browse"
                  >
                    {t('workspace.select')}
                  </button>
                </div>
              </div>
            )}

            {/* PROP-133 §4: проекция доступа при создании. */}
            {hasUsers && (
              <div className="flex flex-col gap-1" data-testid="create-project-access">
                <span className="text-[0.65rem] text-muted-foreground">
                  {t('project.access.createTitle')}
                </span>
                <ProjectAccessProjectionField
                  value={projection}
                  options={[
                    { value: 'author', label: t('project.access.author') },
                    { value: 'selected', label: t('project.access.selected') },
                    { value: 'all', label: t('project.access.all') },
                  ]}
                  onChange={handleProjectionChange}
                  ariaLabel={t('project.access.createTitle')}
                  testIdPrefix="create-project-access"
                />

                {projection === 'selected' && (
                  <div className="flex flex-col gap-1" data-testid="create-project-access-selected-users">
                    <input
                      type="search"
                      value={directory.query}
                      onChange={(e) => directory.setQuery(e.target.value)}
                      placeholder={t('project.access.usersSearch')}
                      aria-label={t('project.access.usersSearch')}
                      className="w-full min-w-0 rounded bg-interactive px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none"
                      data-testid="create-project-access-user-search"
                    />
                    <MultiSelectField
                      label={t('project.access.users')}
                      values={Object.keys(members)}
                      options={directory.users.map((u) => ({
                        value: u.id,
                        label: u.display_name || u.username,
                      }))}
                      onChange={handleMembersChange}
                      testIdPrefix="create-project-access-user"
                      emptyText={directory.loading ? t('common.loading') : t('project.access.usersEmpty')}
                    />
                    {directory.failed && (
                      <div
                        className="text-[0.65rem] text-destructive break-words"
                        data-testid="create-project-access-users-error"
                      >
                        {t('project.access.usersLoadError')}
                      </div>
                    )}
                  </div>
                )}

                {projection === 'all' && (
                  <label
                    className="flex items-center justify-between gap-2 text-[0.65rem] text-foreground"
                    data-testid="create-project-access-all-editor"
                  >
                    <span className="min-w-0">{t('project.access.allowEdit')}</span>
                    <Toggle
                      enabled={everyoneRole === 'editor'}
                      onToggle={() =>
                        setEveryoneRole(everyoneRole === 'editor' ? 'viewer' : 'editor')
                      }
                      ariaLabel={t('project.access.allowEdit')}
                    />
                  </label>
                )}
              </div>
            )}

            {error && (
              <div
                role="alert"
                data-testid="create-project-error"
                className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[0.65rem] text-destructive break-words"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="self-end rounded px-3 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
              data-testid="create-project-submit"
            >
              {t('common.create')}
            </button>
          </form>
        </PopoverContent>
      </Popover>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={workspace}
        onSelect={(path) => setWorkspace(path)}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('workspace.outsideRootConfirmTitle')}
        message={t('workspace.outsideRootConfirmMessage', { path: workspace })}
        variant="warning"
        confirmLabel={t('common.create')}
        onConfirm={confirmOutsideCreate}
      />
    </>
  )
}
