import { useEffect, useState, useMemo, useRef } from 'react'
import { synthApi, type AgentInfo, type AgentMode, type ProviderInfo, type ModelGroup } from '@/lib/api/synthApi'
import { Icon, isIconName } from '@/components/icon/Icon'
import { IconPicker } from './IconPicker'
import { ColorPicker } from './ColorPicker'
import { Toggle } from '../ui/Toggle'
import { Button } from '../ui/button'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { useAgentsStore } from '@/stores/agentsStore'
import { SshKeysSettings } from '../settings/SshKeysSettings'
import {
  NumberField,
  SettingsActions,
  SettingsField,
  SettingsPanel,
  SettingsSection,
  SelectField,
  SliderField,
  Tabs,
  TextArea,
  TextField,
  useSettingsDraft,
} from '../ui/settings'

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
const FILTER_MODES: FilterMode[] = ['all', 'agents', 'subagents', 'system']

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
  const [defaultAgentInfo, setDefaultAgentInfo] = useState<{
    defaultAgent: string
    isOverridden: boolean
    defaults: string
  } | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  // Агент по умолчанию (AD-072): контрол в начале панели, сохранение через API.
  const loadDefaultAgent = async () => {
    try {
      setDefaultAgentInfo(await synthApi.getDefaultAgentInfo())
    } catch { /* тихо: панель не должна ломаться, если настройка недоступна */ }
  }

  const defaultAgentDraft = useSettingsDraft<string>({
    value: defaultAgentInfo?.defaultAgent ?? null,
    defaultValue: defaultAgentInfo?.defaults ?? null,
    onSave: async (draft) => {
      await synthApi.setDefaultAgent(draft)
      await loadDefaultAgent()
      // defaultAgentId в чате подхватывает новое значение с сервера.
      await useAgentsStore.getState().loadAgents()
      return draft
    },
  })

  const handleResetDefaultAgent = async () => {
    try {
      const info = await synthApi.resetDefaultAgent()
      setDefaultAgentInfo(info)
      // Явно синхронизируем черновик: в dirty-состоянии хук сохраняет выбор
      // пользователя, а Reset должен вернуть визуально дефолт.
      defaultAgentDraft.setDraft(info.defaultAgent)
      await useAgentsStore.getState().loadAgents()
    } catch { /* ignore */ }
  }

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

  // Primary-агенты — те же, что в фильтре чата (agent_mode == null || includes('primary')).
  const primaryAgents = useMemo(
    () => agents.filter((a) => a.agent_mode == null || a.agent_mode.includes('primary')),
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
        synthApi.getContextFiles('role').catch(() => ({ files: [] })),
        synthApi.getContextFiles('user').catch(() => ({ files: [] })),
      ])
      const files = [...(roleCtx.files || []), ...(userCtx.files || [])]
      setContextFiles(files.map((f) => f.name))
    } catch { /* ignore */ }
  }

  useEffect(() => { load(); loadMeta(); loadDefaultAgent() }, [])

  const handleCreate = () => {
    setForm(emptyForm())
    setCreating(true)
    setError('')
  }

  const handleEdit = async (a: AgentInfo) => {
    setError('')
    try {
      const detail = await synthApi.getAgentDetail(a.id)
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
      await synthApi.saveAgent({
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
      await synthApi.toggleAgent(a.id, !a.enabled)
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (a: AgentInfo) => {
    const label = a.is_builtin ? t('admin.agents.confirmReset', { name: a.display_name }) : t('admin.agents.confirmDelete', { name: a.display_name })
    if (!(await confirm({ title: label, variant: 'danger' }))) return
    try {
      await synthApi.deleteAgent(a.id)
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

  const reasoningLabel = (level: string): string =>
    level === ''
      ? t('admin.agents.reasoning.unset')
      : level === 'none'
        ? t('admin.agents.reasoning.none')
        : t(`chat.reasoning.${level}`)

  const showSubagentFields = form.agent_mode.includes('subagent')

  const renderForm = () => (
    <div ref={formRef}>
      <SettingsSection title={expanded ? t('admin.agents.edit', { id: form.id }) : t('admin.agents.new')}>
        {error && <p className="text-xs text-status-error min-w-0 break-words">{error}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField
            label={t('admin.agents.id')}
            value={form.id}
            onChange={(e) => setForm({ ...form, id: normalizeAgentId(e.target.value) })}
            disabled={!!expanded}
          />
          <TextField
            label={t('admin.agents.displayName')}
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
          />
          <div className="sm:col-span-2">
            <TextField
              label={t('admin.agents.description')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {/* Agent modes (мультиклассы) */}
          <SettingsField label={t('admin.agents.agentMode')}>
            <div className="flex flex-wrap gap-2 min-w-0">
              {AGENT_MODES.map((m) => {
                const checked = form.agent_mode.includes(m)
                return (
                  <label key={m} className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs cursor-pointer select-none transition-colors',
                    checked
                      ? 'bg-secondary text-secondary-foreground border-border'
                      : 'bg-muted text-muted-foreground border-transparent hover:bg-interactive-hover',
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
                      className="accent-primary"
                    />
                    {t(`admin.agents.agentMode.${m}`)}
                  </label>
                )
              })}
            </div>
          </SettingsField>

          <SelectField
            label={t('admin.agents.provider')}
            value={form.provider}
            onValueChange={(value) => setForm({ ...form, provider: value, model: form.provider !== value ? '' : form.model })}
            ariaLabel={t('admin.agents.provider')}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.agents.default_2')}</SelectItem>
              {providers.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.agents.model')}
            value={form.model}
            onValueChange={(value) => setForm({ ...form, model: value })}
            ariaLabel={t('admin.agents.model')}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.agents.default_2')}</SelectItem>
              {availableModels().map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('admin.agents.contextFile')}
            value={form.context_file}
            onValueChange={(value) => setForm({ ...form, context_file: value })}
            ariaLabel={t('admin.agents.contextFile')}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.agents.autoById')}</SelectItem>
              {contextFiles.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
            </SelectContent>
          </SelectField>

          {/* Temperature */}
          <div className="sm:col-span-2">
            <SliderField
              label={t('common.temperature')}
              min={0}
              max={2}
              step={0.05}
              value={form.temperature}
              onValueChange={(value) => setForm({ ...form, temperature: value })}
              formatValue={(value) => value.toFixed(2)}
            />
          </div>

          <NumberField
            label={t('admin.agents.topP')}
            min={0}
            max={1}
            step={0.01}
            value={form.top_p || ''}
            onChange={(e) => setForm({ ...form, top_p: e.target.value ? parseFloat(e.target.value) : 0 })}
          />

          <NumberField
            label={t('admin.agents.topK')}
            min={0}
            max={1000}
            step={1}
            value={form.top_k || ''}
            onChange={(e) => setForm({ ...form, top_k: e.target.value ? parseInt(e.target.value) : 0 })}
          />

          <SelectField
            label={t('admin.agents.reasoning')}
            value={form.reasoning_level}
            onValueChange={(value) => setForm({ ...form, reasoning_level: value })}
            ariaLabel={t('admin.agents.reasoning')}
          >
            <SelectContent>
              {reasoningOptions().map((level) => (
                <SelectItem key={level} value={level}>
                  {reasoningLabel(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          {/* Max steps — для всех режимов, 0 = без ограничений */}
          <NumberField
            label={t('admin.agents.maxSteps')}
            min={0}
            step={1}
            value={form.max_steps}
            suffix={form.max_steps === 0 ? t('admin.agents.unlimited') : undefined}
            onChange={(e) => {
              const v = parseInt(e.target.value)
              setForm({ ...form, max_steps: isNaN(v) ? 0 : v })
            }}
          />

          {/* Subagent-specific fields */}
          {showSubagentFields && (
            <div className="sm:col-span-2">
              <TextArea
                label={t('admin.agents.subagentPrompt')}
                value={form.subagent_prompt}
                onChange={(e) => setForm({ ...form, subagent_prompt: e.target.value })}
                rows={6}
                mono
              />
            </div>
          )}
        </div>

        {/* Capabilities */}
        <SettingsField label={t('admin.agents.capabilities')}>
          <div className="flex flex-wrap gap-1 min-w-0">
            {CAP_KEYS.map((k) => (
              <button key={k} type="button" onClick={() => toggleCap(k)} className={cn(
                'px-2 py-0.5 rounded text-[0.6875rem] transition-colors',
                form.capabilities.includes(k)
                  ? 'bg-secondary text-secondary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-interactive-hover'
              )}>{t(`admin.agents.cap.${k}`)}</button>
            ))}
          </div>
        </SettingsField>

        {/* Icons */}
        <SettingsField label={t('admin.agents.icon')}>
          <div className="flex flex-wrap items-center gap-2 mb-2 min-w-0">
            {isIconName(form.icon) && <Icon name={form.icon} className="size-5 shrink-0" />}
            <span className="text-xs text-muted-foreground min-w-0 break-all">{form.icon || t('admin.agents.notSelected')}</span>
            {form.icon && (
              <Button
                variant="ghost"
                onClick={() => setForm({ ...form, icon: '' })}
                className="text-muted-foreground hover:bg-status-error/10 hover:text-status-error"
              >
                {t('admin.agents.reset')}
              </Button>
            )}
          </div>
          <IconPicker value={form.icon || null} onChange={(icon) => setForm({ ...form, icon })} />
        </SettingsField>

        {/* Colors */}
        <SettingsField label={t('admin.agents.color')}>
          <ColorPicker value={form.color || null} onChange={(color) => setForm({ ...form, color })} />
        </SettingsField>

        <SettingsActions
          onSave={handleSave}
          onCancel={handleCancel}
          saving={saving}
          saveLabel={t('admin.agents.save')}
          cancelLabel={t('admin.agents.cancel')}
          saveTestId="agent-save"
          cancelTestId="agent-cancel"
        />
      </SettingsSection>
    </div>
  )

  return (
    <SettingsPanel
      title={t('admin.agents.title')}
      meta={filterMode === 'subagents'
        ? t('admin.agents.filter.subagents_count', { count: filteredAgents.length })
        : t('admin.agents.count', { count: filteredAgents.length })}
      actions={
        <Button onClick={handleCreate}>
          <Icon name="add" className="size-3.5" />{t('admin.agents.add')}
        </Button>
      }
    >
      {defaultAgentInfo && (
        <SettingsSection
          title={t('admin.agents.defaultAgent.title')}
          description={t('admin.agents.defaultAgent.description')}
        >
          <SelectField
            value={defaultAgentDraft.draft ?? ''}
            onValueChange={(value) => defaultAgentDraft.setDraft(value)}
            ariaLabel={t('admin.agents.defaultAgent.title')}
            items={primaryAgents.map((a) => ({ value: a.id, label: a.display_name }))}
          >
            <SelectContent>
              {primaryAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.display_name}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SettingsActions
            onSave={defaultAgentDraft.save}
            onCancel={defaultAgentDraft.revert}
            onReset={handleResetDefaultAgent}
            saving={defaultAgentDraft.saving}
            saveDisabled={!defaultAgentDraft.dirty}
            cancelDisabled={!defaultAgentDraft.dirty}
            isDefault={defaultAgentDraft.isDefault}
            saveTestId="default-agent-save"
            cancelTestId="default-agent-cancel"
            resetTestId="default-agent-reset"
          />
        </SettingsSection>
      )}

      {hasSubOrSystem && (
        <SettingsSection>
          <Tabs
            items={FILTER_MODES.map((m) => ({ value: m, label: t(`admin.agents.filter.${m}`) }))}
            value={filterMode}
            onChange={(v) => setFilterMode(v as FilterMode)}
            ariaLabel={t('admin.agents.title')}
          />
        </SettingsSection>
      )}

      {(creating || expanded) && renderForm()}

      {loading ? (
        <div className="agents-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-24" />
            </div>
          ))}
        </div>
      ) : (
        <div className="agents-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filteredAgents.map((a) => (
            <SettingsSection key={a.id} className={cn(!a.enabled && 'opacity-50')}>
              <div className="flex items-start justify-between gap-2 min-w-0">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <Icon name={isIconName(a.icon) ? a.icon : 'robot-2'} className="size-4 shrink-0 mt-0.5" style={a.color ? { color: `var(${a.color})` } : undefined} />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-sm break-words">{a.display_name}</span>
                    <code className="block text-[0.625rem] text-muted-foreground break-all">{a.id}</code>
                  </div>
                </div>
                <div className="ml-1 shrink-0">
                  <Toggle enabled={a.enabled} onToggle={() => handleToggle(a)} />
                </div>
              </div>

              {/* Badges row */}
              <div className="flex flex-wrap gap-1 min-w-0">
                {(!a.agent_mode || a.agent_mode.includes('primary')) && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-secondary-foreground">
                    {t('admin.agents.agentMode.primary')}
                  </span>
                )}
                {a.agent_mode?.includes('subagent') && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-status-success/10 text-status-success">
                    {t('admin.agents.agentMode.subagent')}
                  </span>
                )}
                {a.agent_mode?.includes('system') && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-status-info/10 text-status-info">
                    {t('admin.agents.system')}
                  </span>
                )}
                {a.provider && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-secondary text-secondary-foreground">{a.provider}</span>
                )}
                {a.model && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-secondary text-secondary-foreground">{a.model}</span>
                )}
                {a.context_file && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-status-warning/15 text-status-warning">{a.context_file}</span>
                )}
                {a.is_builtin && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-muted text-muted-foreground">{t('admin.agents.builtin')}</span>
                )}
                {a.is_builtin && a.is_overridden && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-status-warning/15 text-status-warning">{t('admin.agents.modified')}</span>
                )}
              </div>

              {/* Capabilities */}
              <div className="flex flex-wrap gap-1 min-w-0">
                {a.capabilities.slice(0, 6).map((c) => (
                  <span key={c} className="px-1.5 py-0.5 rounded text-[0.625rem] bg-secondary text-secondary-foreground">
                    {t(`admin.agents.cap.${c}`)}
                  </span>
                ))}
                {a.capabilities.length > 6 && (
                  <span className="text-[0.625rem] text-muted-foreground">+{a.capabilities.length - 6}</span>
                )}
                {a.capabilities.length === 0 && (
                  <span className="text-[0.625rem] text-muted-foreground">{t('admin.agents.noCapabilities')}</span>
                )}
              </div>

              {/* Agent steps info */}
              <div className="flex flex-wrap gap-1 min-w-0">
                {a.max_steps === 0 || a.max_steps == null ? (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-status-success/10 text-status-success">
                    {t('admin.agents.stepsCount')}: {t('admin.agents.unlimited')}
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-secondary text-secondary-foreground">
                    {t('admin.agents.stepsCount')}: ≤{a.max_steps}
                  </span>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-1 min-w-0">
                <Button variant="ghost" onClick={() => handleEdit(a)}>{t('common.edit')}</Button>
                <Button
                  variant="ghost"
                  onClick={() => handleDelete(a)}
                  className="text-muted-foreground hover:bg-status-error/10 hover:text-status-error"
                >
                  {a.is_builtin ? t('admin.agents.reset') : t('common.delete')}
                </Button>
              </div>
            </SettingsSection>
          ))}
        </div>
      )}

      {/* AD-076: реестр SSH-ключей per-agent (в разделе «Агенты») */}
      <SshKeysSettings />
    </SettingsPanel>
  )
}
