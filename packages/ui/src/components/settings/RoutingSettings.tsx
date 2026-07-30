import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { Toggle } from '../ui/Toggle'

const STORAGE_KEY = 'synth-routing-defaults'

interface RoutingDefaults {
  routingEnabled: boolean
  routingStrategy: 'auto' | 'content' | 'cost' | 'content+cost'
  routingContent: {
    coding: { provider: string; model: string }
    chat: { provider: string; model: string }
    research: { provider: string; model: string }
  }
  routingEscalation: {
    enabled: boolean
    fallbackProvider: string
    fallbackModel: string
    minLength: number
  }
  routingCost: {
    enabled: boolean
    cheapProvider: string
    cheapModel: string
    maxCheapTokens: number
  }
  subagentRouting: {
    enabled: boolean
    model: string
    provider: string
  }
}

const DEFAULTS: RoutingDefaults = {
  routingEnabled: false,
  routingStrategy: 'auto',
  routingContent: {
    coding: { provider: '', model: '' },
    chat: { provider: '', model: '' },
    research: { provider: '', model: '' },
  },
  routingEscalation: {
    enabled: false,
    fallbackProvider: '',
    fallbackModel: '',
    minLength: 10,
  },
  routingCost: {
    enabled: false,
    cheapProvider: '',
    cheapModel: '',
    maxCheapTokens: 500,
  },
  subagentRouting: {
    enabled: false,
    model: '',
    provider: '',
  },
}

function loadDefaults(): RoutingDefaults {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...DEFAULTS, ...JSON.parse(stored) }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS }
}

function saveDefaults(defaults: RoutingDefaults) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults))
  } catch {
    // ignore
  }
}

export function RoutingSettings() {
  const { t } = useI18n()
  const providers = useProvidersStore((s) => s.providers)
  const models = useProvidersStore((s) => s.models)

  const [settings, setSettings] = useState<RoutingDefaults>(loadDefaults)

  useEffect(() => {
    saveDefaults(settings)
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

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold mb-1">{t('routing.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('routing.globalDescription')}</p>
      </div>

      <div className="space-y-4">
        {/* Вкл/Выкл */}
        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle enabled={settings.routingEnabled} onToggle={() => update({ routingEnabled: !settings.routingEnabled })} />
          <span className="text-sm text-foreground">
            {settings.routingEnabled ? t('common.enabled') : t('common.disabled')}
          </span>
        </label>

        {/* Стратегия */}
        <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">{t('routing.strategy')}</label>
              <select
                value={settings.routingStrategy}
                onChange={(e) => update({ routingStrategy: e.target.value as RoutingDefaults['routingStrategy'] })}
                className="w-full rounded-md bg-input border border-border px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="auto">{t('routing.strategy.auto')}</option>
                <option value="content">{t('routing.strategy.content')}</option>
                <option value="cost">{t('routing.strategy.cost')}</option>
                <option value="content+cost">{t('routing.strategy.contentCost')}</option>
              </select>
            </div>

            {/* Контентная */}
            <div className="space-y-3 pl-4 border-l-2 border-border/30">
              <span className="text-sm font-medium">📝 {t('routing.content')}</span>
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
            </div>

            {/* Эскалация */}
            <div className="space-y-3 pl-4 border-l-2 border-border/30">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">⚠️ {t('routing.escalation')}</span>
                <Toggle enabled={settings.routingEscalation.enabled} onToggle={() => updateEscalation({ enabled: !settings.routingEscalation.enabled })} />
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
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('routing.escalation.minLength')}</span>
                    <input
                      type="number"
                      min={1}
                      value={settings.routingEscalation.minLength}
                      onChange={(e) => updateEscalation({ minLength: Number(e.target.value) || 1 })}
                      className="w-20 rounded-md bg-input border border-border px-2 py-1 text-sm text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Стоимость */}
            <div className="space-y-3 pl-4 border-l-2 border-border/30">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">💰 {t('routing.cost')}</span>
                <Toggle enabled={settings.routingCost.enabled} onToggle={() => updateCost({ enabled: !settings.routingCost.enabled })} />
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
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('routing.cost.threshold')}</span>
                    <input
                      type="number"
                      min={1}
                      value={settings.routingCost.maxCheapTokens}
                      onChange={(e) => updateCost({ maxCheapTokens: Number(e.target.value) || 1 })}
                      className="w-20 rounded-md bg-input border border-border px-2 py-1 text-sm text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Саб-агенты */}
            <div className="space-y-3 pl-4 border-l-2 border-border/30">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">🤖 {t('routing.subagent')}</span>
                <Toggle enabled={settings.subagentRouting.enabled} onToggle={() => updateSubagent({ enabled: !settings.subagentRouting.enabled })} />
              </div>
              {settings.subagentRouting.enabled && (
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-muted-foreground">{t('routing.subagent.model')}</label>
                  <select
                    value={settings.subagentRouting.provider ? `${settings.subagentRouting.provider}:${settings.subagentRouting.model}` : 'auto'}
                    onChange={(e) => {
                      if (e.target.value === 'auto') {
                        updateSubagent({ provider: '', model: '' })
                      } else {
                        const [p, ...rest] = e.target.value.split(':')
                        updateSubagent({ provider: p!, model: rest.join(':') })
                      }
                    }}
                    className="w-full rounded-md bg-input border border-border px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="auto">{t('routing.subagent.modelAuto')}</option>
                    {models.filter((m) => m.enabled).map((m) => (
                      <option key={`${m.provider}:${m.name}`} value={`${m.provider}:${m.name}`}>
                        {m.provider}/{m.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
      </div>
    </div>
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
  return (
    <div className="space-y-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <select
          value={provider}
          onChange={(e) => {
            onProviderChange(e.target.value)
            onModelChange('')
          }}
          className="flex-1 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">Провайдер</option>
          {providers.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          className="flex-1 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={!provider}
        >
          <option value="">Модель</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
