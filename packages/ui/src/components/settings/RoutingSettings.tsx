import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { loadRoutingDefaults, saveRoutingDefaults, type RoutingDefaults } from '@/lib/routingDefaults'
import { Toggle } from '../ui/Toggle'
import { Icon } from '../icon/Icon'

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

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold mb-1">{t('routing.title')}</h2>
        <p className="text-sm text-muted-foreground">
          Запросы, которые не обработали Быстрые ответы, распределяются между моделями автоматически: стратегия выбирает модель по типу задачи (кодинг/чат/анализ), по стоимости или сочетанием. Дополнительно работает контроль качества: если ответ неуверенный или слишком короткий — запрос пересылается на fallback-модель. Если маршрутизация выключена — используется модель, выбранная в сессии.
        </p>
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
              <span className="text-sm font-medium"><Icon name="code-s-slash" className="size-4 inline-block -mt-0.5 mr-1.5 text-muted-foreground" />{t('routing.content')}</span>
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
                <span className="text-sm font-medium"><Icon name="shield-check" className="size-4 inline-block -mt-0.5 mr-1.5 text-muted-foreground" />{t('routing.escalation')}</span>
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
                      className="w-20 rounded-md bg-input border border-border px-2 py-1 text-sm text-foreground text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Стоимость */}
            <div className="space-y-3 pl-4 border-l-2 border-border/30">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium"><Icon name="database-2" className="size-4 inline-block -mt-0.5 mr-1.5 text-muted-foreground" />{t('routing.cost')}</span>
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
                      className="w-20 rounded-md bg-input border border-border px-2 py-1 text-sm text-foreground text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Саб-агенты */}
            <div className="space-y-3 pl-4 border-l-2 border-border/30">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium"><Icon name="robot-2" className="size-4 inline-block -mt-0.5 mr-1.5 text-muted-foreground" />{t('routing.subagent')}</span>
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

            {/* Словари классификации */}
            <DictionarySection language="ru" />
      </div>
    </div>
  )
}

// Дефолтные ключевые слова (зеркало YAML-файлов dictionaries/)
const DEFAULT_CODING_KEYWORDS_RU = [
  'напиши', 'исправь', 'рефакторинг', 'функцию', 'компонент',
  'баг', 'ошибка', 'тест', 'код', 'реализуй', 'добавь', 'почини',
  'создай', 'удали', 'измени', 'перепиши', 'оптимизируй', 'отрефактори',
];
const DEFAULT_RESEARCH_KEYWORDS_RU = [
  'исследуй', 'проанализируй', 'архитектур', 'почему', 'объясни',
  'как работает', 'найди', 'покажи', 'расскажи', 'опиши', 'изучи',
  'сравни', 'оцени', 'разбери', 'проверь',
];
const DEFAULT_CODING_TOOLS = [
  'write_file', 'edit_file', 'create_file', 'delete_file',
  'write', 'edit', 'patch', 'replace', 'execute_shell', 'git_commit',
];

function DictionarySection({ language }: { language: string }) {
  const codingKeywords = language === 'ru' ? DEFAULT_CODING_KEYWORDS_RU : DEFAULT_CODING_KEYWORDS_RU;
  const researchKeywords = language === 'ru' ? DEFAULT_RESEARCH_KEYWORDS_RU : DEFAULT_RESEARCH_KEYWORDS_RU;

  return (
    <div className="space-y-3 pl-4 border-l-2 border-border/30">
      <details className="space-y-2">
        <summary className="text-sm font-medium cursor-pointer flex items-center gap-1.5"><Icon name="book-open" className="size-4 text-muted-foreground" /> Словари классификации</summary>
        <div className="pt-2 space-y-3">
          <div>
            <span className="text-xs text-muted-foreground">coding — ключевые слова ({codingKeywords.length}):</span>
            <p className="text-[10px] text-foreground/60 mt-0.5 leading-relaxed">
              {codingKeywords.join(', ')}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">research — ключевые слова ({researchKeywords.length}):</span>
            <p className="text-[10px] text-foreground/60 mt-0.5 leading-relaxed">
              {researchKeywords.join(', ')}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">coding — инструменты ({DEFAULT_CODING_TOOLS.length}):</span>
            <p className="text-[10px] text-foreground/60 mt-0.5 leading-relaxed">
              {DEFAULT_CODING_TOOLS.join(', ')}
            </p>
          </div>
          <p className="text-[10px] text-muted-foreground/60 italic">
            Словари загружаются из YAML-файлов в packages/core/dictionaries/. Переопределить можно через {`{$SYNTH_DATA_DIR}/dictionaries/`}.
          </p>
        </div>
      </details>
    </div>
  );
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
          aria-label="Провайдер"
          onChange={(e) => {
            onProviderChange(e.target.value)
            onModelChange('')
          }}
          className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">Провайдер</option>
          {providers.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <select
          value={model}
          aria-label="Модель"
          onChange={(e) => onModelChange(e.target.value)}
          className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
