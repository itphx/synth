import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type ProjectData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import type { ProjectPlan } from '@itphx/synth-shared'

export function ProjectTab() {
  const { t } = useI18n()
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
  const [creating, setCreating] = useState(false)
  const [invariantsDraft, setInvariantsDraft] = useState('')
  const [invariantsSaving, setInvariantsSaving] = useState(false)

  const projectId = session?.project_id ?? null
  const projects = useProjectsStore((s) => s.projects)

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
    const handleCreateProject = async () => {
      const name = window.prompt(t('projectTab.noProject.prompt'))?.trim()
      if (!name) return
      setCreating(true)
      try {
        const created = await useProjectsStore.getState().createProject({ name })
        if (!created) {
          notify({ text: t('projectTab.noProject.createError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
          return
        }
        const updated = await useSessionsStore.getState().moveSession(session.id, created.id)
        if (!updated) {
          notify({ text: t('projectTab.noProject.moveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
          return
        }
        notify({ text: t('projectTab.noProject.created'), type: 'success', category: 'system', sessionId: sessionId || undefined })
      } finally {
        setCreating(false)
      }
    }

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
            <div className="text-[10px] text-muted-foreground/60">{t('projectTab.noProject.hint')}</div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={creating}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {creating ? t('projectTab.noProject.creating') : t('projectTab.noProject.create')}
              </button>
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

  const handleSaveWorkspace = async () => {
    if (!project) return
    const path = workspaceDraft.trim()
    if (!path) {
      notify({ text: t('projectTab.workspace.pathRequired'), type: 'warning', category: 'error', sessionId: sessionId || undefined })
      return
    }
    setSaving(true)
    try {
      const updated = await synthApi.updateProject(project.id, { workspace: path })
      setProject(updated)
      setWorkspaceDraft(updated.workspace || '')
      useProjectsStore.setState((s) => ({
        projects: s.projects.map((p) => (p.id === updated.id ? updated : p)),
      }))
      notify({ text: t('projectTab.workspace.saved'), type: 'success', category: 'system', sessionId: sessionId || undefined })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify({ text: `${t('projectTab.workspace.saveError')}: ${msg}`, type: 'error', category: 'error', sessionId: sessionId || undefined })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveInvariants = async () => {
    if (!project) return
    setInvariantsSaving(true)
    try {
      const updated = await synthApi.updateProject(project.id, { invariants: invariantsDraft })
      setProject(updated)
      setInvariantsDraft(updated.invariants || '')
      useProjectsStore.setState((s) => ({
        projects: s.projects.map((p) => (p.id === updated.id ? updated : p)),
      }))
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
        </div>
      </Section>

      <Section title={t('projectTab.workspace.title')}>
        <div className="flex gap-2">
          <input
            type="text"
            value={workspaceDraft}
            onChange={(e) => setWorkspaceDraft(e.target.value)}
            placeholder={t('projectTab.workspace.placeholder')}
            className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => e.key === 'Enter' && handleSaveWorkspace()}
          />
          <button
            onClick={handleSaveWorkspace}
            disabled={saving}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? t('projectTab.workspace.saving') : t('projectTab.workspace.save')}
          </button>
        </div>
        <div className="text-[10px] text-muted-foreground/60">{t('projectTab.workspace.hint')}</div>
      </Section>

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
            <div className="text-[10px] text-muted-foreground/60">{t('projectTab.invariants.hint')}</div>
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

      <Section title={t('projectTab.log.title')}>
        <ProjectLogBlock project={project} />
      </Section>

      <PlanSection project={project} />
    </div>
  )
}

function PlanSection({ project }: { project: ProjectData | null }) {
  const { t } = useI18n()
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
          <div className="text-[10px] text-muted-foreground/60">{entry.created_at}</div>
          <div className="text-xs">{entry.text}</div>
        </div>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] text-muted-foreground/60 uppercase tracking-wide">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-[11px]' : ''}>{value}</span>
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
        <div className="mt-0.5 text-[10px] text-muted-foreground/60">{t('sessionTab.plan.hint')}</div>
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
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/80">
                  <span className="font-medium">{col.name}</span>
                  <span className="text-muted-foreground/50">({colItems.length})</span>
                </div>
                {colItems.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground/50">—</div>
                ) : (
                  <ul className="space-y-1">
                    {colItems.map((item) => (
                      <li key={item.id} className="rounded-md bg-background/60 px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase text-muted-foreground">
                            {PRIORITY_LABELS[item.priority] ?? item.priority}
                          </span>
                          <span className="text-xs">{item.title}</span>
                        </div>
                        {item.description && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground/70">{item.description}</div>
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
