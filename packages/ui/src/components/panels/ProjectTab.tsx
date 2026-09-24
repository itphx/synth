import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { formatDateTime } from '@/lib/formatDate'
import { synthApi, type ProjectData, type ProjectMcpResponse, type ProjectSkillsResponse, type EffectiveSkillEntry } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '@/components/ui/Toggle'
import { InfoField as Field, InfoSection as Section } from '@/components/ui/settings'
import { DirectoryPickerDialog } from '@/components/ui/DirectoryPickerDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CreateProjectPopover } from '@/components/panels/CreateProjectPopover'
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
  const [saving, setSaving] = useState(false)
  // AD-075: выбор каталога через FS-диалог + подтверждение пути вне workspacesRoot.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const [invariantsDraft, setInvariantsDraft] = useState('')
  const [invariantsSaving, setInvariantsSaving] = useState(false)

  // AD-071 §2.4: проектный MCP-скоуп (owner/lead/admin)
  const user = useAuthStore((s) => s.user)
  // AD-075: managed-развёртывание владеет ФС проекта — путь не редактируется.
  const deployment = useAuthStore((s) => s.deployment)
  const [projectMcp, setProjectMcp] = useState<ProjectMcpResponse | null>(null)
  const [mcpRegistry, setMcpRegistry] = useState<McpRegistryEntry[]>([])
  const [mcpSaving, setMcpSaving] = useState(false)

  // AD-046 §4.5: проектный скоуп скиллов (owner/lead/admin)
  const [projectSkills, setProjectSkills] = useState<ProjectSkillsResponse | null>(null)
  const [skillsSaving, setSkillsSaving] = useState(false)

  const projectId = session?.project_id ?? null
  const projects = useProjectsStore((s) => s.projects)

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
    if (!projectId || !projectMcp || mcpSaving) return
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
    setMcpSaving(true)
    try {
      const updated = await synthApi.updateProjectMcp(projectId, {
        enabled: [...enabled],
        defaultOn: [...defaultOn],
      })
      setProjectMcp(updated)
    } catch {
      notify({ text: t('projectTab.mcp.saveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
    } finally {
      setMcpSaving(false)
    }
  }

  /** AD-046 §4.5: проектный скоуп скиллов — «Доступен»/«Включён по умолчанию». */
  const handleToggleProjectSkill = async (name: string, kind: 'enabled' | 'defaultOn') => {
    if (!projectId || !projectSkills || skillsSaving) return
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
    setSkillsSaving(true)
    try {
      const updated = await synthApi.updateProjectSkills(projectId, {
        enabled: [...enabled],
        defaultOn: [...defaultOn],
      })
      setProjectSkills(updated)
    } catch (err) {
      const status = (err as { status?: number })?.status
      notify({
        text: status === 403 ? t('projectTab.skills.forbidden') : t('projectTab.skills.saveError'),
        type: 'error',
        category: 'error',
        sessionId: sessionId || undefined,
      })
    } finally {
      setSkillsSaving(false)
    }
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
      <div className="p-4 text-sm text-muted-foreground">
        {t('rightPanel.params.noSessions')}
      </div>
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
      <div className="p-4 space-y-4">
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
      </div>
    )
  }

  if (loading && !project) {
    return (
      <div className="p-4 text-sm text-muted-foreground">{t('projectTab.loading')}</div>
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
    setSaving(true)
    try {
      const updated = await synthApi.updateProject(project.id, { workspace: path, confirmOutsideRoot })
      setProject(updated)
      setWorkspaceDraft(updated.workspace || '')
      useProjectsStore.getState().updateProjectInList(updated)
      notify({ text: t('projectTab.workspace.saved'), type: 'success', category: 'system', sessionId: sessionId || undefined })
    } catch (err) {
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
      notify({ text: `${t('projectTab.workspace.saveError')}: ${msg}`, type: 'error', category: 'error', sessionId: sessionId || undefined })
    } finally {
      setSaving(false)
    }
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
    setInvariantsSaving(true)
    try {
      const updated = await synthApi.updateProject(project.id, { invariants: invariantsDraft })
      setProject(updated)
      setInvariantsDraft(updated.invariants || '')
      useProjectsStore.getState().updateProjectInList(updated)
      notify({ text: t('projectTab.invariants.saved'), type: 'success', category: 'system', sessionId: sessionId || undefined })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify({ text: `${t('common.saveError')}: ${msg}`, type: 'error', category: 'error', sessionId: sessionId || undefined })
    } finally {
      setInvariantsSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <Section title={t('rightPanel.tab.project')}>
        <div className="space-y-1.5">
          <Field label={t('projectTab.info.name')} value={project?.name || '—'} />
          <Field label={t('projectTab.info.id')} value={project?.id || '—'} mono />
          <Field label={t('projectTab.info.creator')} value={project?.owner_id || '—'} />
          <Field label={t('projectTab.info.created')} value={formatDateTime(project?.created_at, locale)} />
        </div>
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
              disabled={saving}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="project-workspace-save"
            >
              {saving ? t('projectTab.workspace.saving') : t('projectTab.workspace.save')}
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
              disabled={invariantsSaving}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {invariantsSaving ? t('projectTab.invariants.saving') : t('projectTab.invariants.save')}
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
          />
        </Section>
      )}

      {canManageMcp && (
        <Section title={t('projectTab.skills.title')}>
          <ProjectSkillsBlock
            skills={projectSkills}
            saving={skillsSaving}
            onToggle={handleToggleProjectSkill}
          />
        </Section>
      )}

      <Section title={t('projectTab.log.title')}>
        <ProjectLogBlock project={project} />
      </Section>

      <PlanSection project={project} />
    </div>
  )
}

