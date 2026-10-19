import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import {
  DEFAULT_ROUTING_DEFAULTS,
  loadRoutingDefaults,
  saveRoutingDefaults,
  type RoutingDefaults,
} from '@/lib/routingDefaults'
import { confirm } from '@/lib/confirm'
import { useTransientMessage } from '@/hooks/useTransientMessage'
import { synthApi, type DictionaryEntry } from '@/lib/api/synthApi'
import { Button } from '../ui/button'
import { SelectContent, SelectItem } from '@/components/ui/select'
import {
  ModelPairSelect,
  NumberField,
  SegmentedControl,
  SelectField,
  SettingsActions,
  SettingsItem,
  SettingsPanel,
  SettingsSection,
  TextArea,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

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

  const [initialSettings] = useState(loadRoutingDefaults)
  const draft = useSettingsDraft<RoutingDefaults>({
    value: initialSettings,
    defaultValue: DEFAULT_ROUTING_DEFAULTS,
    onSave: async (next) => {
      saveRoutingDefaults(next)
    },
  })

  const settings = draft.draft ?? DEFAULT_ROUTING_DEFAULTS

  const update = (patch: Partial<RoutingDefaults>) => {
    draft.setDraft((s) => ({ ...s, ...patch }))
  }

  const updateContent = (key: 'coding' | 'chat' | 'research', patch: Partial<{ provider: string; model: string }>) => {
    draft.setDraft((s) => ({
      ...s,
      routingContent: { ...s.routingContent, [key]: { ...s.routingContent[key], ...patch } },
    }))
  }

  const updateEscalation = (patch: Partial<RoutingDefaults['routingEscalation']>) => {
    draft.setDraft((s) => ({
      ...s,
      routingEscalation: { ...s.routingEscalation, ...patch },
    }))
  }

  const updateCost = (patch: Partial<RoutingDefaults['routingCost']>) => {
    draft.setDraft((s) => ({
      ...s,
      routingCost: { ...s.routingCost, ...patch },
    }))
  }

  const updateSubagent = (patch: Partial<RoutingDefaults['subagentRouting']>) => {
    draft.setDraft((s) => ({
      ...s,
      subagentRouting: { ...s.subagentRouting, ...patch },
    }))
  }

  const availableProviders = providers.filter((p) => p.enabled)
  const filteredModels = (provider: string) => models.filter((m) => m.enabled && (!provider || m.provider === provider))

  const stateLabel = (enabled: boolean) => (enabled ? t('common.enabled') : t('common.disabled'))

  const subagentModel = settings.subagentRouting.provider
    ? `${settings.subagentRouting.provider}:${settings.subagentRouting.model}`
    : 'auto'

  return (
    <SettingsPanel
      title={t('routing.title')}
      description="Запросы, которые не обработали Быстрые ответы, распределяются между моделями автоматически: стратегия выбирает модель по типу задачи (кодинг/чат/анализ), по стоимости или сочетанием. Дополнительно работает контроль качества: если ответ неуверенный или слишком короткий — запрос пересылается на fallback-модель. Если маршрутизация выключена — используется модель, выбранная в сессии."
    >
      {/* Вкл/Выкл */}
      <SettingsSection
        id="routing-main"
        tooltip={t('settings.help.routing.section.routing-main')}
      >
        <SettingsItem>
          <ToggleField
            label={t('settings.category.routing')}
            tooltip={t('settings.help.routing.enabled')}
            description={stateLabel(settings.routingEnabled)}
            enabled={settings.routingEnabled}
            onToggle={() => update({ routingEnabled: !settings.routingEnabled })}
          />
        </SettingsItem>
      </SettingsSection>

      {/* Стратегия */}
      <SettingsSection
        id="routing-strategy"
        title={t('routing.strategy')}
        tooltip={t('settings.help.routing.section.routing-strategy')}
      >
        <SettingsItem>
          <SelectField
            label={t('routing.strategy')}
            tooltip={t('settings.help.routing.strategy')}
            value={settings.routingStrategy}
            onValueChange={(v) => update({ routingStrategy: v as RoutingDefaults['routingStrategy'] })}
            ariaLabel={t('routing.strategy')}
          >
            <SelectContent>
              <SelectItem value="auto">{t('routing.strategy.auto')}</SelectItem>
              <SelectItem value="content">{t('routing.strategy.content')}</SelectItem>
              <SelectItem value="cost">{t('routing.strategy.cost')}</SelectItem>
              <SelectItem value="content+cost">{t('routing.strategy.contentCost')}</SelectItem>
            </SelectContent>
          </SelectField>
        </SettingsItem>
      </SettingsSection>

      {/* Контентная */}
      <SettingsSection
        id="routing-content"
        title={t('routing.content')}
        tooltip={t('settings.help.routing.section.routing-content')}
      >
        <SettingsItem>
          <ModelPairSelect
            label={t('routing.content.coding')}
            provider={settings.routingContent.coding.provider}
            model={settings.routingContent.coding.model}
            providers={availableProviders}
            models={filteredModels(settings.routingContent.coding.provider)}
            providerLabel={t('common.provider')}
            modelLabel={t('common.model')}
            onProviderChange={(v) => updateContent('coding', { provider: v, model: '' })}
            onModelChange={(v) => updateContent('coding', { model: v })}
            providerTooltip={t('settings.help.routing.contentCodingProvider')}
            modelTooltip={t('settings.help.routing.contentCodingModel')}
          />
        </SettingsItem>
        <SettingsItem>
          <ModelPairSelect
            label={t('routing.content.chat')}
            provider={settings.routingContent.chat.provider}
            model={settings.routingContent.chat.model}
            providers={availableProviders}
            models={filteredModels(settings.routingContent.chat.provider)}
            providerLabel={t('common.provider')}
            modelLabel={t('common.model')}
            onProviderChange={(v) => updateContent('chat', { provider: v, model: '' })}
            onModelChange={(v) => updateContent('chat', { model: v })}
            providerTooltip={t('settings.help.routing.contentChatProvider')}
            modelTooltip={t('settings.help.routing.contentChatModel')}
          />
        </SettingsItem>
        <SettingsItem>
          <ModelPairSelect
            label={t('routing.content.research')}
            provider={settings.routingContent.research.provider}
            model={settings.routingContent.research.model}
            providers={availableProviders}
            models={filteredModels(settings.routingContent.research.provider)}
            providerLabel={t('common.provider')}
            modelLabel={t('common.model')}
            onProviderChange={(v) => updateContent('research', { provider: v, model: '' })}
            onModelChange={(v) => updateContent('research', { model: v })}
            providerTooltip={t('settings.help.routing.contentResearchProvider')}
            modelTooltip={t('settings.help.routing.contentResearchModel')}
          />
        </SettingsItem>
      </SettingsSection>

      {/* Эскалация */}
      <SettingsSection
        id="routing-escalation"
        tooltip={t('settings.help.routing.section.routing-escalation')}
        advanced
      >
        <SettingsItem>
          <ToggleField
            label={t('routing.escalation')}
            tooltip={t('settings.help.routing.escalation')}
            description={stateLabel(settings.routingEscalation.enabled)}
            enabled={settings.routingEscalation.enabled}
            onToggle={() => updateEscalation({ enabled: !settings.routingEscalation.enabled })}
          />
        </SettingsItem>
        {settings.routingEscalation.enabled && (
          <SettingsItem className="space-y-3">
            <ModelPairSelect
              label={t('routing.escalation.fallback')}
              provider={settings.routingEscalation.fallbackProvider}
              model={settings.routingEscalation.fallbackModel}
              providers={availableProviders}
              models={filteredModels(settings.routingEscalation.fallbackProvider)}
              providerLabel={t('common.provider')}
              modelLabel={t('common.model')}
              onProviderChange={(v) => updateEscalation({ fallbackProvider: v, fallbackModel: '' })}
              onModelChange={(v) => updateEscalation({ fallbackModel: v })}
              providerTooltip={t('settings.help.routing.escalationProvider')}
              modelTooltip={t('settings.help.routing.escalationModel')}
            />
            <NumberField
              label={t('routing.escalation.minLength')}
              tooltip={t('settings.help.routing.escalationMinLength')}
              min={1}
              value={settings.routingEscalation.minLength}
              onChange={(e) => updateEscalation({ minLength: Number(e.target.value) || 1 })}
            />
          </SettingsItem>
        )}
      </SettingsSection>

      {/* Стоимость */}
      <SettingsSection
        id="routing-cost"
        tooltip={t('settings.help.routing.section.routing-cost')}
        advanced
      >
        <SettingsItem>
          <ToggleField
            label={t('routing.cost')}
            tooltip={t('settings.help.routing.cost')}
            description={stateLabel(settings.routingCost.enabled)}
            enabled={settings.routingCost.enabled}
            onToggle={() => updateCost({ enabled: !settings.routingCost.enabled })}
          />
        </SettingsItem>
        {settings.routingCost.enabled && (
          <SettingsItem className="space-y-3">
            <ModelPairSelect
              label={t('routing.cost.cheap')}
              provider={settings.routingCost.cheapProvider}
              model={settings.routingCost.cheapModel}
              providers={availableProviders}
              models={filteredModels(settings.routingCost.cheapProvider)}
              providerLabel={t('common.provider')}
              modelLabel={t('common.model')}
              onProviderChange={(v) => updateCost({ cheapProvider: v, cheapModel: '' })}
              onModelChange={(v) => updateCost({ cheapModel: v })}
              providerTooltip={t('settings.help.routing.costProvider')}
              modelTooltip={t('settings.help.routing.costModel')}
            />
            <NumberField
              label={t('routing.cost.threshold')}
              tooltip={t('settings.help.routing.costThreshold')}
              min={1}
              value={settings.routingCost.maxCheapTokens}
              onChange={(e) => updateCost({ maxCheapTokens: Number(e.target.value) || 1 })}
            />
          </SettingsItem>
        )}
      </SettingsSection>

      {/* Саб-агенты */}
      <SettingsSection
        id="routing-subagent"
        tooltip={t('settings.help.routing.section.routing-subagent')}
        advanced
      >
        <SettingsItem>
          <ToggleField
            label={t('routing.subagent')}
            tooltip={t('settings.help.routing.subagent')}
            description={stateLabel(settings.subagentRouting.enabled)}
            enabled={settings.subagentRouting.enabled}
            onToggle={() => updateSubagent({ enabled: !settings.subagentRouting.enabled })}
          />
        </SettingsItem>
        {settings.subagentRouting.enabled && (
          <SettingsItem>
            <SelectField
              label={t('routing.subagent.model')}
              tooltip={t('settings.help.routing.subagentModel')}
              value={subagentModel}
              onValueChange={(value) => {
                if (value === 'auto') {
                  updateSubagent({ provider: '', model: '' })
                } else {
                  const [p, ...rest] = value.split(':')
                  updateSubagent({ provider: p!, model: rest.join(':') })
                }
              }}
              ariaLabel={t('routing.subagent.model')}
            >
              <SelectContent>
                <SelectItem value="auto">{t('routing.subagent.modelAuto')}</SelectItem>
                {models.filter((m) => m.enabled).map((m) => (
                  <SelectItem key={`${m.provider}:${m.name}`} value={`${m.provider}:${m.name}`}>
                    {m.provider}/{m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>
          </SettingsItem>
        )}
      </SettingsSection>

      {/* Словари классификации */}
      <DictionarySection />

      {draft.dirty && (
        <div className="p-2 rounded-lg bg-interactive-hover text-muted-foreground text-xs">
          {t('settings.kit.unsavedChanges')}
        </div>
      )}

      <SettingsActions
        onSave={() => void draft.save()}
        onCancel={draft.revert}
        onReset={draft.resetToDefault}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        isDefault={draft.isDefault}
        saveTestId="routing-save"
        cancelTestId="routing-cancel"
        resetTestId="routing-reset"
      />
    </SettingsPanel>
  )
}

function DictionarySection() {
  const { t } = useI18n()
  const [language, setLanguage] = useState<DictionaryLanguage>('ru')
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<{ category: string; language: string; content: string } | null>(null)
  const [status, flashStatus] = useTransientMessage()
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

  const handleEdit = async (entry: DictionaryEntry) => {
    flashStatus(null)
    setSaveError(null)
    try {
      const res = await synthApi.getDictionary(entry.category, entry.language)
      setEditing({ category: entry.category, language: entry.language, content: res.dictionary.content })
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) setUnavailable(true)
      else setSaveError(t('routing.dictionaries.loadError'))
    }
  }

  const handleReset = async (entry: DictionaryEntry) => {
    const name = t(DICTIONARY_CATEGORY_LABELS[entry.category] ?? entry.category)
    if (!(await confirm({ title: t('routing.dictionaries.confirmReset', { name }) }))) return
    flashStatus(null)
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
      <SettingsSection
        id="routing-dictionaries"
        title={t('routing.dictionaries.title')}
        tooltip={t('settings.help.routing.section.routing-dictionaries')}
        advanced
      >
        <p className="text-sm text-muted-foreground min-w-0 break-words">{t('routing.dictionaries.unavailable')}</p>
      </SettingsSection>
    )
  }

  const visible = (entries ?? [])
    .filter((e) => e.language === language)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))

  return (
    <SettingsSection
      id="routing-dictionaries"
      title={t('routing.dictionaries.title')}
      tooltip={t('settings.help.routing.section.routing-dictionaries')}
      advanced
    >
      <SettingsItem>
        <SegmentedControl<DictionaryLanguage>
          value={language}
          options={[
            { value: 'ru', label: t('common.language.russian') },
            { value: 'en', label: t('common.language.english') },
          ]}
          onChange={setLanguage}
          ariaLabel={t('routing.dictionaries.title')}
        />
      </SettingsItem>

      {loadError && <p className="text-sm text-destructive min-w-0 break-words">{t('routing.dictionaries.loadError')}</p>}
      {!loadError && entries === null && <p className="text-sm text-muted-foreground min-w-0">{t('common.loading')}</p>}

      {!loadError &&
        visible.map((entry) => {
          const key = dictionaryKey(entry)
          const categoryKey = DICTIONARY_CATEGORY_LABELS[entry.category] ?? entry.category
          const isEditing = editing?.category === entry.category && editing?.language === entry.language
          return (
            <div key={key} className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground min-w-0 break-words">{t(categoryKey)}</span>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleEdit(entry)}
                  >
                    {t('routing.dictionaries.edit')}
                  </Button>
                  {entry.source === 'user' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => void handleReset(entry)}
                    >
                      {t('routing.dictionaries.reset')}
                    </Button>
                  )}
                </div>
              </div>

              {isEditing && editing && (
                <DictionaryEditor
                  key={key}
                  entry={editing}
                  name={t(categoryKey)}
                  onSaved={() => {
                    void (async () => {
                      setEditing(null)
                      await load()
                      flashStatus(t('common.saved'))
                    })()
                  }}
                  onCancel={() => setEditing(null)}
                  onError={(message) => setSaveError(message)}
                />
              )}
            </div>
          )
        })}

      {status && <p className="text-xs text-muted-foreground min-w-0">{status}</p>}
      {saveError && <p className="text-xs text-destructive min-w-0 break-words">{saveError}</p>}

      <p className="text-[0.625rem] text-muted-foreground/60 italic min-w-0 break-words">{t('routing.dictionaries.hint')}</p>
    </SettingsSection>
  )
}

