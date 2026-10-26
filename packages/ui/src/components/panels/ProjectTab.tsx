import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { usePanelSettingSave } from '@/hooks/usePanelSettingSave'
import { formatDateTime } from '@/lib/formatDate'
import { synthApi, type ProjectData, type ProjectMcpResponse, type ProjectSkillsResponse, type EffectiveSkillEntry } from '@/lib/api/synthApi'
import type { WorktreeSummary } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/button'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { InfoField as Field, InfoSection as Section } from '@/components/ui/settings'
import { DirectoryPickerDialog } from '@/components/ui/DirectoryPickerDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CreateProjectPopover } from '@/components/panels/CreateProjectPopover'
import { ExpandableListRow, RowBadge } from '@/components/panels/ExpandableListRow'
import { PanelTab } from './PanelTab'
import { useWorktreesStore } from '@/stores/worktreesStore'
import { confirm } from '@/lib/confirm'
import type { ProjectPlan, McpRegistryEntry } from '@itphx/synth-shared'

export function ProjectTab() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId
  const session = useSessionsStore((s) => s.sessions.find((ses) => ses.id === sessionId))

  const [project, setProject] = useState<ProjectData | null>(null)
  const [loading, setLoading] = useState(false)
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  // ADR-075: выбор каталога через FS-диалог + подтверждение пути вне workspacesRoot.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const [invariantsDraft, setInvariantsDraft] = useState('')

  // ADR-071 §2.4: проектный MCP-скоуп (owner/lead/admin)
  const user = useAuthStore((s) => s.user)
  // ADR-075: managed-развёртывание владеет ФС проекта — путь не редактируется.
  const deployment = useAuthStore((s) => s.deployment)
  const [projectMcp, setProjectMcp] = useState<ProjectMcpResponse | null>(null)
  const [mcpRegistry, setMcpRegistry] = useState<McpRegistryEntry[]>([])

  // ADR-046 §4.5: проектный скоуп скиллов (owner/lead/admin)
  const [projectSkills, setProjectSkills] = useState<ProjectSkillsResponse | null>(null)

  const projectId = session?.project_id ?? null
  const projects = useProjectsStore((s) => s.projects)
  // Актуальная запись проекта из стора — единственный источник правды. Локальная
  // копия ниже нужна для черновиков (workspace/invariants), но обязана следовать
  // за стором: изменения извне вкладки (например, `EntityEditDialog`) приходят
  // через `updateProjectInList` и без синхронизации здесь не отображались.
  const storeProject = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) ?? null : null,
  )

  const { run, isPending } = usePanelSettingSave({ sessionId: sessionId || undefined })

  const canManageMcp = !!user && (
    user.roles?.includes('ADMIN')
    || user.roles?.includes('LEAD')
    || project?.owner_id === user.id
    || project?.members?.[user.id] === 'owner'
  )

  useEffect(() => {
    if (!projectId || !canManageMcp) {
      setProjectMcp(null)
      setMcpRegistry([])
      return
    }
    let cancelled = false
    Promise.all([synthApi.getProjectMcp(projectId), synthApi.getMcpRegistry()])
      .then(([mcp, reg]) => {
        if (cancelled) return
        setProjectMcp(mcp)
        setMcpRegistry(reg.entries)
      })
      .catch(() => {
        if (!cancelled) {
          setProjectMcp(null)
          setMcpRegistry([])
        }
      })
    return () => { cancelled = true }
  }, [projectId, canManageMcp])

  useEffect(() => {
    if (!projectId || !canManageMcp) {
      setProjectSkills(null)
      return
    }
    let cancelled = false
    Promise.resolve()
      .then(() => synthApi.getProjectSkills(projectId))
      .then((skills) => { if (!cancelled) setProjectSkills(skills) })
      .catch(() => { if (!cancelled) setProjectSkills(null) })
    return () => { cancelled = true }
  }, [projectId, canManageMcp])

  const handleToggleProjectMcp = async (name: string, kind: 'enabled' | 'defaultOn') => {
    if (!projectId || !projectMcp) return
    const key = `mcp:${name}`
    if (isPending(key)) return
    const enabled = new Set(projectMcp.enabled)
    const defaultOn = new Set(projectMcp.defaultOn)
    if (kind === 'enabled') {
      if (enabled.has(name)) {
        enabled.delete(name)
        defaultOn.delete(name)
      } else {
        enabled.add(name)
      }
    } else if (defaultOn.has(name)) {
      defaultOn.delete(name)
    } else {
      defaultOn.add(name)
      enabled.add(name)
    }
    await run({
      key,
      run: () => synthApi.updateProjectMcp(projectId, {
        enabled: [...enabled],
        defaultOn: [...defaultOn],
      }),
      onSuccess: (updated) => setProjectMcp(updated),
    })
  }

  /** ADR-046 §4.5: проектный скоуп скиллов — «Доступен»/«Включён по умолчанию». */
  const handleToggleProjectSkill = async (name: string, kind: 'enabled' | 'defaultOn') => {
    if (!projectId || !projectSkills) return
    const key = `skill:${name}`
    if (isPending(key)) return
    const enabled = new Set(projectSkills.enabled)
    const defaultOn = new Set(projectSkills.defaultOn)
    if (kind === 'enabled') {
      if (enabled.has(name)) {
        enabled.delete(name)
        defaultOn.delete(name)
      } else {
        enabled.add(name)
      }
    } else if (defaultOn.has(name)) {
      defaultOn.delete(name)
    } else {
      defaultOn.add(name)
      enabled.add(name)
    }
    await run({
      key,
      run: () => synthApi.updateProjectSkills(projectId, {
        enabled: [...enabled],
        defaultOn: [...defaultOn],
      }),
      onSuccess: (updated) => setProjectSkills(updated),
      errorKey: (err) => (
        (err as { status?: number })?.status === 403
          ? 'projectTab.skills.forbidden'
          : 'panel.saveError'
      ),
    })
  }

  useEffect(() => {
    if (!projectId) {
      useProjectsStore
        .getState()
        .loadProjects()
        .catch(() => {})
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false

    if (!projectId) {
      setProject(null)
      setWorkspaceDraft('')
      setInvariantsDraft('')
      return
    }

    setLoading(true)
    useProjectsStore
      .getState()
      .getProject(projectId)
      .then((p) => {
        if (cancelled) return
        setProject(p)
        setWorkspaceDraft(p?.workspace || '')
        setInvariantsDraft(p?.invariants || '')
      })
      .catch(() => {
        if (!cancelled) notify({ text: t('projectTab.loadError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionId, notify, t])

  // Синхронизация локальной копии со стором: изменения проекта извне вкладки
  // (сохранение в `EntityEditDialog` → `updateProjectInList`) обновляют стор, но
  // не локальный `project`. Сравниваем по ссылке: все локальные обработчики
  // записывают в стор тот же объект, поэтому черновики (workspace/invariants) не
  // затираются и лишних ререндеров нет.
  useEffect(() => {
    if (!storeProject) return
    setProject((prev) => (prev === storeProject ? prev : storeProject))
  }, [storeProject])

  if (!session) {
    return (
      <PanelTab>
        <div className="text-sm text-muted-foreground">
          {t('rightPanel.params.noSessions')}
        </div>
      </PanelTab>
    )
  }

  if (!projectId) {
    const handleAttachProject = async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const targetId = e.target.value
      if (!targetId) return
      const updated = await useSessionsStore.getState().moveSession(session.id, targetId)
      if (!updated) {
        notify({ text: t('projectTab.noProject.moveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
        return
      }
      notify({ text: t('projectTab.noProject.attached'), type: 'success', category: 'system', sessionId: sessionId || undefined })
    }

    return (
      <PanelTab>
        <Section title={t('rightPanel.tab.project')}>
          <div className="rounded-lg border border-border bg-surface-inset px-3 py-4 text-center space-y-3">
            <div className="text-xs text-muted-foreground">{t('projectTab.noProject.title')}</div>
            <div className="text-[0.625rem] text-muted-foreground/60">{t('projectTab.noProject.hint')}</div>
            <div className="flex flex-col gap-2">
              <CreateProjectPopover
                align="center"
                trigger={
                  <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity"
                  >
                    {t('projectTab.noProject.create')}
                  </button>
                }
                onCreated={async (created) => {
                  const updated = await useSessionsStore.getState().moveSession(session.id, created.id)
                  if (!updated) {
                    notify({ text: t('projectTab.noProject.moveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
                    return
                  }
                  notify({ text: t('projectTab.noProject.created'), type: 'success', category: 'system', sessionId: sessionId || undefined })
                }}
                onError={() => {
                  notify({ text: t('projectTab.noProject.createError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
                }}
              />
              <select
                value=""
                onChange={handleAttachProject}
                className="w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="" disabled>{t('projectTab.noProject.attachPlaceholder')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
        </Section>
        <PlanSection project={project} />
      </PanelTab>
    )
  }

  if (loading && !project) {
    return (
      <PanelTab>
        <div className="text-sm text-muted-foreground">{t('projectTab.loading')}</div>
      </PanelTab>
    )
  }

  // ADR-075: managed-проект (ФС у backend) и remote-проект (локальный UI без доступа к ФС)
  // — workspace задаётся сервером, поле только для чтения.
  const isRemoteProject = project?.origin === 'remote' || (project?.id?.startsWith('remote:') ?? false)
  const workspaceReadOnly = deployment === 'managed' || isRemoteProject

  /**
   * ADR-075: сохранить workspace. При 409 `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`
   * (путь вне `workspacesRoot`, политика confirm) показывает ConfirmDialog и
   * повторяет запрос с `confirmOutsideRoot: true`; 403 — понятная ошибка.
   */
  const performSaveWorkspace = async (path: string, confirmOutsideRoot = false) => {
    if (!project) return
    await run({
      key: 'workspace',
      run: () => synthApi.updateProject(project.id, { workspace: path, confirmOutsideRoot }),
      onSuccess: (updated) => {
        setProject(updated)
        setWorkspaceDraft(updated.workspace || '')
        useProjectsStore.getState().updateProjectInList(updated)
      },
      // Спец-ошибки (409 confirm-required, 403 deny) обрабатываем сами — без общего тоста.
      silentError: true,
      onError: (err) => {
        const e = err as { status?: number; code?: string }
        if (!confirmOutsideRoot && e?.code === 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED') {
          setPendingWorkspace(path)
          setConfirmOpen(true)
          return
        }
        if (e?.status === 403 || e?.code === 'WORKSPACE_OUTSIDE_ROOT_DENIED') {
          notify({ text: t('workspace.error.denied'), type: 'error', category: 'error', sessionId: sessionId || undefined })
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        notify({ text: `${t('panel.saveError')}: ${msg}`, type: 'error', category: 'error', sessionId: sessionId || undefined })
      },
    })
  }

  const handleSaveWorkspace = async () => {
    if (!project) return
    const path = workspaceDraft.trim()
    if (!path) {
      notify({ text: t('projectTab.workspace.pathRequired'), type: 'warning', category: 'error', sessionId: sessionId || undefined })
      return
    }
    await performSaveWorkspace(path)
  }

  const confirmOutsideSave = () => {
    const target = pendingWorkspace
    setPendingWorkspace(null)
    if (target) void performSaveWorkspace(target, true)
  }

  const handleSaveInvariants = async () => {
    if (!project) return
    await run({
      key: 'invariants',
      run: () => synthApi.updateProject(project.id, { invariants: invariantsDraft }),
      onSuccess: (updated) => {
        setProject(updated)
        setInvariantsDraft(updated.invariants || '')
        useProjectsStore.getState().updateProjectInList(updated)
      },
      silentError: true,
      onError: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        notify({ text: `${t('panel.saveError')}: ${msg}`, type: 'error', category: 'error', sessionId: sessionId || undefined })
      },
    })
  }

  const openProjectEdit = () => {
    if (!project) return
    useEntityEditStore.getState().openEntityEdit({
      kind: 'project',
      id: project.id,
      name: project.name,
      description: project.description ?? '',
      icon: project.icon ?? null,
      color: project.color ?? null,
    })
  }

  return (
    <PanelTab>
      <Section title={t('rightPanel.tab.project')}>
        <div className="space-y-1.5">
          <Field
            label={t('projectTab.info.name')}
            valueNode={
              <button
                type="button"
                data-testid="project-edit-trigger"
                onClick={openProjectEdit}
                disabled={!project}
                title={t('leftPanel.editProject')}
                className="inline-flex min-w-0 items-center justify-end gap-1.5 rounded-md px-1 py-0.5 text-left align-middle transition-colors hover:bg-interactive-hover disabled:cursor-default"
              >
                <Icon
                  name={resolveIconName(project?.icon) ?? 'folder-3'}
                  className="size-4 shrink-0"
                  style={resolveIconColor(project?.color) ? { color: resolveIconColor(project?.color) } : undefined}
                />
                <span className="min-w-0 break-words">{project?.name || '—'}</span>
              </button>
            }
          />
          <Field label={t('projectTab.info.id')} value={project?.id || '—'} mono />
          <Field label={t('projectTab.info.creator')} value={project?.owner_id || '—'} />
          <Field label={t('projectTab.info.created')} value={formatDateTime(project?.created_at, locale)} />
        </div>
      </Section>

      <PlanSection project={project} />

      <Section title={t('projectTab.workspace.title')}>
        <div className="flex gap-2">
          <input
            type="text"
            value={workspaceDraft}
            onChange={(e) => setWorkspaceDraft(e.target.value)}
            placeholder={t('projectTab.workspace.placeholder')}
            readOnly={workspaceReadOnly}
            className={`flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring${workspaceReadOnly ? ' opacity-70 cursor-default' : ''}`}
            onKeyDown={(e) => !workspaceReadOnly && e.key === 'Enter' && handleSaveWorkspace()}
            data-testid="project-workspace-input"
          />
          {!workspaceReadOnly && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-interactive-hover transition-colors"
              data-testid="project-workspace-browse"
            >
              {t('workspace.select')}
            </button>
          )}
          {!workspaceReadOnly && (
            <button
              onClick={handleSaveWorkspace}
              disabled={isPending('workspace')}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="project-workspace-save"
            >
              {isPending('workspace') ? t('projectTab.workspace.saving') : t('projectTab.workspace.save')}
            </button>
          )}
        </div>
        {workspaceReadOnly && (
          <div className="text-[0.625rem] text-muted-foreground/70" data-testid="project-workspace-readonly">
            {t('workspace.managedReadOnly')}
          </div>
        )}
        <div className="text-[0.625rem] text-muted-foreground/60">{t('projectTab.workspace.hint')}</div>
      </Section>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={workspaceDraft}
        onSelect={(path) => setWorkspaceDraft(path)}
      />

      {/* ADR-114 §9: инвентарь worktree'ов проекта (per-session рабочий каталог). */}
      {project && session && (
        <Section title={t('worktrees.title')}>
          <WorktreesBlock projectId={project.id} sessionId={session.id} />
        </Section>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          setConfirmOpen(next)
          if (!next) setPendingWorkspace(null)
        }}
        title={t('workspace.outsideRootConfirmTitle')}
        message={t('workspace.outsideRootConfirmMessage', { path: pendingWorkspace ?? '' })}
        variant="warning"
        onConfirm={confirmOutsideSave}
      />

      <Section title={t('projectTab.invariants.title')}>
        <div className="flex flex-col gap-2">
          <textarea
            value={invariantsDraft}
            onChange={(e) => setInvariantsDraft(e.target.value)}
            placeholder={t('projectTab.invariants.placeholder')}
            rows={4}
            className="w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="text-[0.625rem] text-muted-foreground/60">{t('projectTab.invariants.hint')}</div>
            <button
              onClick={handleSaveInvariants}
              disabled={isPending('invariants')}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isPending('invariants') ? t('projectTab.invariants.saving') : t('projectTab.invariants.save')}
            </button>
          </div>
        </div>
      </Section>

      {canManageMcp && (
        <Section title={t('projectTab.mcp.title')}>
          <ProjectMcpBlock
            mcp={projectMcp}
            registry={mcpRegistry}
            onToggle={handleToggleProjectMcp}
            isPending={(name) => isPending(`mcp:${name}`)}
          />
        </Section>
      )}

      {canManageMcp && (
        <Section title={t('projectTab.skills.title')}>
          <ProjectSkillsBlock
            skills={projectSkills}
            isPending={(name) => isPending(`skill:${name}`)}
            onToggle={handleToggleProjectSkill}
          />
        </Section>
      )}

      <Section title={t('projectTab.log.title')}>
        <ProjectLogBlock project={project} />
      </Section>
    </PanelTab>
  )
}

/** Текст ошибки из неизвестного исключения. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Нужен ли явный `force` для удаления: сервер отдаёт `409 WORKTREE_DIRTY` с
 * `error.forceRequired = true` (ADR-114 §7.2) — молча снести незакоммиченные
 * изменения нельзя, поэтому UI показывает второй шаг подтверждения.
 */
function isForceRequired(err: unknown): boolean {
  const e = err as { forceRequired?: unknown; code?: unknown } | null
  return e?.forceRequired === true || e?.code === 'WORKTREE_DIRTY'
}

/**
 * ADR-114 §9: инвентарь worktree'ов проекта — список записей с действиями
 * (создать/привязать/удалить/очистить).
 *
 * Источник истины — сервер (`GET /api/v2/projects/:id/worktrees`), live-обновление
 * — событие `worktree.updated` (стор `stores/worktreesStore.ts`). Привязка
 * сессии — `PATCH /api/v2/sessions/:id { worktreeId }`.
 */
function WorktreesBlock({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const worktrees = useWorktreesStore((s) => s.byProject[projectId])
  const loading = useWorktreesStore((s) => Boolean(s.loadingByProject[projectId]))
  const error = useWorktreesStore((s) => s.error)
  const refresh = useWorktreesStore((s) => s.refresh)
  const createWorktree = useWorktreesStore((s) => s.create)
  const removeWorktree = useWorktreesStore((s) => s.remove)
  const pruneWorktrees = useWorktreesStore((s) => s.prune)
  const bindWorktree = useWorktreesStore((s) => s.bind)

  const sessions = useSessionsStore((s) => s.sessions)
  const currentSession = sessions.find((s) => s.id === sessionId)
  const boundWorktreeId = currentSession?.worktree?.worktree_id ?? null
  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name || id

  const [formOpen, setFormOpen] = useState(false)
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!projectId) return
    void refresh(projectId)
  }, [projectId, refresh])

  const handleCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      await createWorktree(projectId, {
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      setBranch('')
      setName('')
      setFormOpen(false)
      notify({ text: t('worktrees.created'), type: 'success', category: 'system', sessionId })
    } catch (err) {
      notify({ text: t('worktrees.createError', { error: errorText(err) }), type: 'error', category: 'error', sessionId })
    } finally {
      setBusy(false)
    }
  }

  /** Удаление worktree: подтверждение → (при `forceRequired`) второй шаг → повтор с `force`. */
  const handleRemove = async (worktree: WorktreeSummary) => {
    const ok = await confirm({
      title: t('worktrees.confirm.removeTitle'),
      message: t('worktrees.confirm.removeMessage', { name: worktree.name }),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await removeWorktree(projectId, worktree.id)
      notify({ text: t('worktrees.removed'), type: 'success', category: 'system', sessionId })
      return
    } catch (err) {
      if (!isForceRequired(err)) {
        notify({ text: t('worktrees.removeError', { error: errorText(err) }), type: 'error', category: 'error', sessionId })
        return
      }
    }
    // Второй шаг: в worktree есть незакоммиченные изменения — удаление снимет
    // их вместе с каталогом (ADR-114 §7.2). Без явного подтверждения — отказ.
    const forced = await confirm({
      title: t('worktrees.confirm.forceTitle'),
      message: t('worktrees.confirm.forceMessage', { name: worktree.name }),
      variant: 'danger',
    })
    if (!forced) return
    try {
      await removeWorktree(projectId, worktree.id, { force: true })
      notify({ text: t('worktrees.removed'), type: 'success', category: 'system', sessionId })
    } catch (err) {
      notify({ text: t('worktrees.removeError', { error: errorText(err) }), type: 'error', category: 'error', sessionId })
    }
  }

  const handlePrune = async () => {
    const ok = await confirm({
      title: t('worktrees.confirm.pruneTitle'),
      message: t('worktrees.confirm.pruneMessage'),
      variant: 'warning',
    })
    if (!ok) return
    try {
      const result = await pruneWorktrees(projectId)
      notify({
        text: t('worktrees.pruned', { count: String(result.recordsRemoved) }),
        type: 'success',
        category: 'system',
        sessionId,
      })
    } catch (err) {
      notify({ text: t('worktrees.pruneError', { error: errorText(err) }), type: 'error', category: 'error', sessionId })
    }
  }

  const handleAttach = async (worktree: WorktreeSummary) => {
    try {
      await bindWorktree(sessionId, worktree.id)
      notify({ text: t('worktrees.session.bound', { name: worktree.name }), type: 'success', category: 'system', sessionId })
    } catch (err) {
      notify({ text: t('worktrees.session.bindError', { error: errorText(err) }), type: 'error', category: 'error', sessionId })
    }
  }

  const handleDetach = async () => {
    try {
      await bindWorktree(sessionId, null)
      notify({ text: t('worktrees.session.projectDir'), type: 'success', category: 'system', sessionId })
    } catch (err) {
      notify({ text: t('worktrees.session.bindError', { error: errorText(err) }), type: 'error', category: 'error', sessionId })
    }
  }

  return (
    <div className="worktrees-panel space-y-2" data-testid="project-worktrees">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[0.625rem] text-muted-foreground/60">{t('worktrees.description')}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFormOpen((v) => !v)}
            data-testid="worktrees-create-toggle"
          >
            {t('worktrees.create')}
          </Button>
          <Button
            variant="outline-muted"
            size="sm"
            onClick={() => void handlePrune()}
            disabled={busy}
            data-testid="worktrees-prune"
          >
            {t('worktrees.action.prune')}
          </Button>
        </div>
      </div>

      {formOpen && (
        <div className="space-y-2 rounded-lg border border-border bg-surface-inset px-3 py-2" data-testid="worktrees-create-form">
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={t('worktrees.form.branchPlaceholder')}
            aria-label={t('worktrees.form.branch')}
            className="w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="worktrees-branch-input"
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('worktrees.form.namePlaceholder')}
            aria-label={t('worktrees.form.name')}
            className="w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="worktrees-name-input"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.625rem] text-muted-foreground/60">{t('worktrees.form.hint')}</span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleCreate()}
              disabled={busy}
              data-testid="worktrees-create-submit"
            >
              {t('worktrees.create')}
            </Button>
          </div>
        </div>
      )}

      {loading && !worktrees && (
        <div className="text-xs text-muted-foreground" data-testid="worktrees-loading">
          {t('worktrees.loading')}
        </div>
      )}

      {error && (
        <div className="text-xs text-destructive" data-testid="worktrees-error">
          {t('worktrees.loadError', { error })}
        </div>
      )}

      {worktrees && worktrees.length === 0 && (
        <div className="rounded-lg border border-border bg-surface-inset px-3 py-2" data-testid="worktrees-empty">
          <div className="text-xs text-muted-foreground">{t('worktrees.empty')}</div>
          <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60">{t('worktrees.emptyHint')}</div>
        </div>
      )}

      {worktrees && worktrees.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="worktrees-list">
          {worktrees.map((worktree) => (
            <ExpandableListRow
              key={worktree.id}
              testId={`worktree-${worktree.id}`}
              name={worktree.name}
              badges={
                <>
                  <span className="min-w-0 truncate font-mono text-[0.625rem] text-muted-foreground">
                    {worktree.branch}
                  </span>
                  {worktree.dirty && (
                    <RowBadge tone="danger" className="worktree-badge">
                      {t('worktrees.badge.dirty')}
                    </RowBadge>
                  )}
                  {worktree.exists === false && (
                    <RowBadge tone="muted" className="worktree-badge">
                      {t('worktrees.badge.missing')}
                    </RowBadge>
                  )}
                  {worktree.attachedSessionId && (
                    <RowBadge tone="primary" className="worktree-badge">
                      {t('worktrees.badge.attached')}
                    </RowBadge>
                  )}
                </>
              }
              aside={
                <>
                  {boundWorktreeId === worktree.id ? (
                    <Button
                      variant="outline-muted"
                      size="sm"
                      onClick={() => void handleDetach()}
                      data-testid={`worktree-${worktree.id}-detach`}
                    >
                      {t('worktrees.action.detach')}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleAttach(worktree)}
                      data-testid={`worktree-${worktree.id}-attach`}
                    >
                      {t('worktrees.action.attach')}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void handleRemove(worktree)}
                    data-testid={`worktree-${worktree.id}-remove`}
                  >
                    {t('worktrees.action.remove')}
                  </Button>
                </>
              }
              details={
                worktree.attachedSessionId
                  ? t('worktrees.row.session', { name: sessionName(worktree.attachedSessionId) })
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** ADR-071 §2.4: проектный скоуп MCP — доступность и default-on (owner/lead/admin). */
function ProjectMcpBlock({
  mcp,
  registry,
  onToggle,
  isPending,
}: {
  mcp: ProjectMcpResponse | null
  registry: McpRegistryEntry[]
  onToggle: (name: string, kind: 'enabled' | 'defaultOn') => void
  isPending: (name: string) => boolean
}) {
  const { t } = useI18n()

  if (!mcp) {
    return <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
  }

  if (mcp.knownServers.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
        <div className="text-xs text-muted-foreground">{t('projectTab.mcp.empty')}</div>
      </div>
    )
  }

  const originByName = new Map(registry.map((e) => [e.name, e.origin]))

  return (
    <div className="flex flex-col gap-1.5" data-testid="project-mcp-list">
      {mcp.knownServers.map((name) => {
        const isSystem = originByName.get(name) === 'instance'
        const enabled = mcp.enabled.includes(name) || mcp.defaultOn.includes(name)
        const defaultOn = mcp.defaultOn.includes(name)
        return (
          <ExpandableListRow
            key={name}
            testId={`project-mcp-${name}`}
            name={name}
            badges={
              isSystem ? <RowBadge tone="primary">{t('rightPanel.stats.mcpLevel.system')}</RowBadge> : undefined
            }
            aside={
              <>
                <label className="flex items-center gap-1">
                  <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.mcp.available')}</span>
                  <Toggle
                    enabled={enabled}
                    onToggle={() => onToggle(name, 'enabled')}
                    pending={isPending(name)}
                    ariaLabel={`${name}: ${t('projectTab.mcp.available')}`}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.mcp.defaultOn')}</span>
                  <Toggle
                    enabled={defaultOn}
                    onToggle={() => onToggle(name, 'defaultOn')}
                    pending={isPending(name)}
                    ariaLabel={`${name}: ${t('projectTab.mcp.defaultOn')}`}
                  />
                </label>
              </>
            }
            details={isSystem ? t('projectTab.mcp.systemHint') : undefined}
          />
        )
      })}
      <p className="text-[0.625rem] text-muted-foreground/60">{t('projectTab.mcp.hint')}</p>
    </div>
  )
}

/** ADR-046 §4.5: проектный скоуп скиллов — «Доступен» и «Включён по умолчанию». */
function ProjectSkillsBlock({
  skills,
  isPending,
  onToggle,
}: {
  skills: ProjectSkillsResponse | null
  isPending: (name: string) => boolean
  onToggle: (name: string, kind: 'enabled' | 'defaultOn') => void
}) {
  const { t } = useI18n()

  if (!skills) {
    return <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
  }

  if (skills.skills.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
        <div className="text-xs text-muted-foreground">{t('projectTab.skills.empty')}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="project-skills-list">
      {skills.skills.map((skill: EffectiveSkillEntry) => {
        const enabled = skills.enabled.includes(skill.name) || skills.defaultOn.includes(skill.name)
        const defaultOn = skills.defaultOn.includes(skill.name)
        return (
          <ExpandableListRow
            key={skill.name}
            testId={`project-skill-${skill.name}`}
            name={skill.name}
            badges={
              <>
                <RowBadge tone="neutral">{t(`skills.scope.${skill.scope}`)}</RowBadge>
                {!skill.trusted && <RowBadge tone="danger">{t('skills.untrusted')}</RowBadge>}
              </>
            }
            aside={
              <>
                <label className="flex items-center gap-1">
                  <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.skills.available')}</span>
                  <Toggle
                    enabled={enabled}
                    onToggle={() => onToggle(skill.name, 'enabled')}
                    pending={isPending(skill.name)}
                    ariaLabel={`${skill.name}: ${t('projectTab.skills.available')}`}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.skills.defaultOn')}</span>
                  <Toggle
                    enabled={defaultOn}
                    onToggle={() => onToggle(skill.name, 'defaultOn')}
                    pending={isPending(skill.name)}
                    ariaLabel={`${skill.name}: ${t('projectTab.skills.defaultOn')}`}
                  />
                </label>
              </>
            }
            details={skill.description || undefined}
          />
        )
      })}
      <p className="text-[0.625rem] text-muted-foreground/60">{t('projectTab.skills.hint')}</p>
    </div>
  )
}

function PlanSection({ project }: { project: ProjectData | null }) {  const { t } = useI18n()
  return (
    <Section title={t('sessionTab.plan.title')}>
      <ProjectPlanBlock plan={project?.plan ?? null} />
    </Section>
  )
}

function ProjectLogBlock({ project }: { project: ProjectData | null }) {
  const { t } = useI18n()
  const log = project?.log ?? []
  const sorted = [...log].sort((a, b) => b.created_at.localeCompare(a.created_at))

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
        <div className="text-xs text-muted-foreground">{t('projectTab.log.hint')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {sorted.map((entry) => (
        <div key={entry.id} className="rounded-md border border-border bg-input px-2 py-1.5">
          <div className="text-[0.625rem] text-muted-foreground/60">{entry.created_at}</div>
          <div className="text-xs">{entry.text}</div>
        </div>
      ))}
    </div>
  )
}

const PRIORITY_LABELS: Record<string, string> = {
  high: 'высокий',
  medium: 'средний',
  low: 'низкий',
}

function ProjectPlanBlock({ plan }: { plan: ProjectPlan | null }) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const items = plan?.items ?? []
  const columns = [...(plan?.columns ?? [])].sort((a, b) => a.order - b.order)

  if (!plan || items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
        <div className="text-xs text-muted-foreground">{t('sessionTab.plan.empty')}</div>
        <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60">{t('sessionTab.plan.hint')}</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-input p-2.5">
      <div className="flex items-start gap-1.5">
        <div className={`min-w-0 flex-1 space-y-2 overflow-y-auto pr-1 ${collapsed ? 'max-h-24' : 'max-h-48'}`}>
          {columns.map((col) => {
            const colItems = items
              .filter((i) => i.columnId === col.id)
              .sort((a, b) => a.order - b.order)
            return (
              <div key={col.id} className="space-y-1">
                <div className="flex items-center gap-1.5 text-[0.625rem] text-muted-foreground/80">
                  <span className="font-medium">{col.name}</span>
                  <span className="text-muted-foreground/50">({colItems.length})</span>
                </div>
                {colItems.length === 0 ? (
                  <div className="text-[0.625rem] text-muted-foreground/50">—</div>
                ) : (
                  <ul className="space-y-1">
                    {colItems.map((item) => (
                      <li key={item.id} className="rounded-md bg-surface-inset px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.5625rem] font-medium uppercase text-muted-foreground">
                            {PRIORITY_LABELS[item.priority] ?? item.priority}
                          </span>
                          <span className="text-xs">{item.title}</span>
                        </div>
                        {item.description && (
                          <div className="mt-0.5 text-[0.625rem] text-muted-foreground/70">{item.description}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-interactive-hover hover:text-foreground transition-colors"
          title={collapsed ? t('sessionTab.plan.expand') : t('sessionTab.plan.collapse')}
        >
          <Icon name={collapsed ? 'arrow-down-s' : 'arrow-up-s'} className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
