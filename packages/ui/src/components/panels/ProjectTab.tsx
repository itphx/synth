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
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '@/components/ui/Toggle'
import { EntityIconTrigger } from '@/components/ui/EntityIconTrigger'
import { InfoField as Field, InfoSection as Section } from '@/components/ui/settings'
import { DirectoryPickerDialog } from '@/components/ui/DirectoryPickerDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CreateProjectPopover } from '@/components/panels/CreateProjectPopover'
import { ExpandableListRow, RowBadge } from '@/components/panels/ExpandableListRow'
import { PanelTab } from './PanelTab'
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
  // AD-075: выбор каталога через FS-диалог + подтверждение пути вне workspacesRoot.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const [invariantsDraft, setInvariantsDraft] = useState('')

  // AD-071 §2.4: проектный MCP-скоуп (owner/lead/admin)
  const user = useAuthStore((s) => s.user)
  // AD-075: managed-развёртывание владеет ФС проекта — путь не редактируется.
  const deployment = useAuthStore((s) => s.deployment)
  const [projectMcp, setProjectMcp] = useState<ProjectMcpResponse | null>(null)
  const [mcpRegistry, setMcpRegistry] = useState<McpRegistryEntry[]>([])

  // AD-046 §4.5: проектный скоуп скиллов (owner/lead/admin)
  const [projectSkills, setProjectSkills] = useState<ProjectSkillsResponse | null>(null)

  const projectId = session?.project_id ?? null
  const projects = useProjectsStore((s) => s.projects)

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

  /** AD-046 §4.5: проектный скоуп скиллов — «Доступен»/«Включён по умолчанию». */
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
          <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center space-y-3">
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

  // AD-075: managed-проект (ФС у backend) и remote-проект (локальный UI без доступа к ФС)
  // — workspace задаётся сервером, поле только для чтения.
  const isRemoteProject = project?.origin === 'remote' || (project?.id?.startsWith('remote:') ?? false)
  const workspaceReadOnly = deployment === 'managed' || isRemoteProject

  /**
   * AD-075: сохранить workspace. При 409 `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`
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

  const handleIconChange = async (icon: string | null) => {
    if (!project) return
    const prevIcon = project.icon
    await run({
      key: 'icon',
      run: () => synthApi.updateProject(project.id, { icon }),
      onSuccess: (updated) => {
        setProject(updated)
        useProjectsStore.getState().updateProjectInList(updated)
      },
      onError: () => setProject((p) => (p ? { ...p, icon: prevIcon } : p)),
    })
  }

  const handleColorChange = async (color: string | null) => {
    if (!project) return
    const prevColor = project.color
    await run({
      key: 'color',
      run: () => synthApi.updateProject(project.id, { color }),
      onSuccess: (updated) => {
        setProject(updated)
        useProjectsStore.getState().updateProjectInList(updated)
      },
      onError: () => setProject((p) => (p ? { ...p, color: prevColor } : p)),
    })
  }

  return (
    <PanelTab>
      <Section title={t('rightPanel.tab.project')}>
        <div className="space-y-1.5">
          <Field
            label={t('projectTab.info.name')}
            valueNode={
              <span className="inline-flex min-w-0 items-center justify-end gap-1.5 align-middle">
                <EntityIconTrigger
                  icon={project?.icon}
                  color={project?.color}
                  onIconChange={handleIconChange}
                  onColorChange={handleColorChange}
                  disabled={isPending('icon') || isPending('color')}
                  fallbackIcon="folder-3"
                  testId="project-icon-color-trigger"
                  label={t('leftPanel.iconColor')}
                />
                <span className="min-w-0 break-words">{project?.name || '—'}</span>
              </span>
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

/** AD-071 §2.4: проектный скоуп MCP — доступность и default-on (owner/lead/admin). */
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
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
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

/** AD-046 §4.5: проектный скоуп скиллов — «Доступен» и «Включён по умолчанию». */
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
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
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
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
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
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
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
                      <li key={item.id} className="rounded-md bg-background/60 px-2 py-1">
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
