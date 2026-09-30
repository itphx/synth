import { useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { OriginSelector } from '@/components/ui/OriginSelector'
import { DirectoryPickerDialog } from '@/components/ui/DirectoryPickerDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useProjectsStore } from '@/stores/projectsStore'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import type { ProjectData, EntityOrigin } from '@/lib/api/synthApi'

/**
 * Переиспользуемый поповер создания проекта: имя + (AD-075) рабочий каталог +
 * (в гибриде) выбор «где создать». Используется и в левой панели
 * (ProjectsTabToolbar), и в правой (ProjectTab).
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
  onError?: () => void
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

  // AD-075: managed — ФС принадлежит backend, remote-проект живёт на сервере;
  // в обоих случаях каталог создаётся автоматически, путь не передаём.
  const workspaceReadOnly = deployment === 'managed' || origin === 'remote'

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName('')
      setOrigin('local')
      setWorkspace('')
    } else {
      setPickerOpen(false)
      setConfirmOpen(false)
    }
    setOpen(next)
  }

  /**
   * AD-075: создание проекта. При 409 `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`
   * (путь вне `workspacesRoot`, политика confirm) показывает ConfirmDialog и
   * повторяет запрос с `confirmOutsideRoot: true`.
   */
  const doCreate = async (confirmOutsideRoot = false) => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      const created = await createProject({
        name: trimmed,
        origin,
        ...(!workspaceReadOnly && workspace.trim() ? { workspace: workspace.trim() } : {}),
        ...(confirmOutsideRoot ? { confirmOutsideRoot: true } : {}),
      })
      setOpen(false)
      await onCreated?.(created)
    } catch (err) {
      if (!confirmOutsideRoot && (err as { code?: string })?.code === 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED') {
        setConfirmOpen(true)
        return
      }
      onError?.()
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