function DictionaryEditor({
  entry,
  name,
  onSaved,
  onCancel,
  onError,
}: {
  entry: { category: string; language: string; content: string }
  name: string
  onSaved: () => void
  onCancel: () => void
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const draft = useSettingsDraft<string>({
    value: entry.content,
    onSave: async (content) => {
      try {
        await synthApi.saveDictionary(entry.category, entry.language, { content })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : ''
        onError(`${t('common.saveError')}${message ? `: ${message}` : ''}`)
        throw err
      }
    },
  })

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3 min-w-0">
      <h4 className="text-sm font-medium min-w-0 break-words">
        {t('routing.dictionaries.editing', { name })}
      </h4>
      <TextArea
        value={draft.draft ?? ''}
        onChange={(e) => draft.setDraft(e.target.value)}
        rows={10}
        mono
        aria-label={t('routing.dictionaries.editing', { name })}
      />
      <SettingsActions
        align="start"
        onSave={() => {
          void draft.save().then((ok) => {
            if (ok) onSaved()
          })
        }}
        onCancel={onCancel}
        cancelLabel={t('routing.dictionaries.cancel')}
        saving={draft.saving}
        saveTestId={`routing-dictionary-save-${entry.category}`}
        cancelTestId={`routing-dictionary-cancel-${entry.category}`}
      />
    </div>
  )
}


