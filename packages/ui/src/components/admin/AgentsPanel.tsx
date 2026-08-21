import { useEffect, useState, useMemo, useRef } from 'react'
import { synthApi, type AgentInfo, type AgentMode, type ProviderInfo, type ModelGroup } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { IconPicker } from './IconPicker'
import { ColorPicker } from './ColorPicker'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

const CAP_KEYS = [
  'file_read', 'file_write', 'search', 'shell',
  'git_read', 'git_write', 'web', 'task', 'mcp',
]

// Доступные уровни размышлений по типу провайдера (без 'default' — он не хранится в агенте)
const REASONING_BY_PROVIDER_TYPE: Record<string, string[]> = {
  openai: ['low', 'medium', 'high'],
  generic: ['low', 'medium', 'high'],
  anthropic: ['high'],
  ollama: ['low'],
}

function normalizeAgentId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

const AGENT_MODES: AgentMode[] = ['primary', 'subagent', 'system']
type FilterMode = 'all' | 'agents' | 'subagents' | 'system'

/** Нормализует agentMode из API (массив/null/строка для legacy) в массив классов */
function toAgentModes(value: AgentMode[] | string | null | undefined): AgentMode[] {
  if (Array.isArray(value)) return value.length > 0 ? value : ['primary']
  if (value === 'all') return ['primary', 'subagent']
  if (value === 'primary' || value === 'subagent' || value === 'system') return [value]
  return ['primary']
}

interface AgentForm {
  id: string
  display_name: string
  description: string
  provider: string
  model: string
  temperature: number
  top_p: number
  top_k: number
  reasoning_level: string
  agent_mode: AgentMode[]
  context_file: string
  capabilities: string[]
  subagent_prompt: string
  max_steps: number
  icon: string
  color: string
}

const emptyForm = (): AgentForm => ({
  id: '', display_name: '', description: '', provider: '', model: '',
  temperature: 0.7, top_p: 0, top_k: 0, reasoning_level: '',
  agent_mode: ['primary'], context_file: '',
  capabilities: [], subagent_prompt: '', max_steps: 0, icon: '', color: '',
})