/** AD-071 §2.4: проектный скоуп MCP — доступность и default-on (owner/lead/admin). */
function ProjectMcpBlock({
  mcp,
  registry,
  onToggle,
}: {
  mcp: ProjectMcpResponse | null
  registry: McpRegistryEntry[]
  onToggle: (name: string, kind: 'enabled' | 'defaultOn') => void
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
          <div
            key={name}
            data-testid={`project-mcp-${name}`}
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-input px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="truncate text-xs text-foreground">{name}</span>
                {isSystem && (
                  <span className="rounded bg-primary/15 px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-primary">
                    {t('rightPanel.stats.mcpLevel.system')}
                  </span>
                )}
              </div>
              {isSystem && (
                <div className="mt-0.5 text-[0.625rem] text-muted-foreground/70">{t('projectTab.mcp.systemHint')}</div>
              )}
            </div>
            {!isSystem && (
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1">
                  <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.mcp.available')}</span>
                  <Toggle
                    enabled={enabled}
                    onToggle={() => onToggle(name, 'enabled')}
                    ariaLabel={`${name}: ${t('projectTab.mcp.available')}`}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.mcp.defaultOn')}</span>
                  <Toggle
                    enabled={defaultOn}
                    onToggle={() => onToggle(name, 'defaultOn')}
                    ariaLabel={`${name}: ${t('projectTab.mcp.defaultOn')}`}
                  />
                </label>
              </div>
            )}
          </div>
        )
      })}
      <p className="text-[0.625rem] text-muted-foreground/60">{t('projectTab.mcp.hint')}</p>
    </div>
  )
}

/** AD-046 §4.5: проектный скоуп скиллов — «Доступен» и «Включён по умолчанию». */
function ProjectSkillsBlock({
  skills,
  saving,
  onToggle,
}: {
  skills: ProjectSkillsResponse | null
  saving: boolean
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
          <div
            key={skill.name}
            data-testid={`project-skill-${skill.name}`}
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-input px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="truncate text-xs text-foreground">{skill.name}</span>
                <span className="rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
                  {t(`skills.scope.${skill.scope}`)}
                </span>
                {!skill.trusted && (
                  <span className="rounded bg-destructive/15 px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-destructive">
                    {t('skills.untrusted')}
                  </span>
                )}
              </div>
              {skill.description && (
                <div className="mt-0.5 text-[0.625rem] text-muted-foreground/70 break-words">{skill.description}</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="flex items-center gap-1">
                <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.skills.available')}</span>
                <Toggle
                  enabled={enabled}
                  onToggle={() => onToggle(skill.name, 'enabled')}
                  disabled={saving}
                  ariaLabel={`${skill.name}: ${t('projectTab.skills.available')}`}
                />
              </label>
              <label className="flex items-center gap-1">
                <span className="text-[0.625rem] text-muted-foreground">{t('projectTab.skills.defaultOn')}</span>
                <Toggle
                  enabled={defaultOn}
                  onToggle={() => onToggle(skill.name, 'defaultOn')}
                  disabled={saving}
                  ariaLabel={`${skill.name}: ${t('projectTab.skills.defaultOn')}`}
                />
              </label>
            </div>
          </div>
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
              <div key={col.id}>
                <div className="mb-1 flex items-center gap-1.5 text-[0.625rem] text-muted-foreground/80">
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
