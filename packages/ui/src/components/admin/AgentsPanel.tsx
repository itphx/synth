import { useEffect, useState, useMemo } from 'react'
import { synthApi, type AgentInfo, type ProviderInfo, type ModelGroup } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { IconPicker } from './IconPicker'
import { ColorPicker } from './ColorPicker'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

const CAP_KEYS = [
  'file_read', 'file_write', 'search', 'shell',
  'git_read', 'git_write', 'web', 'task', 'mcp',
]

const AGENT_MODES = ['primary', 'subagent', 'all'] as const
type FilterMode = 'all' | 'agents' | 'subagents'

interface AgentForm {
  id: string
  display_name: string
  description: string
  provider: string
  model: string
  temperature: number
  top_p: number
  top_k: number
  agent_mode: 'primary' | 'subagent' | 'all'
  context_file: string
  capabilities: string[]
  subagent_prompt: string
  max_steps: number
  icon: string
  color: string
}

const emptyForm = (): AgentForm => ({
  id: '', display_name: '', description: '', provider: '', model: '',
  temperature: 0.7, top_p: 0, top_k: 0,
  agent_mode: 'primary', context_file: '',
  capabilities: [], subagent_prompt: '', max_steps: 10, icon: '', color: '',
})

function buildForm(a: AgentInfo, detail?: Record<string, unknown> | null): AgentForm {
  const agentMode = (a.agent_mode || (detail?.agentMode as string) || 'primary') as AgentForm['agent_mode']
  return {
    id: a.id,
    display_name: a.display_name || '',
    description: a.description || (detail?.description as string) || '',
    provider: a.provider || (detail?.provider as string) || '',
    model: a.model || (detail?.model as string) || '',
    temperature: (detail?.temperature as number) ?? 0.7,
    top_p: (detail?.topP as number) ?? 0,
    top_k: (detail?.topK as number) ?? 0,
    agent_mode: agentMode,
    context_file: a.context_file || (detail?.contextFile as string) || '',
    capabilities: (detail?.capabilities as string[]) || a.capabilities,
    subagent_prompt: (a.subagent_prompt || (detail?.subagentPrompt as string) || ''),
    max_steps: (a.max_steps || (detail?.maxSteps as number) || 10),
    icon: a.icon || (detail?.icon as string) || '',
    color: a.color || (detail?.color as string) || '',
  }
}