function buildForm(a: AgentInfo, detail?: Record<string, unknown> | null): AgentForm {
  const agentMode = toAgentModes(a.agent_mode || (detail?.agentMode as string) || 'primary')
  return {
    id: a.id,
    display_name: a.display_name || '',
    description: a.description || (detail?.description as string) || '',
    provider: a.provider || (detail?.provider as string) || '',
    model: a.model || (detail?.model as string) || '',
    temperature: (detail?.temperature as number) ?? 0.7,
    top_p: (detail?.topP as number) ?? 0,
    top_k: (detail?.topK as number) ?? 0,
    reasoning_level: (a.reasoning_level || (detail?.reasoningLevel as string) || ''),
    agent_mode: agentMode,
    context_file: a.context_file || (detail?.contextFile as string) || '',
    capabilities: (detail?.capabilities as string[]) || a.capabilities,
    subagent_prompt: (a.subagent_prompt || (detail?.subagentPrompt as string) || ''),
    max_steps: (a.max_steps ?? (detail?.maxSteps as number) ?? 0),
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
  const formRef = useRef<HTMLDivElement>(null)

  const filteredAgents = useMemo(() => {
    if (filterMode === 'all') return agents
    if (filterMode === 'agents') return agents.filter((a) => a.agent_mode == null || a.agent_mode.includes('primary'))
    if (filterMode === 'subagents') return agents.filter((a) => a.agent_mode?.includes('subagent'))
    return agents.filter((a) => a.agent_mode?.includes('system'))
  }, [agents, filterMode])

  const hasSubOrSystem = useMemo(
    () => agents.some((a) => a.agent_mode?.includes('subagent') || a.agent_mode?.includes('system')),
    [agents],
  )

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getAllAgents()
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

  // Скролл к форме после монтирования (создание или редактирование).
  // useEffect срабатывает после коммита рендера, когда formRef.current уже не null
  // (setTimeout(0) в React 19 мог выполниться до монтирования формы).
  useEffect(() => {
    if (creating || expanded) {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [creating, expanded])

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
          id: normalizeAgentId(form.id.trim()),
          display_name: form.display_name,
          description: form.description,
          provider: form.provider || undefined,
          model: form.model || undefined,
          temperature: form.temperature,
          top_p: form.top_p || undefined,
          top_k: form.top_k || undefined,
          reasoning_level: form.reasoning_level || undefined,
          // legacy mode, kept for backward compat — always "simple"
          mode: 'simple',
          agent_mode: form.agent_mode,
          context_file: form.context_file || undefined,
          capabilities: form.capabilities,
          subagent_prompt: form.agent_mode.includes('subagent') ? form.subagent_prompt : undefined,
          max_steps: form.max_steps,
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

  // Варианты уровня размышлений: провайдер не выбран → только «не задано»/«отключено»,
  // выбран → плюс уровни, поддерживаемые типом провайдера
  const reasoningOptions = (): string[] => {
    if (!form.provider) return ['', 'none']
    const type = providers.find((p) => p.name === form.provider)?.type
    return Array.from(new Set(['', 'none', ...(REASONING_BY_PROVIDER_TYPE[type ?? ''] ?? [])]))
  }

  const showSubagentFields = form.agent_mode.includes('subagent')

  const renderForm = () => (
    <div ref={formRef} className="bg-background rounded-lg border p-4 space-y-3">
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
            onChange={(e) => setForm({ ...form, id: normalizeAgentId(e.target.value) })}
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

        {/* Agent modes (мультиклассы) */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">{t('admin.agents.agentMode')}</label>
          <div className="flex flex-wrap gap-2">
            {AGENT_MODES.map((m) => {
              const checked = form.agent_mode.includes(m)
              return (
                <label key={m} className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs cursor-pointer select-none transition-colors",
                  checked
                    ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800"
                    : "bg-muted text-muted-foreground border-transparent hover:bg-interactive-hover",
                )}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setForm((f) => ({
                        ...f,
                        agent_mode: checked
                          ? f.agent_mode.filter((x) => x !== m)
                          : [...f.agent_mode, m],
                      }))
                    }}
                    className="accent-blue-600"
                  />
                  {t(`admin.agents.agentMode.${m}`)}
                </label>
              )
            })}
          </div>
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

        {/* Reasoning level */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.reasoning')}</label>
          <select value={form.reasoning_level} onChange={(e) => setForm({ ...form, reasoning_level: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            {reasoningOptions().map((level) => (
              <option key={level} value={level}>
                {level === ''
                  ? t('admin.agents.reasoning.unset')
                  : level === 'none'
                    ? t('admin.agents.reasoning.none')
                    : t(`chat.reasoning.${level}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Max steps — для всех режимов, 0 = без ограничений */}
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.agents.maxSteps')}</label>
          <div className="flex items-center gap-2">
            <input type="number" min={0} step={1} value={form.max_steps}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                setForm({ ...form, max_steps: isNaN(v) ? 0 : v });
              }}
              className="w-24 px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            {form.max_steps === 0 && (
              <span className="text-xs text-muted-foreground">{t('admin.agents.unlimited')}</span>
            )}
          </div>
        </div>

        {/* Subagent-specific fields */}
        {showSubagentFields && (
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">{t('admin.agents.subagentPrompt')}</label>
            <textarea value={form.subagent_prompt}
              onChange={(e) => setForm({ ...form, subagent_prompt: e.target.value })}
              rows={6}
              className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono text-xs" />
          </div>
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
    if (!hasSubOrSystem) return null
    return (
      <div className="flex gap-1 bg-muted rounded-lg p-0.5">
        {(['all', 'agents', 'subagents', 'system'] as const).map((m) => (
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
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 space-y-4">
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
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 overscroll-behavior-contain mt-4">
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
                  {(!a.agent_mode || a.agent_mode.includes('primary')) && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      {t('admin.agents.agentMode.primary')}
                    </span>
                  )}
                  {a.agent_mode?.includes('subagent') && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                      {t('admin.agents.agentMode.subagent')}
                    </span>
                  )}
                  {a.agent_mode?.includes('system') && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300">
                      {t('admin.agents.system')}
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
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400">{t('admin.agents.builtin')}</span>
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

                {/* Agent steps info */}
                <div className="flex gap-1 mb-2">
                  {a.max_steps === 0 || a.max_steps == null ? (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                      {t('admin.agents.stepsCount')}: {t('admin.agents.unlimited')}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      {t('admin.agents.stepsCount')}: ≤{a.max_steps}
                    </span>
                  )}
                </div>

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
    </div>
  )
}
