import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { loadRoutingDefaults, saveRoutingDefaults, type RoutingDefaults } from '@/lib/routingDefaults'
import { synthApi, type DictionaryEntry } from '@/lib/api/synthApi'
import { Toggle } from '../ui/Toggle'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsPage, SettingsCard, SegmentedControl } from './settings-layout'

const NUMBER_CLASS = 'w-20 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring'

type DictionaryLanguage = 'ru' | 'en'

const DICTIONARY_CATEGORY_ORDER = ['coding', 'research', 'small-talk', 'intents', 'enum', 'injection'] as const

const DICTIONARY_CATEGORY_LABELS: Record<string, string> = {
  coding: 'routing.dictionaries.category.coding',
  research: 'routing.dictionaries.category.research',
  'small-talk': 'routing.dictionaries.category.smallTalk',
  intents: 'routing.dictionaries.category.intents',
  enum: 'routing.dictionaries.category.enum',
  injection: 'routing.dictionaries.category.injection',
}

const dictionaryKey = (entry: DictionaryEntry) => `${entry.category}.${entry.language}`

const categoryRank = (category: string): number => {
  const index = (DICTIONARY_CATEGORY_ORDER as readonly string[]).indexOf(category)
  return index === -1 ? DICTIONARY_CATEGORY_ORDER.length : index
}