export const AgentsPanel = () => {
  const { t } = useI18n()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<AgentForm>(emptyForm())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [models, setModels] = useState<{ provider: string; models: { id: string; name: string }[] }[]>([])
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [filterMode, setFilterMode] = useState<FilterMode>('all')

  const filteredAgents = useMemo(() => {
    if (filterMode === 'all') return agents
    if (filterMode === 'subagents') return agents.filter((a) => a.agent_mode === 'subagent' || a.agent_mode === 'all')
    return agents.filter((a) => !a.agent_mode || a.agent_mode === 'primary' || a.agent_mode === 'all')
  }, [agents, filterMode])

  const hasSubagents = useMemo(() => agents.some((a) => a.agent_mode === 'subagent' || a.agent_mode === 'all'), [agents])

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getAgents()
      setAgents(data.agents || [])
    } finally {
      setLoading(false)
    }
  }

  const loadMeta = async () => {
    const [provData, modelData] = await Promise.all([
      synthApi.getProviders().catch(() => ({ providers: [] as ProviderInfo[], default_provider: '' })),
      synthApi.getModels().catch(() => [] as ModelGroup[]),
    ])
    setProviders(provData.providers)
    const flatModels: { provider: string; models: { id: string; name: string }[] }[] = modelData.map((g) => ({
      provider: g.provider.name,
      models: g.models.map((m) => ({ id: m.id, name: m.name })),
    }))
    setModels(flatModels)

    try {
      const [roleCtx, userCtx] = await Promise.all([
        synthApi.fetchJSON<{ files: { name: string; category: string }[] }>('/api/v2/context/files?category=role').catch(() => ({ files: [] })),
        synthApi.fetchJSON<{ files: { name: string; category: string }[] }>('/api/v2/context/files?category=user').catch(() => ({ files: [] })),
      ])
      const files = [...(roleCtx.files || []), ...(userCtx.files || [])]
      setContextFiles(files.map((f) => f.name))
    } catch { /* ignore */ }
  }

  useEffect(() => { load(); loadMeta() }, [])

  const handleCreate = () => {
    setForm(emptyForm())
    setCreating(true)
    setError('')
  }

  const handleEdit = async (a: AgentInfo) => {
    setError('')
    try {
      const detail = await synthApi.fetchJSON<Record<string, unknown>>(`/api/v2/agents/${encodeURIComponent(a.id)}`)
      setForm(buildForm(a, detail))
    } catch {
      setForm(buildForm(a))
    }
    setExpanded(a.id)
    setCreating(false)
  }

  const handleCancel = () => {
    setExpanded(null)
    setCreating(false)
    setError('')
  }

  const handleSave = async () => {
    if (!form.id.trim()) { setError(t('common.nameRequired')); return }
    setSaving(true)
    setError('')
    try {
      await synthApi.fetchJSON('/api/v2/agents', {
        method: 'POST',
        body: JSON.stringify({
          id: form.id.trim(),
          display_name: form.display_name,
          description: form.description,
          provider: form.provider || undefined,
          model: form.model || undefined,
          temperature: form.temperature,
          top_p: form.top_p || undefined,
          top_k: form.top_k || undefined,
          // legacy mode, kept for backward compat — always "simple"
          mode: 'simple',
          agent_mode: form.agent_mode,
          context_file: form.context_file || undefined,
          capabilities: form.capabilities,
          subagent_prompt: form.agent_mode !== 'primary' ? form.subagent_prompt : undefined,
          max_steps: form.agent_mode !== 'primary' ? form.max_steps : undefined,
          icon: form.icon || undefined,
          color: form.color || undefined,
        }),
      })
      setExpanded(null)
      setCreating(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (a: AgentInfo) => {
    try {
      await synthApi.fetchJSON(`/api/v2/agents/${encodeURIComponent(a.id)}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !a.enabled }),
      })
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (a: AgentInfo) => {
    const label = a.is_builtin ? t('admin.agents.confirmReset', { name: a.display_name }) : t('admin.agents.confirmDelete', { name: a.display_name })
    if (!confirm(label)) return
    try {
      await synthApi.fetchJSON(`/api/v2/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' })
      await load()
    } catch { /* ignore */ }
  }

  const toggleCap = (cap: string) => {
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(cap)
        ? f.capabilities.filter((c) => c !== cap)
        : [...f.capabilities, cap],
    }))
  }

  const availableModels = () => {
    if (!form.provider) return []
    const group = models.find((g) => g.provider === form.provider)
    return group?.models || []
  }

  const showSubagentFields = form.agent_mode === 'subagent' || form.agent_mode === 'all'

  const renderForm = () => (
    <div className="bg-background rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">{expanded ? t('admin.agents.edit', { id: form.id }) : t('admin.agents.new')}</h4>
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? t('admin.agents.saving') : t('admin.agents.save')}
          </button>
          <button onClick={handleCancel} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">{t('admin.agents.cancel')}</button>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.id')}</label>
          <input type="text" value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
            disabled={!!expanded}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.displayName')}</label>
          <input type="text" value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground">{t('admin.agents.description')}</label>
          <input type="text" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>

        {/* Agent mode */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.agentMode')}</label>
          <select value={form.agent_mode}
            onChange={(e) => setForm({ ...form, agent_mode: e.target.value as AgentForm['agent_mode'] })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            {AGENT_MODES.map((m) => (
              <option key={m} value={m}>{t(`admin.agents.agentMode.${m}`)}</option>
            ))}
          </select>
        </div>

        {/* Provider select */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.provider')}</label>
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value, model: form.provider !== e.target.value ? '' : form.model })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">{t('admin.agents.default_2')}</option>
            {providers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </div>

        {/* Model select */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.model')}</label>
          <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">{t('admin.agents.default_2')}</option>
            {availableModels().map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>

        {/* Context file select */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.contextFile')}</label>
          <select value={form.context_file} onChange={(e) => setForm({ ...form, context_file: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">{t('admin.agents.autoById')}</option>
            {contextFiles.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Temperature */}
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground">{t('admin.agents.temperature', { value: form.temperature.toFixed(2) })}</label>
          <input type="range" min="0" max="2" step="0.05" value={form.temperature}
            onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
            className="w-full accent-blue-600" />
        </div>

        {/* Top P */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.topP')}</label>
          <input type="number" min="0" max="1" step="0.01" value={form.top_p || ''}
            onChange={(e) => setForm({ ...form, top_p: e.target.value ? parseFloat(e.target.value) : 0 })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>

        {/* Top K */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.topK')}</label>
          <input type="number" min="0" max="1000" step="1" value={form.top_k || ''}
            onChange={(e) => setForm({ ...form, top_k: e.target.value ? parseInt(e.target.value) : 0 })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>

        {/* Subagent-specific fields */}
        {showSubagentFields && (
          <>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">{t('admin.agents.subagentPrompt')}</label>
              <textarea value={form.subagent_prompt}
                onChange={(e) => setForm({ ...form, subagent_prompt: e.target.value })}
                rows={6}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono text-xs" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('admin.agents.maxSteps')}</label>
              <input type="number" min={1} max={50} step={1} value={form.max_steps}
                onChange={(e) => setForm({ ...form, max_steps: parseInt(e.target.value) || 10 })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </>
        )}
      </div>

      {/* Capabilities */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t('admin.agents.capabilities')}</label>
        <div className="flex flex-wrap gap-1">
          {CAP_KEYS.map((k) => (
            <button key={k} type="button" onClick={() => toggleCap(k)} className={cn(
              "px-2 py-0.5 rounded text-[11px] transition-colors",
              form.capabilities.includes(k)
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                : "bg-muted text-muted-foreground hover:bg-interactive-hover"
            )}>{t(`admin.agents.cap.${k}`)}</button>
          ))}
        </div>
      </div>

      {/* Icons */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t('admin.agents.icon')}</label>
        <div className="flex items-center gap-2 mb-2">
          {form.icon && <Icon name={form.icon as never} className="size-5" />}
          <span className="text-xs text-muted-foreground">{form.icon || t('admin.agents.notSelected')}</span>
          {form.icon && (
            <button onClick={() => setForm({ ...form, icon: '' })} className="text-[11px] text-muted-foreground hover:text-red-500">{t('admin.agents.reset')}</button>
          )}
        </div>
        <IconPicker value={form.icon || null} onChange={(icon) => setForm({ ...form, icon })} />
      </div>

      {/* Colors */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t('admin.agents.color')}</label>
        <ColorPicker value={form.color || null} onChange={(color) => setForm({ ...form, color })} />
      </div>
    </div>
  )

  const renderFilterTabs = () => {
    if (!hasSubagents) return null
    return (
      <div className="flex gap-1 bg-muted rounded-lg p-0.5">
        {(['all', 'agents', 'subagents'] as const).map((m) => (
          <button key={m} onClick={() => setFilterMode(m)} className={cn(
            'px-3 py-1 rounded-md text-xs font-medium transition-colors',
            filterMode === m
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )} suppressHydrationWarning>
            {t(`admin.agents.filter.${m}`)}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.agents.title')}</h3>
          <p className="text-muted-foreground text-sm">
            {filterMode === 'subagents'
              ? t('admin.agents.filter.subagents_count', { count: filteredAgents.length })
              : t('admin.agents.count', { count: filteredAgents.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {renderFilterTabs()}
          <button onClick={handleCreate} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">
            <Icon name="add" className="size-3.5" />{t('admin.agents.add')}
          </button>
        </div>
      </div>

      {(creating || expanded) && renderForm()}

      {loading ? (
        <div className="grid grid-cols-2 gap-3">{[1,2,3,4].map((i) => <div key={i} className="bg-background rounded-lg border p-4 animate-pulse"><div className="h-4 bg-muted rounded w-24" /></div>)}</div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {filteredAgents.map((a) => (
            <div key={a.id}>
              {/* Compact card */}
              <div className={cn(
                "bg-background rounded-lg border p-4",
                !a.enabled && 'opacity-50',
              )}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon name={a.icon as never || 'robot-2'} className="size-4 shrink-0" style={a.color ? { color: `var(${a.color})` } : undefined} />
                    <span className="font-medium text-sm truncate">{a.display_name}</span>
                    <code className="text-[10px] text-muted-foreground shrink-0">{a.id}</code>
                  </div>
                  <button onClick={() => handleToggle(a)} className={cn(
                    "relative w-9 h-5 rounded-full transition-colors shrink-0 ml-1",
                    a.enabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'
                  )}>
                    <span className={cn(
                      "absolute top-0.5 size-4 rounded-full bg-white transition-all shadow-sm",
                      a.enabled ? 'right-0.5' : 'left-0.5'
                    )} />
                  </button>
                </div>

                {/* Badges row */}
                <div className="flex flex-wrap gap-1 mb-2">
                  {/* Agent mode badge */}
                  {a.agent_mode && a.agent_mode !== 'primary' && (
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-medium',
                      a.agent_mode === 'subagent'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                        : 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300'
                    )}>
                      {t(`admin.agents.agentMode.${a.agent_mode}`)}
                    </span>
                  )}
                  {(!a.agent_mode || a.agent_mode === 'primary') && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      {t('admin.agents.agentMode.primary')}
                    </span>
                  )}
                  {a.provider && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">{a.provider}</span>
                  )}
                  {a.model && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">{a.model}</span>
                  )}
                  {a.context_file && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">{a.context_file}</span>
                  )}
                  {a.is_builtin && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400">{t('admin.agents.system')}</span>
                  )}
                  {a.is_builtin && a.is_overridden && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300">{t('admin.agents.modified')}</span>
                  )}
                </div>

                {/* Capabilities */}
                <div className="flex flex-wrap gap-1 mb-2">
                  {a.capabilities.slice(0, 6).map((c) => (
                    <span key={c} className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      {t(`admin.agents.cap.${c}`)}
                    </span>
                  ))}
                  {a.capabilities.length > 6 && (
                    <span className="text-[10px] text-muted-foreground">+{a.capabilities.length - 6}</span>
                  )}
                  {a.capabilities.length === 0 && (
                    <span className="text-[10px] text-muted-foreground">{t('admin.agents.noCapabilities')}</span>
                  )}
                </div>

                {/* Subagent info */}
                {(a.agent_mode === 'subagent' || a.agent_mode === 'all') && (
                  <div className="flex gap-1 mb-2">
                    {a.max_steps != null && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                        max {a.max_steps} steps
                      </span>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-1">
                  <button onClick={() => handleEdit(a)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover">{t('common.edit')}</button>
                  <button onClick={() => handleDelete(a)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950">
                    {a.is_builtin ? t('admin.agents.reset') : t('common.delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
