import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useProjectLogStore } from '@/stores/projectLogStore'
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
import { canEditProjectContent, canManageProject } from '@/lib/projectAccess'
import { canEditSessionContent } from '@/lib/sessionAccess'
import { MarkdownText } from './work/MarkdownText'
import { PlanSummary } from './work/PlanSummary'
import { WorkModal, type WorkTab } from './work/WorkModal'
import { PanelTab } from './PanelTab'
import { useWorktreesStore } from '@/stores/worktreesStore'
import { confirm } from '@/lib/confirm'
import type { ProjectPlan, McpRegistryEntry } from '@itphx/synth-shared'

/** Дефолтные колонки нового плана (PROP-054). */
const DEFAULT_PLAN_COLUMN_KEYS = [
  'work.plan.defaultColumn.backlog',
  'work.plan.defaultColumn.todo',
  'work.plan.defaultColumn.doing',
  'work.plan.defaultColumn.done',
] as const

/** Сколько последних записей журнала показывает панель. */
const JOURNAL_PREVIEW_ENTRIES = 5

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
  // PROP-054: открытая вкладка модального рабочего окна (null — окно закрыто).
  const [workTab, setWorkTab] = useState<WorkTab | null>(null)

  // ADR-071 §2.4: проектный MCP-скоуп (owner/lead/admin)
  const user = useAuthStore((s) => s.user)
  // ADR-075: managed-развёртывание владеет ФС проекта — путь не редактируется.
  const deployment = useAuthStore((s) => s.deployment)
  const [projectMcp, setProjectMcp] = useState<ProjectMcpResponse | null>(null)
  const [mcpRegistry, setMcpRegistry] = useState<McpRegistryEntry[]>([])
  // Отказ загрузки скоупа — честное пустое состояние вместо вечного «Загрузка…».
  const [mcpFailed, setMcpFailed] = useState(false)

  // ADR-046 §4.5: проектный скоуп скиллов (owner/lead/admin)
  const [projectSkills, setProjectSkills] = useState<ProjectSkillsResponse | null>(null)
  const [skillsFailed, setSkillsFailed] = useState(false)

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

  // Право управления проектными скоупами (MCP и скиллы). Учитывает локальный
  // мир standalone/гибрида (`deployment === 'standalone'`), где личность
  // инстанса — и есть владелец локальных проектов; в managed правило прежнее.
  const canManageMcp = canManageProject(project ?? storeProject, user, {
    standalone: deployment === 'standalone',
  })

  // PROP-054: право изменять содержимое проекта (план/журнал/инварианты).
  // VIEWER читает, но кнопок правки не видит (инвариант 21).
  const canEditProject = canEditProjectContent(project ?? storeProject, user, {
    standalone: deployment === 'standalone',
  })

  // Право изменять ToDo сессии — отдельная ось (write-доступ к сессии).
  const canEditTodos = canEditSessionContent(session, user, project ?? storeProject, {
    standalone: deployment === 'standalone',
  })

  useEffect(() => {
    if (!projectId || !canManageMcp) {
      setProjectMcp(null)
      setMcpRegistry([])
      setMcpFailed(false)
      return
    }
    let cancelled = false
    // Реестр (`/mcp/registry`) есть только у backend: в standalone он отвечает
    // 404. Падение реестра не должно обнулять скоуп проекта — список серверов
    // берётся из `knownServers` ответа `GET /projects/:id/mcp`, реестр нужен
    // лишь для бейджа «системный». Поэтому `allSettled`, а не `all`.
    Promise.allSettled([synthApi.getProjectMcp(projectId), synthApi.getMcpRegistry()])
      .then(([mcpResult, registryResult]) => {
        if (cancelled) return
        if (mcpResult.status === 'fulfilled') {
          setProjectMcp(mcpResult.value)
          setMcpFailed(false)
        } else {
          setProjectMcp(null)
          setMcpFailed(true)
        }
        setMcpRegistry(registryResult.status === 'fulfilled' ? registryResult.value.entries : [])
      })
    return () => { cancelled = true }
  }, [projectId, canManageMcp])

  useEffect(() => {
    if (!projectId || !canManageMcp) {
      setProjectSkills(null)
      setSkillsFailed(false)
      return
    }
    let cancelled = false
    Promise.resolve()
      .then(() => synthApi.getProjectSkills(projectId))
      .then((skills) => {
        if (cancelled) return
        setProjectSkills(skills)
        setSkillsFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setProjectSkills(null)
        setSkillsFailed(true)
      })
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

  /**
   * Применить новый план проекта: деталь кладём в стор (`updateProjectInList`),
   * панель подхватывает её эффектом синхронизации со стором.
   */
  const applyPlan = (next: ProjectPlan | null) => {
    if (!projectId) return
    const store = useProjectsStore.getState()
    const current = store.projects.find((p) => p.id === projectId)
    if (!current) return
    store.updateProjectInList({ ...current, plan: next })
  }

  const notifyError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    notify({
      text: `${t('panel.saveError')}: ${msg}`,
      type: 'error',
      category: 'error',
      sessionId: sessionId || undefined,
    })
  }

  /** PROP-054: «+ пункт» — точечное создание пункта плана. */
  const handleAddPlanItem = async (columnId: string, title: string) => {
    if (!projectId) return
    try {
      const response = await synthApi.createProjectPlanItem(projectId, { title, columnId })
      applyPlan(response.plan ?? null)
    } catch (err) {
      notifyError(err)
    }
  }

  /** PROP-054: удаление пункта плана (с подтверждением). */
  const handleDeletePlanItem = async (itemId: string) => {
    if (!projectId) return
    const ok = await confirm({
      title: t('work.confirm.deleteItemTitle'),
      message: t('work.confirm.deleteItemMessage'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      const response = await synthApi.deleteProjectPlanItem(projectId, itemId)
      applyPlan(response.plan ?? null)
    } catch (err) {
      notifyError(err)
    }
  }

  /** Пустой план — создать его с дефолтными колонками. */
  const handleCreatePlan = async () => {
    if (!projectId) return
    try {
      let plan: ProjectPlan | null = null
      for (const key of DEFAULT_PLAN_COLUMN_KEYS) {
        const response = await synthApi.createProjectPlanColumn(projectId, { name: t(key) })
        plan = response.plan ?? plan
      }
      applyPlan(plan)
    } catch (err) {
      notifyError(err)
    }
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

      {/* PROP-054: компактный план — группы по колонкам, полный список — в модальном окне. */}
      <Section title={t('sessionTab.plan.title')}>
        <PlanSummary
          plan={project?.plan ?? null}
          canEdit={canEditProject}
          onAddItem={canEditProject ? (columnId, title) => void handleAddPlanItem(columnId, title) : undefined}
          onDeleteItem={canEditProject ? (itemId) => void handleDeletePlanItem(itemId) : undefined}
          onCreatePlan={canEditProject ? () => void handleCreatePlan() : undefined}
          onOpenBoard={() => setWorkTab('board')}
        />
      </Section>

      {/* PROP-054: инварианты — под планом: компактное отрендеренное превью + правка в модалке. */}
      <Section title={t('projectTab.invariants.title')}>
        <InvariantsPreview
          invariants={project?.invariants ?? ''}
          canEdit={canEditProject}
          onEdit={() => setWorkTab('invariants')}
        />
      </Section>

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

      {/* ADR-114 §9: инвентарь worktree проекта (per-session рабочий каталог). */}
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

      {canManageMcp && (
        <Section title={t('projectTab.mcp.title')}>
          <ProjectMcpBlock
            mcp={projectMcp}
            registry={mcpRegistry}
            sources={projectMcp?.sources ?? {}}
            remote={project?.origin === 'remote'}
            failed={mcpFailed}
            onToggle={handleToggleProjectMcp}
            isPending={(name) => isPending(`mcp:${name}`)}
          />
        </Section>
      )}

      {canManageMcp && (
        <Section title={t('projectTab.skills.title')}>
          <ProjectSkillsBlock
            skills={projectSkills}
            failed={skillsFailed}
            isPending={(name) => isPending(`skill:${name}`)}
            onToggle={handleToggleProjectSkill}
          />
        </Section>
      )}

      {/* PROP-054: журнал — последние записи страницы; полный список — в модальном окне. */}
      <Section title={t('projectTab.log.title')}>
        <ProjectJournalPreview projectId={projectId} onOpenAll={() => setWorkTab('journal')} />
      </Section>

      {/* PROP-054: модальное рабочее окно (доска/ToDo/журнал/инварианты/статистика). */}
      <WorkModal
        open={workTab !== null}
        onOpenChange={(open) => {
          if (open) return
          setWorkTab(null)
          // Деталь проекта могла измениться (план/инварианты) — перечитываем её
          // точечно (не `loadProjects()`: список — сводки, он затирал бы панель).
          if (projectId) void useProjectsStore.getState().getProject(projectId)
        }}
        projectId={projectId}
        sessionId={sessionId}
        initialTab={workTab ?? 'board'}
        canEdit={canEditProject}
        canEditTodos={canEditTodos}
        testId="project-work-modal"
      />
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
 * ADR-114 §9: инвентарь worktree проекта — список записей с действиями
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
  sources,
  remote,
  failed,
  onToggle,
  isPending,
}: {
  mcp: ProjectMcpResponse | null
  registry: McpRegistryEntry[]
  /**
   * PROP-125: источник каждого известного сервера (`local`/`server`).
   * Отсутствие карты — источник неизвестен, бейдж «серверный» не рисуется.
   */
  sources: Record<string, 'local' | 'server'>
  /** Проект удалённого мира гибрида — все его серверы живут на сервере. */
  remote?: boolean
  failed?: boolean
  onToggle: (name: string, kind: 'enabled' | 'defaultOn') => void
  isPending: (name: string) => boolean
}) {
  const { t } = useI18n()

  if (!mcp) {
    // Отказ загрузки — пустое состояние с причиной (иначе блок висел бы
    // «Загрузка…» вечно: повтора запроса у панели нет).
    if (failed) {
      return (
        <div
          className="rounded-lg border border-border bg-surface-inset px-3 py-2"
          data-testid="project-mcp-error"
        >
          <div className="text-xs text-destructive">{t('projectTab.mcp.loadError')}</div>
        </div>
      )
    }
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
        // PROP-125: серверный источник — по карте источников или по удалённому проекту.
        const isServerSource = sources[name] === 'server' || remote === true
        const enabled = mcp.enabled.includes(name) || mcp.defaultOn.includes(name)
        const defaultOn = mcp.defaultOn.includes(name)
        return (
          <ExpandableListRow
            key={name}
            testId={`project-mcp-${name}`}
            name={name}
            badges={
              <>
                {isSystem ? <RowBadge tone="primary">{t('rightPanel.stats.mcpLevel.system')}</RowBadge> : undefined}
                {isServerSource ? <RowBadge tone="primary">{t('projectTab.mcp.source.server')}</RowBadge> : undefined}
              </>
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
  failed,
  isPending,
  onToggle,
}: {
  skills: ProjectSkillsResponse | null
  failed?: boolean
  isPending: (name: string) => boolean
  onToggle: (name: string, kind: 'enabled' | 'defaultOn') => void
}) {
  const { t } = useI18n()

  if (!skills) {
    if (failed) {
      return (
        <div
          className="rounded-lg border border-border bg-surface-inset px-3 py-2"
          data-testid="project-skills-error"
        >
          <div className="text-xs text-destructive">{t('projectTab.skills.loadError')}</div>
        </div>
      )
    }
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

/**
 * PROP-054: компактное превью инвариантов — отрендеренный Markdown + правка
 * в модальном окне (лимит 64 КиБ проверяет редактор и сервер).
 *
 * В панели инварианты — только чтение: полная правка (Markdown-редактор) —
 * в модальном рабочем окне.
 */
function InvariantsPreview({
  invariants,
  canEdit,
  onEdit,
}: {
  invariants: string
  canEdit: boolean
  onEdit: () => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const hasText = invariants.trim().length > 0
  // Длинные инварианты (несколько абзацев/список) в панели обрезаем; полный
  // текст доступен по «Показать полностью» и в модальном редакторе.
  const isLong = invariants.length > 280 || invariants.split('\n').length > 4

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="project-invariants">
      {hasText ? (
        <div
          className={`min-w-0 rounded-lg border border-border bg-surface-inset px-3 py-2 ${isLong && !expanded ? 'line-clamp-4' : ''}`}
        >
          <MarkdownText
            content={invariants}
            mode="render"
            className="text-xs"
            testId="project-invariants-preview"
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
          <div className="text-xs text-muted-foreground">{t('work.invariants.empty')}</div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              data-testid="project-invariants-expand"
              className="min-h-6 shrink-0 rounded border border-border px-2 py-1 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? t('work.invariants.collapse') : t('work.invariants.expand')}
            </button>
          )}
          <div className="min-w-0 text-[0.625rem] text-muted-foreground/60">{t('work.invariants.hint')}</div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            data-testid="project-invariants-edit"
            className="min-h-6 shrink-0 rounded-md border border-border px-2 py-1 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {hasText ? t('work.invariants.edit') : t('work.invariants.add')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * PROP-054: журнал проекта — последние записи страницы
 * (`GET /projects/:id/log`), полный список — в модальном окне.
 *
 * Журнал вынесен из детали проекта: источник — страница журнала (стор
 * `stores/projectLogStore.ts`), live-обновление — событие `project.updated`
 * с `kind: 'log'`.
 */
function ProjectJournalPreview({
  projectId,
  onOpenAll,
}: {
  projectId: string | null
  onOpenAll: () => void
}) {
  const { t, locale } = useI18n()
  const page = useProjectLogStore((s) => (projectId ? s.byProject[projectId] : undefined))
  const refresh = useProjectLogStore((s) => s.refresh)

  useEffect(() => {
    if (!projectId) return
    void refresh(projectId)
  }, [projectId, refresh])

  if (!projectId) {
    return (
      <div className="text-[0.625rem] text-muted-foreground/60" data-testid="project-journal">
        {t('projectTab.log.hint')}
      </div>
    )
  }

  const entries = (page?.entries ?? []).slice(0, JOURNAL_PREVIEW_ENTRIES)
  const total = page?.total ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="project-journal">
      {page?.loading && entries.length === 0 && (
        <div className="text-[0.625rem] text-muted-foreground/60">{t('common.loading')}</div>
      )}

      {!page?.loading && entries.length === 0 && (
        <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
          <div className="text-xs text-muted-foreground">{t('work.journal.empty')}</div>
        </div>
      )}

      {entries.map((entry) => (
        <div
          key={entry.id}
          className="min-w-0 rounded-md border border-border bg-input px-2 py-1.5"
          data-testid={`project-journal-entry-${entry.id}`}
        >
          <div className="flex min-w-0 items-center gap-1.5 text-[0.625rem] text-muted-foreground/60">
            <span className="min-w-0 truncate">{entry.author ?? t('work.journal.unknownAuthor')}</span>
            <span className="shrink-0">{formatDateTime(entry.created_at, locale)}</span>
          </div>
          <MarkdownText
            content={entry.text}
            mode="plain"
            maxLength={200}
            className="text-xs"
            testId={`project-journal-entry-${entry.id}-text`}
          />
        </div>
      ))}

      <button
        type="button"
        onClick={onOpenAll}
        data-testid="project-journal-all"
        className="min-h-6 self-start rounded border border-border px-2 py-1 text-[0.625rem] text-muted-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('work.journal.all', { count: total })}
      </button>
    </div>
  )
}