export function RoutingSettings() {
  const { t } = useI18n()
  const providers = useProvidersStore((s) => s.providers)
  const models = useProvidersStore((s) => s.models)

  const [settings, setSettings] = useState<RoutingDefaults>(loadRoutingDefaults)

  useEffect(() => {
    saveRoutingDefaults(settings)
  }, [settings])

  const update = (patch: Partial<RoutingDefaults>) => {
    setSettings((s) => ({ ...s, ...patch }))
  }

  const updateContent = (key: 'coding' | 'chat' | 'research', patch: Partial<{ provider: string; model: string }>) => {
    setSettings((s) => ({
      ...s,
      routingContent: { ...s.routingContent, [key]: { ...s.routingContent[key], ...patch } },
    }))
  }

  const updateEscalation = (patch: Partial<RoutingDefaults['routingEscalation']>) => {
    setSettings((s) => ({
      ...s,
      routingEscalation: { ...s.routingEscalation, ...patch },
    }))
  }

  const updateCost = (patch: Partial<RoutingDefaults['routingCost']>) => {
    setSettings((s) => ({
      ...s,
      routingCost: { ...s.routingCost, ...patch },
    }))
  }

  const updateSubagent = (patch: Partial<RoutingDefaults['subagentRouting']>) => {
    setSettings((s) => ({
      ...s,
      subagentRouting: { ...s.subagentRouting, ...patch },
    }))
  }

  const availableProviders = providers.filter((p) => p.enabled)
  const filteredModels = (provider: string) => models.filter((m) => m.enabled && (!provider || m.provider === provider))

  const strategyLabels: Record<RoutingDefaults['routingStrategy'], string> = {
    auto: t('routing.strategy.auto'),
    content: t('routing.strategy.content'),
    cost: t('routing.strategy.cost'),
    'content+cost': t('routing.strategy.contentCost'),
  }

  const subagentModel = settings.subagentRouting.provider
    ? `${settings.subagentRouting.provider}:${settings.subagentRouting.model}`
    : 'auto'

  return (
    <SettingsPage
      title={t('routing.title')}
      description="Запросы, которые не обработали Быстрые ответы, распределяются между моделями автоматически: стратегия выбирает модель по типу задачи (кодинг/чат/анализ), по стоимости или сочетанием. Дополнительно работает контроль качества: если ответ неуверенный или слишком короткий — запрос пересылается на fallback-модель. Если маршрутизация выключена — используется модель, выбранная в сессии."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Вкл/Выкл */}
        <SettingsCard>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle enabled={settings.routingEnabled} onToggle={() => update({ routingEnabled: !settings.routingEnabled })} />
            <span className="text-sm text-foreground">
              {settings.routingEnabled ? t('common.enabled') : t('common.disabled')}
            </span>
          </label>
        </SettingsCard>

        {/* Стратегия */}
        <SettingsCard title={t('routing.strategy')}>
          <Select
            value={settings.routingStrategy}
            onValueChange={(v) => update({ routingStrategy: v as RoutingDefaults['routingStrategy'] })}
          >
            <SelectTrigger className="w-full" aria-label={t('routing.strategy')}>
              <SelectValue>{strategyLabels[settings.routingStrategy]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('routing.strategy.auto')}</SelectItem>
              <SelectItem value="content">{t('routing.strategy.content')}</SelectItem>
              <SelectItem value="cost">{t('routing.strategy.cost')}</SelectItem>
              <SelectItem value="content+cost">{t('routing.strategy.contentCost')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsCard>

        {/* Контентная */}
        <SettingsCard className="sm:col-span-2" title={t('routing.content')}>
          <ModelPairRow
            label={t('routing.content.coding')}
            provider={settings.routingContent.coding.provider}
            model={settings.routingContent.coding.model}
            providers={availableProviders}
            models={filteredModels(settings.routingContent.coding.provider)}
            onProviderChange={(v) => updateContent('coding', { provider: v, model: '' })}
            onModelChange={(v) => updateContent('coding', { model: v })}
          />
          <ModelPairRow
            label={t('routing.content.chat')}
            provider={settings.routingContent.chat.provider}
            model={settings.routingContent.chat.model}
            providers={availableProviders}
            models={filteredModels(settings.routingContent.chat.provider)}
            onProviderChange={(v) => updateContent('chat', { provider: v, model: '' })}
            onModelChange={(v) => updateContent('chat', { model: v })}
          />
          <ModelPairRow
            label={t('routing.content.research')}
            provider={settings.routingContent.research.provider}
            model={settings.routingContent.research.model}
            providers={availableProviders}
            models={filteredModels(settings.routingContent.research.provider)}
            onProviderChange={(v) => updateContent('research', { provider: v, model: '' })}
            onModelChange={(v) => updateContent('research', { model: v })}
          />
        </SettingsCard>

        {/* Эскалация */}
        <SettingsCard className="sm:col-span-2" title={t('routing.escalation')}>
          <div className="flex items-center gap-3">
            <Toggle enabled={settings.routingEscalation.enabled} onToggle={() => updateEscalation({ enabled: !settings.routingEscalation.enabled })} />
            <span className="text-sm text-foreground">
              {settings.routingEscalation.enabled ? t('common.enabled') : t('common.disabled')}
            </span>
          </div>
          {settings.routingEscalation.enabled && (
            <>
              <ModelPairRow
                label={t('routing.escalation.fallback')}
                provider={settings.routingEscalation.fallbackProvider}
                model={settings.routingEscalation.fallbackModel}
                providers={availableProviders}
                models={filteredModels(settings.routingEscalation.fallbackProvider)}
                onProviderChange={(v) => updateEscalation({ fallbackProvider: v, fallbackModel: '' })}
                onModelChange={(v) => updateEscalation({ fallbackModel: v })}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">{t('routing.escalation.minLength')}</span>
                <input
                  type="number"
                  min={1}
                  value={settings.routingEscalation.minLength}
                  onChange={(e) => updateEscalation({ minLength: Number(e.target.value) || 1 })}
                  className={NUMBER_CLASS}
                />
              </div>
            </>
          )}
        </SettingsCard>

        {/* Стоимость */}
        <SettingsCard className="sm:col-span-2" title={t('routing.cost')}>
          <div className="flex items-center gap-3">
            <Toggle enabled={settings.routingCost.enabled} onToggle={() => updateCost({ enabled: !settings.routingCost.enabled })} />
            <span className="text-sm text-foreground">
              {settings.routingCost.enabled ? t('common.enabled') : t('common.disabled')}
            </span>
          </div>
          {settings.routingCost.enabled && (
            <>
              <ModelPairRow
                label={t('routing.cost.cheap')}
                provider={settings.routingCost.cheapProvider}
                model={settings.routingCost.cheapModel}
                providers={availableProviders}
                models={filteredModels(settings.routingCost.cheapProvider)}
                onProviderChange={(v) => updateCost({ cheapProvider: v, cheapModel: '' })}
                onModelChange={(v) => updateCost({ cheapModel: v })}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">{t('routing.cost.threshold')}</span>
                <input
                  type="number"
                  min={1}
                  value={settings.routingCost.maxCheapTokens}
                  onChange={(e) => updateCost({ maxCheapTokens: Number(e.target.value) || 1 })}
                  className={NUMBER_CLASS}
                />
              </div>
            </>
          )}
        </SettingsCard>

        {/* Саб-агенты */}
        <SettingsCard className="sm:col-span-2" title={t('routing.subagent')}>
          <div className="flex items-center gap-3">
            <Toggle enabled={settings.subagentRouting.enabled} onToggle={() => updateSubagent({ enabled: !settings.subagentRouting.enabled })} />
            <span className="text-sm text-foreground">
              {settings.subagentRouting.enabled ? t('common.enabled') : t('common.disabled')}
            </span>
          </div>
          {settings.subagentRouting.enabled && (
            <div className="flex flex-col gap-1">
              <label className="text-sm text-muted-foreground">{t('routing.subagent.model')}</label>
              <Select
                value={subagentModel}
                onValueChange={(value) => {
                  if (value === 'auto') {
                    updateSubagent({ provider: '', model: '' })
                  } else {
                    const [p, ...rest] = value.split(':')
                    updateSubagent({ provider: p!, model: rest.join(':') })
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label={t('routing.subagent.model')}>
                  <SelectValue>
                    {settings.subagentRouting.provider
                      ? `${settings.subagentRouting.provider}/${settings.subagentRouting.model}`
                      : t('routing.subagent.modelAuto')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('routing.subagent.modelAuto')}</SelectItem>
                  {models.filter((m) => m.enabled).map((m) => (
                    <SelectItem key={`${m.provider}:${m.name}`} value={`${m.provider}:${m.name}`}>
                      {m.provider}/{m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </SettingsCard>

        {/* Словари классификации */}
        <DictionarySection />
      </div>
    </SettingsPage>
  )
}

function DictionarySection() {
  const { t } = useI18n()
  const [language, setLanguage] = useState<DictionaryLanguage>('ru')
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<{ category: string; language: string; content: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = async () => {
    try {
      const res = await synthApi.getDictionaries()
      setEntries(res.dictionaries)
      setUnavailable(false)
      setLoadError(false)
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) setUnavailable(true)
      else setLoadError(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const flashStatus = (message: string) => {
    setStatus(message)
    setTimeout(() => setStatus(null), 1500)
  }

  const handleEdit = async (entry: DictionaryEntry) => {
    setStatus(null)
    setSaveError(null)
    try {
      const res = await synthApi.getDictionary(entry.category, entry.language)
      setEditing({ category: entry.category, language: entry.language, content: res.dictionary.content })
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) setUnavailable(true)
      else setSaveError(t('routing.dictionaries.loadError'))
    }
  }

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    setStatus(null)
    setSaveError(null)
    try {
      await synthApi.saveDictionary(editing.category, editing.language, { content: editing.content })
      setEditing(null)
      await load()
      flashStatus(t('common.saved'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      setSaveError(`${t('common.saveError')}${message ? `: ${message}` : ''}`)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async (entry: DictionaryEntry) => {
    const name = t(DICTIONARY_CATEGORY_LABELS[entry.category] ?? entry.category)
    if (!window.confirm(t('routing.dictionaries.confirmReset', { name }))) return
    setStatus(null)
    setSaveError(null)
    try {
      await synthApi.resetDictionary(entry.category, entry.language)
      setEditing((cur) =>
        cur && cur.category === entry.category && cur.language === entry.language ? null : cur,
      )
      await load()
      flashStatus(t('routing.dictionaries.restored'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      setSaveError(`${t('common.saveError')}${message ? `: ${message}` : ''}`)
    }
  }

  if (unavailable) {
    return (
      <SettingsCard className="sm:col-span-2" title={t('routing.dictionaries.title')}>
        <p className="text-sm text-muted-foreground">{t('routing.dictionaries.unavailable')}</p>
      </SettingsCard>
    )
  }

  const visible = (entries ?? [])
    .filter((e) => e.language === language)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))

  return (
    <SettingsCard className="sm:col-span-2" title={t('routing.dictionaries.title')}>
      <SegmentedControl<DictionaryLanguage>
        value={language}
        options={[
          { value: 'ru', label: t('common.language.russian') },
          { value: 'en', label: t('common.language.english') },
        ]}
        onChange={setLanguage}
        ariaLabel={t('routing.dictionaries.title')}
      />

      {loadError && <p className="text-sm text-destructive">{t('routing.dictionaries.loadError')}</p>}
      {!loadError && entries === null && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {!loadError &&
        visible.map((entry) => {
          const key = dictionaryKey(entry)
          const categoryKey = DICTIONARY_CATEGORY_LABELS[entry.category] ?? entry.category
          const isEditing = editing?.category === entry.category && editing?.language === entry.language
          return (
            <div key={key} className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{t(categoryKey)}</span>
                  <span
                    className={
                      entry.source === 'user'
                        ? 'rounded px-1.5 py-0.5 text-xs bg-status-warning/15 text-status-warning'
                        : 'rounded px-1.5 py-0.5 text-xs bg-secondary text-secondary-foreground'
                    }
                  >
                    {entry.source === 'user'
                      ? t('routing.dictionaries.modified')
                      : t('routing.dictionaries.source.system')}
                  </span>
                  <span className="text-xs text-muted-foreground">{entry.size} B</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleEdit(entry)}
                    className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-interactive-hover"
                  >
                    {t('routing.dictionaries.edit')}
                  </button>
                  {entry.source === 'user' && (
                    <button
                      type="button"
                      onClick={() => void handleReset(entry)}
                      className="rounded px-2 py-1 text-xs text-status-warning transition-colors hover:bg-status-warning/10"
                    >
                      {t('routing.dictionaries.reset')}
                    </button>
                  )}
                </div>
              </div>

              {isEditing && editing && (
                <div className="space-y-3 rounded-lg border border-border bg-background p-3">
                  <h4 className="text-sm font-medium">
                    {t('routing.dictionaries.editing', { name: t(categoryKey) })}
                  </h4>
                  <textarea
                    value={editing.content}
                    onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                    rows={10}
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleSave()}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-interactive-hover"
                    >
                      {t('routing.dictionaries.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

      {status && <p className="text-xs text-muted-foreground">{status}</p>}
      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      <p className="text-[0.625rem] text-muted-foreground/60 italic">{t('routing.dictionaries.hint')}</p>
    </SettingsCard>
  )
}

function ModelPairRow({
  label,
  provider,
  model,
  providers,
  models,
  onProviderChange,
  onModelChange,
}: {
  label: string
  provider: string
  model: string
  providers: { name: string }[]
  models: { name: string }[]
  onProviderChange: (v: string) => void
  onModelChange: (v: string) => void
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <Select
          value={provider}
          onValueChange={(value) => {
            onProviderChange(value)
            onModelChange('')
          }}
        >
          <SelectTrigger className="w-full min-w-0 flex-1" aria-label={t('common.provider')}>
            <SelectValue>{provider || t('common.provider')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('common.provider')}</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={model} onValueChange={onModelChange}>
          <SelectTrigger className="w-full min-w-0 flex-1" aria-label={t('common.model')} disabled={!provider}>
            <SelectValue>{model || t('common.model')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('common.model')}</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
