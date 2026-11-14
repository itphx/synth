import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useProjectLogStore } from '@/stores/projectLogStore'
import { useNotification } from '@/hooks/useNotification'
import { usePanelSettingSave } from '@/hooks/usePanelSettingSave'
import { formatDateTime } from '@/lib/formatDate'
import { synthApi, type ProjectData, type ProjectMcpResponse, type ProjectSkillsResponse, type EffectiveSkillEntry, type ExecutionProfilesDto } from '@/lib/api/synthApi'
import type { WorktreeSummary } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/button'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { InfoField as Field, InfoSection as Section, MultiSelectField } from '@/components/ui/settings'
import { DirectoryPickerDialog } from '@/components/ui/DirectoryPickerDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CreateProjectPopover } from '@/components/panels/CreateProjectPopover'
import { ExpandableListRow, RowBadge } from '@/components/panels/ExpandableListRow'
import { ProjectAccessProjectionField } from '@/components/ui/ProjectAccessProjectionField'
import {
  accessProjectionOf,
  buildProjectAccessBody,
  canEditProjectContent,
  canManageProject,
  draftGroupMembersOf,
  draftMembersOf,
  everyoneRoleOf,
  projectAccessDraftAfterProjection,
  type ProjectAccessProjection,
  type ProjectGrantRole,
} from '@/lib/projectAccess'
import { canEditSessionContent } from '@/lib/sessionAccess'
import { useUsersDirectory } from '@/hooks/useUsersDirectory'
import { useGroupsCatalog } from '@/hooks/useGroupsCatalog'
import { selectHasFeature, useInstanceCapabilitiesStore } from '@/stores/instanceCapabilitiesStore'
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

  // PROP-133 §4: право менять доступ к проекту — то же, что и управление
  // проектом (автор/OWNER/LEAD/ADMIN). EDITOR доступ не меняет.
  const canManageAccess = canManageProject(project ?? storeProject, user, {
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

      {/* ADR-140 Ф3: владение проектом — передача другому пользователю. */}
      {project && (
        <Section title={t('project.access.transfer.title')}>
          <ProjectOwnershipBlock
            project={project}
            sessionId={sessionId}
            onUpdated={(updated) => {
              setProject(updated)
              useProjectsStore.getState().updateProjectInList(updated)
            }}
          />
        </Section>
      )}

      {/* PROP-133 §4: блок «Доступ» — три проекции состояния списка доступа. */}
      {canManageAccess && project && (
        <Section title={t('project.access.title')}>
          <ProjectAccessBlock
            project={project}
            sessionId={sessionId}
            onUpdated={(updated) => {
              setProject(updated)
              useProjectsStore.getState().updateProjectInList(updated)
            }}
          />
        </Section>
      )}

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

      {/* PROP-135 Ф6a/6b-2a: профиль исполнения проекта и потолок профилей.
          Право — управление проектом (owner/LEAD/ADMIN), как workspace/MCP. */}
      {project && (
        <Section title={t('projectTab.executor.title')}>
          <ProjectExecutorBlock
            project={project}
            canManage={canManageMcp}
            sessionId={sessionId}
            onUpdated={(updated) => {
              setProject(updated)
              useProjectsStore.getState().updateProjectInList(updated)
            }}
          />
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

/** Debounce автосохранения настроек исполнения проекта (мс). */
const PROJECT_EXECUTOR_AUTOSAVE_DEBOUNCE_MS = 500

/**
 * PROP-135 Ф6a: профиль исполнения проекта и потолок разрешённых профилей.
 *
 * Автосохранение (как в `SessionSettingsTab`): селекты — сразу, списки — с
 * debounce ~500 мс; статус — тосты `panel.saved`/`panel.saveError` через
 * `usePanelSettingSave`. Кнопки «Сохранить» нет; «Сбросить» возвращает
 * значения формы к последним сохранённым (данные не чистит).
 *
 * ADR-135 (аддендум): пустой список разрешённых = «профилей нет» — селект
 * профиля заблокирован.
 */
function ProjectExecutorBlock({
  project,
  canManage,
  sessionId,
  onUpdated,
}: {
  project: ProjectData
  canManage: boolean
  sessionId?: string
  onUpdated: (updated: ProjectData) => void
}) {
  const { t } = useI18n()
  const { run, isPending } = usePanelSettingSave({ sessionId })

  const executor = project.executor ?? null
  const configuredProfile = executor?.profile ?? ''
  const configuredAllowed = executor?.allowedProfiles ?? []
  // PROP-135 (браузерный контур): отдельные значения браузерного пула.
  const configuredBrowserProfile = executor?.browserProfile ?? ''
  const configuredBrowserAllowed = executor?.allowedBrowserProfiles ?? []

  const [profiles, setProfiles] = useState<ExecutionProfilesDto | null>(null)
  const [profilesFailed, setProfilesFailed] = useState(false)
  const [profileDraft, setProfileDraft] = useState(configuredProfile)
  const [allowedDraft, setAllowedDraft] = useState<string[]>([...configuredAllowed])
  const [browserProfileDraft, setBrowserProfileDraft] = useState(configuredBrowserProfile)
  const [browserAllowedDraft, setBrowserAllowedDraft] = useState<string[]>([...configuredBrowserAllowed])

  /** Последние успешно сохранённые значения — «Сбросить» возвращает их. */
  const savedRef = useRef({
    profile: configuredProfile,
    allowed: [...configuredAllowed],
    browserProfile: configuredBrowserProfile,
    browserAllowed: [...configuredBrowserAllowed],
  })
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<(() => void) | null>(null)

  // Каталог профилей читается при открытии секции: он нужен и для селекта, и для
  // списка «разрешённых». Ошибка не блокирует вкладку — показываем текущее
  // значение (профиль по умолчанию неизвестен → нейтральная подпись).
  //
  // Только при праве управления: чтение `/execution/profiles` в managed — ADMIN/LEAD,
  // иначе редактор проекта получал бы 403 на каждом открытии вкладки.
  useEffect(() => {
    if (!canManage) return
    let cancelled = false
    Promise.resolve()
      .then(() => synthApi.getExecutionProfiles())
      .then((dto) => {
        if (cancelled) return
        setProfiles(dto)
        setProfilesFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setProfiles(null)
        setProfilesFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [canManage])

  // Изменения проекта извне секции (сохранение, другой клиент) синхронизируют черновик.
  // Потолок не задан (`null`/`undefined`) — проект не ограничивает: отмечаем
  // весь каталог (иначе селект был бы «выключен», хотя профиль разрешён).
  useEffect(() => {
    const execCatalog = (profiles?.profiles ?? []).map((name) => name.trim()).filter(Boolean)
    const browserCat = (profiles?.browserProfiles?.length
      ? profiles.browserProfiles
      : profiles?.browserDefaultProfile
        ? [profiles.browserDefaultProfile]
        : []
    ).map((name) => name.trim()).filter(Boolean)
    setProfileDraft(executor?.profile ?? '')
    setAllowedDraft([...(executor?.allowedProfiles ?? execCatalog)])
    setBrowserProfileDraft(executor?.browserProfile ?? '')
    setBrowserAllowedDraft([...(executor?.allowedBrowserProfiles ?? browserCat)])
    savedRef.current = {
      profile: executor?.profile ?? '',
      allowed: [...(executor?.allowedProfiles ?? execCatalog)],
      browserProfile: executor?.browserProfile ?? '',
      browserAllowed: [...(executor?.allowedBrowserProfiles ?? browserCat)],
    }
  }, [executor, profiles])

  // Опции: каталог инстанса + сохранённые значения проекта (даже если профиль
  // исчез из каталога — иначе текущий выбор нельзя было бы увидеть).
  const profileNames: string[] = []
  const seen = new Set<string>()
  const pushName = (name: string | undefined) => {
    const trimmed = (name ?? '').trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    profileNames.push(trimmed)
  }
  for (const name of profiles?.profiles ?? []) pushName(name)
  pushName(configuredProfile)
  for (const name of configuredAllowed) pushName(name)

  // Браузерный каталог — отдельный: `browserProfiles` (пусто → дефолт).
  const browserCatalog = (profiles?.browserProfiles?.length
    ? profiles.browserProfiles
    : profiles?.browserDefaultProfile
      ? [profiles.browserDefaultProfile]
      : []
  )
  const browserNames: string[] = []
  const pushBrowser = (name: string | undefined) => {
    const trimmed = (name ?? '').trim()
    if (!trimmed || browserNames.includes(trimmed)) return
    browserNames.push(trimmed)
  }
  for (const name of browserCatalog) pushBrowser(name)
  pushBrowser(configuredBrowserProfile)
  for (const name of configuredBrowserAllowed) pushBrowser(name)

  const saved = savedRef.current
  const dirty =
    profileDraft !== saved.profile ||
    browserProfileDraft !== saved.browserProfile ||
    allowedDraft.length !== saved.allowed.length ||
    allowedDraft.some((name) => !saved.allowed.includes(name)) ||
    browserAllowedDraft.length !== saved.browserAllowed.length ||
    browserAllowedDraft.some((name) => !saved.browserAllowed.includes(name))

  /** Сохранение текущих значений блока (общий шаг для immediate/debounce). */
  const saveExecutor = useCallback(() => {
    const values = {
      profile: profileDraft.trim(),
      allowed: [...allowedDraft],
      browserProfile: browserProfileDraft.trim(),
      browserAllowed: [...browserAllowedDraft],
    }
    void run({
      key: 'project-executor',
      run: async () => {
        const updated = await synthApi.updateProject(project.id, {
          executor: {
            // null сбрасывает профиль (наследование);
            // пустой список разрешённых = «профилей нет» (ADR-135).
            profile: values.profile || null,
            allowedProfiles: values.allowed,
            browserProfile: values.browserProfile || null,
            allowedBrowserProfiles: values.browserAllowed,
          },
        })
        return { updated, values }
      },
      onSuccess: ({ updated, values: savedValues }) => {
        savedRef.current = {
          profile: savedValues.profile,
          allowed: savedValues.allowed,
          browserProfile: savedValues.browserProfile,
          browserAllowed: savedValues.browserAllowed,
        }
        onUpdated(updated)
      },
      onError: () => {
        // Откат к сохранённым значениям (никаких «залипших» правок).
        const current = savedRef.current
        setProfileDraft(current.profile)
        setAllowedDraft([...current.allowed])
        setBrowserProfileDraft(current.browserProfile)
        setBrowserAllowedDraft([...current.browserAllowed])
      },
    })
  }, [allowedDraft, browserAllowedDraft, browserProfileDraft, onUpdated, profileDraft, project.id, run])

  // Автосохранение: селекты — сразу, списки — с debounce ~500 мс.
  useEffect(() => {
    if (!canManage || !dirty) return
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    pendingSaveRef.current = null
    const immediate =
      profileDraft !== savedRef.current.profile ||
      browserProfileDraft !== savedRef.current.browserProfile
    const save = () => {
      void saveExecutor()
    }
    if (immediate) {
      save()
    } else {
      pendingSaveRef.current = save
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        pendingSaveRef.current = null
        save()
      }, PROJECT_EXECUTOR_AUTOSAVE_DEBOUNCE_MS)
    }
  }, [allowedDraft, browserAllowedDraft, browserProfileDraft, canManage, dirty, profileDraft, saveExecutor])

  // Best-effort дофлаш отложенного сохранения при размонтировании.
  useEffect(() => {
    return () => {
      const flush = pendingSaveRef.current
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      pendingSaveRef.current = null
      flush?.()
    }
  }, [])

  /** «Сбросить»: значения формы возвращаются к сохранённым (данные не чистятся). */
  const handleReset = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    pendingSaveRef.current = null
    const current = savedRef.current
    setProfileDraft(current.profile)
    setAllowedDraft([...current.allowed])
    setBrowserProfileDraft(current.browserProfile)
    setBrowserAllowedDraft([...current.browserAllowed])
  }

  const toggleAllowed = (name: string) => {
    setAllowedDraft((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name],
    )
  }

  const toggleBrowserAllowed = (name: string) => {
    setBrowserAllowedDraft((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name],
    )
  }

  const defaultProfileLabel = profiles
    ? t('projectTab.executor.profileDefault', { profile: profiles.defaultProfile })
    : t('projectTab.executor.profileDefaultUnknown')
  const defaultBrowserProfileLabel = profiles?.browserDefaultProfile
    ? t('projectTab.executor.browserProfileDefault', { profile: profiles.browserDefaultProfile })
    : t('projectTab.executor.profileDefaultUnknown')

  // `inline` (standalone/hybrid): исполнение в процессе, профилей нет — селекторы
  // и сохранение неприменимы, показываем пояснение вместо контролов.
  if (profiles?.provider === 'inline') {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="project-executor">
        <div className="text-xs text-muted-foreground" data-testid="project-executor-not-applicable">
          {t('projectTab.executor.notApplicable')}
        </div>
      </div>
    )
  }

  const busy = isPending('project-executor')

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="project-executor">
      {/* Подсекция «Исполнитель». */}
      <div className="flex min-w-0 flex-col gap-2" data-testid="project-executor-exec">
        <span className="text-xs font-medium text-foreground">{t('projectTab.executor.execSection')}</span>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{t('projectTab.executor.profile')}</span>
          <select
            value={profileDraft}
            onChange={(e) => setProfileDraft(e.target.value)}
            disabled={!canManage || busy || allowedDraft.length === 0}
            aria-label={t('projectTab.executor.profile')}
            data-testid="project-executor-profile"
            className="w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          >
            <option value="">{defaultProfileLabel}</option>
            {profileNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1" data-testid="project-executor-allowed">
          <span className="text-xs text-muted-foreground">{t('projectTab.executor.allowed')}</span>
          {profileNames.length === 0 ? (
            <span className="text-[0.625rem] text-muted-foreground/60">
              {t('projectTab.executor.allowedEmpty')}
            </span>
          ) : (
            <div className="flex flex-wrap gap-x-3 gap-y-1.5" role="group" aria-label={t('projectTab.executor.allowed')}>
              {profileNames.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={allowedDraft.includes(name)}
                    onChange={() => toggleAllowed(name)}
                    disabled={!canManage || busy}
                    data-testid={`project-executor-allowed-${name}`}
                  />
                  <span className="font-mono">{name}</span>
                </label>
              ))}
            </div>
          )}
          <span className="text-[0.625rem] text-muted-foreground/60">
            {t('projectTab.executor.allowedHint')}
          </span>
        </div>
      </div>

      {/* Подсекция «Браузер» — те же строки, отдельный каталог. */}
      <div
        className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3"
        data-testid="project-browser-profile"
      >
        <span className="text-xs font-medium text-foreground">{t('projectTab.executor.browserSection')}</span>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{t('projectTab.executor.browserProfile')}</span>
          <select
            value={browserProfileDraft}
            onChange={(e) => setBrowserProfileDraft(e.target.value)}
            disabled={!canManage || busy || browserAllowedDraft.length === 0}
            aria-label={t('projectTab.executor.browserProfile')}
            data-testid="project-browser-profile-select"
            className="w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          >
            <option value="">{defaultBrowserProfileLabel}</option>
            {browserNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1" data-testid="project-browser-allowed">
          <span className="text-xs text-muted-foreground">{t('projectTab.executor.allowedBrowserProfiles')}</span>
          {browserNames.length === 0 ? (
            <span className="text-[0.625rem] text-muted-foreground/60">
              {t('projectTab.executor.allowedEmpty')}
            </span>
          ) : (
            <div
              className="flex flex-wrap gap-x-3 gap-y-1.5"
              role="group"
              aria-label={t('projectTab.executor.allowedBrowserProfiles')}
            >
              {browserNames.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={browserAllowedDraft.includes(name)}
                    onChange={() => toggleBrowserAllowed(name)}
                    disabled={!canManage || busy}
                    data-testid={`project-browser-allowed-${name}`}
                  />
                  <span className="font-mono">{name}</span>
                </label>
              ))}
            </div>
          )}
          <span className="text-[0.625rem] text-muted-foreground/60">
            {t('projectTab.executor.allowedBrowserProfilesHint')}
          </span>
        </div>
      </div>

      {profilesFailed && (
        <div className="text-[0.625rem] text-status-warning" data-testid="project-executor-profiles-error">
          {t('projectTab.executor.profilesLoadError')}
        </div>
      )}

      {canManage ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={busy || !dirty}
            data-testid="project-executor-reset"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {t('projectTab.executor.reset')}
          </button>
        </div>
      ) : (
        <div className="text-[0.625rem] text-muted-foreground/70" data-testid="project-executor-readonly">
          {t('projectTab.executor.readOnly')}
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
 * PROP-133 §4: блок «Доступ» — три проекции состояния списка доступа.
 *
 * Проекции — **не отдельный флаг**, а три состояния одного списка (PROP-133):
 * «Только автору» / «Только выбранным» / «Всем пользователям». Текущая
 * проекция берётся из DTO (`visibility`, производное сервером), сохранение
 * уходит **одним** `PUT /projects/:id` с полной заменой `members`,
 * `group_members` и `everyone_role` (PROP-133 §3.1).
 *
 * Гранты группам (ADR-140 Ф2) — в том же списке доступа: выбор доступен
 * только там, где сервер объявил фичу `features.users`
 * (`GET /api/v2/meta`): в standalone раздела пользователей нет, поэтому
 * предлагается только «Только автору» (read-only).
 */
function ProjectAccessBlock({
  project,
  sessionId,
  onUpdated,
}: {
  project: ProjectData
  sessionId?: string
  onUpdated: (updated: ProjectData) => void
}) {
  const { t } = useI18n()
  const { run, isPending } = usePanelSettingSave({ sessionId })

  // Признак «инстанс обслуживает /users*» (PROP-125): без него выбирать
  // участников нечем (и эндпоинта может не быть вовсе).
  const hasUsers = useInstanceCapabilitiesStore(selectHasFeature('users'))
  useEffect(() => {
    void useInstanceCapabilitiesStore.getState().load()
  }, [])
  const directory = useUsersDirectory(hasUsers)
  const groupsCatalog = useGroupsCatalog(hasUsers)

  const [projection, setProjection] = useState<ProjectAccessProjection>(() =>
    accessProjectionOf(project),
  )
  const [members, setMembers] = useState<Record<string, ProjectGrantRole>>(() =>
    draftMembersOf(project),
  )
  const [everyoneRole, setEveryoneRole] = useState<ProjectGrantRole>(() =>
    everyoneRoleOf(project),
  )
  // ADR-140 Ф2: гранты группам (`имя группы → роль`). Черновик сеется из
  // DTO, а не из каталога: грант вне каталога не должен потеряться.
  const [groupMembers, setGroupMembers] = useState<Record<string, ProjectGrantRole>>(() =>
    draftGroupMembersOf(project),
  )

  // Синхронизация с сервером: доступ мог поменять другой клиент
  // (`project.updated`) — черновик возвращается к актуальному состоянию.
  useEffect(() => {
    setProjection(accessProjectionOf(project))
    setMembers(draftMembersOf(project))
    setEveryoneRole(everyoneRoleOf(project))
    setGroupMembers(draftGroupMembersOf(project))
  }, [project])

  const userLabel = (id: string): string => {
    const found = directory.users.find((u) => u.id === id)
    if (found) return found.display_name || found.username
    return id
  }

  /** Имена групп, известные загруженному каталогу. */
  const catalogGroupNames = groupsCatalog.groups.map((g) => g.name)

  /** Выбранные группы: из каталога и «вне каталога» (грант сохранён, а группы в каталоге нет). */
  const selectedGroupNames = Object.keys(groupMembers)
  const groupsInCatalog = selectedGroupNames.filter((name) => catalogGroupNames.includes(name))
  const groupsOutsideCatalog = selectedGroupNames.filter(
    (name) => !catalogGroupNames.includes(name),
  )

  /** Смена проекции — переход между состояниями одного списка доступа. */
  const handleProjectionChange = (next: ProjectAccessProjection) => {
    if (next === projection) return
    // Правило перехода — в `lib/projectAccess` (единственный источник правды).
    const draft = projectAccessDraftAfterProjection(
      next,
      projection,
      members,
      everyoneRole,
      groupMembers,
    )
    setProjection(draft.projection)
    setMembers(draft.members)
    setEveryoneRole(draft.everyoneRole)
    setGroupMembers(draft.groupMembers)
  }

  const handleMembersChange = (next: string[]) => {
    setMembers((prev) => {
      const out: Record<string, ProjectGrantRole> = {}
      for (const id of next) out[id] = prev[id] ?? 'viewer'
      return out
    })
  }

  const handleRoleChange = (id: string, role: ProjectGrantRole) => {
    setMembers((prev) => ({ ...prev, [id]: role }))
  }

  /**
   * ADR-140 Ф2: смена набора групп из мультиселекта.
   *
   * `MultiSelectField` отдаёт только те значения, что есть в `options`
   * (известный баг `toggle` — значения вне каталога выпадают из результата).
   * Поэтому гранты вне каталога **мержим обратно**: иначе полная замена
   * `group_members` тихо удалила бы их. Снять такой грант можно явной
   * кнопкой «снять» в строке «не в каталоге».
   */
  const handleGroupMembersChange = (next: string[]) => {
    setGroupMembers((prev) => {
      const out: Record<string, ProjectGrantRole> = {}
      for (const [name, role] of Object.entries(prev)) {
        if (!catalogGroupNames.includes(name)) out[name] = role
      }
      for (const rawName of next) {
        const name = rawName.trim()
        if (!name) continue
        out[name] = prev[name] ?? 'viewer'
      }
      return out
    })
  }

  const handleGroupRoleChange = (name: string, role: ProjectGrantRole) => {
    setGroupMembers((prev) => ({ ...prev, [name]: role }))
  }

  /** Явное снятие гранта группе (единственный способ снять грант вне каталога). */
  const handleRemoveGroup = (name: string) => {
    setGroupMembers((prev) => {
      if (!(name in prev)) return prev
      const out = { ...prev }
      delete out[name]
      return out
    })
  }

  const handleSave = async () => {
    const body = buildProjectAccessBody(projection, members, everyoneRole, groupMembers)
    await run({
      key: 'project-access',
      run: () => synthApi.updateProject(project.id, body),
      onSuccess: (updated) => onUpdated(updated),
      // 403 — нет права управлять доступом; 400 — недопустимое состояние
      // (например, роль владельца понижена). Остальное — общий текст панели.
      errorKey: (err) => {
        const status = (err as { status?: number })?.status
        if (status === 403) return 'project.access.forbidden'
        if (status === 400) return 'project.access.invalid'
        return 'panel.saveError'
      },
    })
  }

  const projectionOptions: { value: ProjectAccessProjection; label: string }[] = hasUsers
    ? [
        { value: 'author', label: t('project.access.author') },
        { value: 'selected', label: t('project.access.selected') },
        { value: 'all', label: t('project.access.all') },
      ]
    : [{ value: 'author', label: t('project.access.author') }]

  const busy = isPending('project-access')
  const selectedIds = Object.keys(members)

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="project-access">
      <ProjectAccessProjectionField
        value={projection}
        options={projectionOptions}
        onChange={handleProjectionChange}
        ariaLabel={t('project.access.title')}
        disabled={!hasUsers}
        testIdPrefix="project-access"
      />

      {!hasUsers && (
        <div
          className="text-[0.625rem] text-muted-foreground/60"
          data-testid="project-access-single-user"
        >
          {t('project.access.singleUser')}
        </div>
      )}

      {hasUsers && projection === 'selected' && (
        <div className="flex min-w-0 flex-col gap-2" data-testid="project-access-selected-users">
          <input
            type="search"
            value={directory.query}
            onChange={(e) => directory.setQuery(e.target.value)}
            placeholder={t('project.access.usersSearch')}
            aria-label={t('project.access.usersSearch')}
            className="w-full min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="project-access-user-search"
          />
          <MultiSelectField
            label={t('project.access.users')}
            values={selectedIds}
            options={directory.users.map((u) => ({
              value: u.id,
              label: u.display_name || u.username,
            }))}
            onChange={handleMembersChange}
            testIdPrefix="project-access-user"
            emptyText={directory.loading ? t('common.loading') : t('project.access.usersEmpty')}
          />
          {directory.failed && (
            <div
              className="text-[0.625rem] text-destructive"
              data-testid="project-access-users-error"
            >
              {t('project.access.usersLoadError')}
            </div>
          )}
          {selectedIds.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="project-access-roles">
              {selectedIds.map((id) => (
                <div key={id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs text-foreground">{userLabel(id)}</span>
                  <select
                    value={members[id]}
                    onChange={(e) =>
                      handleRoleChange(id, e.target.value as ProjectGrantRole)
                    }
                    aria-label={t('project.access.roleOf', { name: userLabel(id) })}
                    data-testid={`project-access-role-${id}`}
                    className="shrink-0 rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="viewer">{t('project.access.role.viewer')}</option>
                    <option value="editor">{t('project.access.role.editor')}</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          {/* ADR-140 Ф2: гранты группам — вторая ось того же списка доступа. */}
          <div className="flex min-w-0 flex-col gap-2" data-testid="project-access-groups">
            <input
              type="search"
              value={groupsCatalog.query}
              onChange={(e) => groupsCatalog.setQuery(e.target.value)}
              placeholder={t('project.access.groups.search')}
              aria-label={t('project.access.groups.search')}
              className="w-full min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="project-access-group-search"
            />
            <MultiSelectField
              label={t('project.access.groups.title')}
              values={selectedGroupNames}
              options={groupsCatalog.groups.map((g) => ({ value: g.name, label: g.name }))}
              onChange={handleGroupMembersChange}
              testIdPrefix="project-access-group"
              emptyText={
                groupsCatalog.loading ? t('common.loading') : t('project.access.groups.empty')
              }
            />
            {groupsCatalog.failed && (
              <div
                className="text-[0.625rem] text-destructive"
                data-testid="project-access-groups-error"
              >
                {t('project.access.groups.loadError')}
              </div>
            )}
            {selectedGroupNames.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="project-access-group-roles">
                {groupsInCatalog.map((name) => (
                  <div key={name} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs text-foreground">{name}</span>
                    <select
                      value={groupMembers[name]}
                      onChange={(e) =>
                        handleGroupRoleChange(name, e.target.value as ProjectGrantRole)
                      }
                      aria-label={t('project.access.groups.roleOf', { name })}
                      data-testid={`project-access-group-role-${name}`}
                      className="shrink-0 rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="viewer">{t('project.access.role.viewer')}</option>
                      <option value="editor">{t('project.access.role.editor')}</option>
                    </select>
                  </div>
                ))}
                {/* Грант вне каталога: сохраняем и даём снять явно. */}
                {groupsOutsideCatalog.map((name) => (
                  <div
                    key={name}
                    className="flex items-center justify-between gap-2"
                    data-testid={`project-access-group-outside-${name}`}
                  >
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {t('project.access.groups.notInCatalog', { name })}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <select
                        value={groupMembers[name]}
                        onChange={(e) =>
                          handleGroupRoleChange(name, e.target.value as ProjectGrantRole)
                        }
                        aria-label={t('project.access.groups.roleOf', { name })}
                        data-testid={`project-access-group-role-${name}`}
                        className="rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="viewer">{t('project.access.role.viewer')}</option>
                        <option value="editor">{t('project.access.role.editor')}</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRemoveGroup(name)}
                        className="rounded border border-border px-2 py-1 text-[0.625rem] text-muted-foreground hover:text-foreground"
                        data-testid={`project-access-group-remove-${name}`}
                      >
                        {t('project.access.groups.remove')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {hasUsers && projection === 'all' && (
        <label
          className="flex items-center justify-between gap-2 text-xs text-foreground"
          data-testid="project-access-all-editor"
        >
          <span className="min-w-0">{t('project.access.allowEdit')}</span>
          <Toggle
            enabled={everyoneRole === 'editor'}
            onToggle={() => setEveryoneRole(everyoneRole === 'editor' ? 'viewer' : 'editor')}
            ariaLabel={t('project.access.allowEdit')}
          />
        </label>
      )}

      {hasUsers && (
        <div className="text-[0.625rem] text-muted-foreground/60">{t('project.access.hint')}</div>
      )}

      {hasUsers && (
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            disabled={busy}
            data-testid="project-access-save"
          >
            {busy ? t('project.access.saving') : t('project.access.save')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * ADR-140 Ф3: блок «Владение» — передача владения проектом.
 *
 * Право передачи — **не** «управление содержимым»: текущий владелец или
 * `ADMIN` (`LEAD`, участники с ролью `owner` и `EDITOR` — нет; серверный
 * `canTransfer`). UI лишь прячет недоступное действие, enforcement — на сервере.
 *
 * Каталог пользователей грузится только тем, кто может передавать владение:
 * остальным выбирать некому, а каталог — лишний запрос. Владелец показывается
 * по `owner_id`, а имя (`display_name`) — когда каталог загружен.
 */
function ProjectOwnershipBlock({
  project,
  sessionId,
  onUpdated,
}: {
  project: ProjectData
  sessionId?: string
  onUpdated: (updated: ProjectData) => void
}) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const user = useAuthStore((s) => s.user)

  // Признак «инстанс обслуживает /users*» (PROP-125): без него выбирать
  // получателя нечем (и эндпоинта может не быть вовсе).
  const hasUsers = useInstanceCapabilitiesStore(selectHasFeature('users'))
  useEffect(() => {
    void useInstanceCapabilitiesStore.getState().load()
  }, [])

  const isOwner = Boolean(user) && project.owner_id === user?.id
  const isAdmin = (user?.roles ?? []).includes('ADMIN')
  const canTransfer = hasUsers && Boolean(user) && (isOwner || isAdmin)
  const directory = useUsersDirectory(canTransfer)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingUserId, setPendingUserId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Защита от двойной отправки: `busy` в состоянии обновляется не сразу,
  // а два клика подряд успевают пройти до ререндера (защита — на ref).
  const busyRef = useRef(false)

  const owner = directory.users.find((u) => u.id === project.owner_id)
  const ownerLabel = owner ? owner.display_name || owner.username : project.owner_id

  /**
   * Получатели: текущий владелец не предлагается (передача самому себе —
   * ошибка сервера), как и сам пользователь (то же ограничение сервера).
   * Сервисные идентичности (`service:<keyId>`) — не люди.
   */
  const candidates = directory.users.filter(
    (u) => u.id !== project.owner_id && u.id !== user?.id && !u.id.startsWith('service:'),
  )
  const pendingUser = pendingUserId
    ? (directory.users.find((u) => u.id === pendingUserId) ?? null)
    : null

  const performTransfer = async (targetId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const updated = await useProjectsStore.getState().transferProject(project.id, targetId)
      if (!updated) return
      onUpdated(updated)
      setPickerOpen(false)
      notify({
        text: t('project.access.transfer.success'),
        type: 'success',
        category: 'system',
        sessionId: sessionId || undefined,
      })
    } catch (err) {
      // 403 — нет права передавать; 400 — недопустимый получатель
      // (неизвестный/неактивный, передача самому себе, сервисная личность).
      const status = (err as { status?: number })?.status
      const text =
        status === 403
          ? t('project.access.transfer.forbidden')
          : status === 400
            ? t('project.access.transfer.invalid')
            : `${t('project.access.transfer.error')}: ${err instanceof Error ? err.message : String(err)}`
      notify({
        text,
        type: 'error',
        category: 'error',
        sessionId: sessionId || undefined,
      })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="project-transfer">
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('project.access.transfer.owner')}
        </span>
        <span
          className="min-w-0 truncate text-xs text-foreground"
          data-testid="project-transfer-owner"
        >
          {ownerLabel}
        </span>
      </div>

      {canTransfer && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPickerOpen((v) => !v)}
            disabled={busy}
            data-testid="project-transfer-open"
          >
            {t('project.access.transfer.action')}
          </Button>
        </div>
      )}

      {canTransfer && pickerOpen && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="project-transfer-picker">
          <input
            type="search"
            value={directory.query}
            onChange={(e) => directory.setQuery(e.target.value)}
            placeholder={t('project.access.usersSearch')}
            aria-label={t('project.access.usersSearch')}
            className="w-full min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="project-transfer-search"
          />
          {directory.loading && (
            <div className="text-[0.625rem] text-muted-foreground/60">{t('common.loading')}</div>
          )}
          {!directory.loading && candidates.length === 0 && (
            <div
              className="text-[0.625rem] text-muted-foreground/60"
              data-testid="project-transfer-empty"
            >
              {t('project.access.usersEmpty')}
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            {candidates.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setPendingUserId(u.id)}
                className="min-h-6 min-w-0 truncate rounded border border-border px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-interactive-hover"
                data-testid={`project-transfer-user-${u.id}`}
              >
                {u.display_name || u.username}
              </button>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingUser !== null}
        onOpenChange={(next) => {
          if (!next) setPendingUserId(null)
        }}
        title={t('project.access.transfer.confirmTitle')}
        message={
          pendingUser
            ? t('project.access.transfer.confirmText', {
                name: pendingUser.display_name || pendingUser.username,
              })
            : undefined
        }
        variant="warning"
        confirmTestId="project-transfer-confirm"
        onConfirm={() => {
          if (pendingUser) void performTransfer(pendingUser.id)
        }}
      />
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
