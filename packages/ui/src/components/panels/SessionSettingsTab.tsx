import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '../ui/Toggle'
import { ModelSelector } from '../chat/ModelSelector'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'

export function SessionSettingsTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { sessions } = useSessionsStore()
  const {
    selectedProviderName,
    selectedModelName,
    setSelectedProvider,
    setSelectedModel,
    loadProviders,
    loadModels,
  } = useProvidersStore()

  const providers = useProvidersStore((s) => s.providers)
  const models = useProvidersStore((s) => s.models)

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const debugSystemMessages = useUIStore((s) => s.debugSystemMessages)
  const setDebugSystemMessages = useUIStore((s) => s.setDebugSystemMessages)
  const [sendingDebug, setSendingDebug] = useState(false)

  const [mcpServers, setMcpServers] = useState<Array<{ name: string; active: boolean }>>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([])

  // Роутинг (AD-034)
  const [routingEnabled, setRoutingEnabled] = useState(false)
  const [routingStrategy, setRoutingStrategy] = useState<'auto' | 'content' | 'cost' | 'content+cost'>('auto')
  // Контентная
  const [routingContentCodingProvider, setRoutingContentCodingProvider] = useState('')
  const [routingContentCodingModel, setRoutingContentCodingModel] = useState('')
  const [routingContentChatProvider, setRoutingContentChatProvider] = useState('')
  const [routingContentChatModel, setRoutingContentChatModel] = useState('')
  const [routingContentResearchProvider, setRoutingContentResearchProvider] = useState('')
  const [routingContentResearchModel, setRoutingContentResearchModel] = useState('')
  // Эскалация
  const [routingEscalationEnabled, setRoutingEscalationEnabled] = useState(false)
  const [routingEscalationFallbackProvider, setRoutingEscalationFallbackProvider] = useState('')
  const [routingEscalationFallbackModel, setRoutingEscalationFallbackModel] = useState('')
  const [routingEscalationMinLength, setRoutingEscalationMinLength] = useState(10)
  // Стоимость
  const [routingCostEnabled, setRoutingCostEnabled] = useState(false)
  const [routingCostCheapProvider, setRoutingCostCheapProvider] = useState('')
  const [routingCostCheapModel, setRoutingCostCheapModel] = useState('')
  const [routingCostMaxTokens, setRoutingCostMaxTokens] = useState(500)
  // Саб-агенты
  const [routingSubagentEnabled, setRoutingSubagentEnabled] = useState(false)
  const [routingSubagentModel, setRoutingSubagentModel] = useState('')
  const [routingSubagentProvider, setRoutingSubagentProvider] = useState('')

  // Быстрые ответы
  const [microFirst, setMicroFirst] = useState(false)
  const [microConfidenceThreshold, setMicroConfidenceThreshold] = useState(0.8)
  // Embedding
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false)
  const [embedProvider, setEmbedProvider] = useState('')
  const [embedModel, setEmbedModel] = useState('')

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId

  const session = sessions.find((s) => s.id === sessionId)

  useEffect(() => {
    loadProviders()
    loadModels()
  }, [])

  useEffect(() => {
    if (sessionId) {
      synthApi.getAgents(sessionId).then((r) => setAgents(r.agents)).catch(() => {})
      synthApi.getSessionMcp(sessionId).then((r) => {
        setMcpServers(r.allServers)
        setSelectedMcpServers(r.mcpServers || [])
      }).catch(() => {})
    }
  }, [sessionId])

  useEffect(() => {
    if (session && session.settings) {
      const sp = session.settings.provider as string | undefined
      const sm = session.settings.model as string | undefined
      const de = session.settings.debugEnabled as boolean | undefined
      if (sp) setSelectedProvider(sp)
      if (sm) setSelectedModel(sm)
      if (de !== undefined) setDebugEnabled(de)

      // Routing settings
      const re = session.settings.routingEnabled as boolean | undefined
      const rs = session.settings.routingStrategy as 'auto' | 'content' | 'cost' | 'content+cost' | undefined
      const rc = session.settings.routingContent as Record<string, { provider: string; model: string }> | undefined
      const resc = session.settings.routingEscalation as Record<string, unknown> | undefined
      const rcost = session.settings.routingCost as Record<string, unknown> | undefined
      const sar = session.settings.subagentRouting as Record<string, unknown> | undefined

      if (re !== undefined) setRoutingEnabled(re)
      if (rs) setRoutingStrategy(rs)
      if (rc?.coding?.provider) setRoutingContentCodingProvider(rc.coding.provider)
      if (rc?.coding?.model) setRoutingContentCodingModel(rc.coding.model)
      if (rc?.chat?.provider) setRoutingContentChatProvider(rc.chat.provider)
      if (rc?.chat?.model) setRoutingContentChatModel(rc.chat.model)
      if (rc?.research?.provider) setRoutingContentResearchProvider(rc.research.provider)
      if (rc?.research?.model) setRoutingContentResearchModel(rc.research.model)
      if (resc) {
        if (resc.enabled !== undefined) setRoutingEscalationEnabled(resc.enabled as boolean)
        if (resc.fallbackProvider) setRoutingEscalationFallbackProvider(resc.fallbackProvider as string)
        if (resc.fallbackModel) setRoutingEscalationFallbackModel(resc.fallbackModel as string)
        if (resc.minLength !== undefined) setRoutingEscalationMinLength(resc.minLength as number)
      }
      if (rcost) {
        if (rcost.enabled !== undefined) setRoutingCostEnabled(rcost.enabled as boolean)
        if (rcost.cheapProvider) setRoutingCostCheapProvider(rcost.cheapProvider as string)
        if (rcost.cheapModel) setRoutingCostCheapModel(rcost.cheapModel as string)
        if (rcost.maxCheapTokens !== undefined) setRoutingCostMaxTokens(rcost.maxCheapTokens as number)
      }
      if (sar) {
        if (sar.enabled !== undefined) setRoutingSubagentEnabled(sar.enabled as boolean)
        if (sar.model) setRoutingSubagentModel(sar.model as string)
        if (sar.provider) setRoutingSubagentProvider(sar.provider as string)
      }

      // Быстрые ответы
      const mf = session.settings.microFirst as boolean | undefined
      const mct = session.settings.microConfidenceThreshold as number | undefined
      if (mf !== undefined) setMicroFirst(mf)
      if (mct !== undefined) setMicroConfidenceThreshold(mct)
      // Embedding
      const ee = session.settings.embeddingEnabled as boolean | undefined
      const ep = session.settings.embedProvider as string | undefined
      const em = session.settings.embedModel as string | undefined
      if (ee !== undefined) setEmbeddingEnabled(ee)
      if (ep) setEmbedProvider(ep)
      if (em) setEmbedModel(em)
    }
  }, [session])

  const handleSave = async () => {
    if (!sessionId) return
    if (!session) {
      notify({ text: t('sessionSettings.notLoaded'), type: 'warning', category: 'error', sessionId: sessionId || undefined })
      return
    }
    setSaving(true)
    try {
      await synthApi.updateSession(sessionId, {
        settings: {
          ...(session.settings as Record<string, unknown>),
          provider: selectedProviderName,
          model: selectedModelName,
          debugEnabled: debugEnabled,
          mcpServers: selectedMcpServers,
          routingEnabled,
          routingStrategy,
          routingContent: {
            coding: { provider: routingContentCodingProvider, model: routingContentCodingModel },
            chat: { provider: routingContentChatProvider, model: routingContentChatModel },
            research: { provider: routingContentResearchProvider, model: routingContentResearchModel },
          },
          routingEscalation: {
            enabled: routingEscalationEnabled,
            fallbackProvider: routingEscalationFallbackProvider,
            fallbackModel: routingEscalationFallbackModel,
            checks: ['min_length' as const],
            minLength: routingEscalationMinLength,
          },
          routingCost: {
            enabled: routingCostEnabled,
            cheapProvider: routingCostCheapProvider,
            cheapModel: routingCostCheapModel,
            maxCheapTokens: routingCostMaxTokens,
          },
          subagentRouting: {
            enabled: routingSubagentEnabled,
            model: routingSubagentModel,
            provider: routingSubagentProvider || undefined,
          },
          microFirst,
          microConfidenceThreshold,
          embeddingEnabled,
          embedProvider,
          embedModel,
        },
      })
      notify({ text: t('sessionSettings.saved'), type: 'success', category: 'system', sessionId: sessionId || undefined })
    } catch {
      notify({ text: t('sessionSettings.saveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
    } finally {
      setSaving(false)
    }
  }

  const handleClearSession = useCallback(async () => {
    if (!sessionId) return
    if (!window.confirm(t('leftPanel.confirmClearSession'))) return
    try {
      await synthApi.clearSession(sessionId)
      useChatStore.getState().clearSession(sessionId)
      const result = await synthApi.getSessionMessages(sessionId)
      useChatStore.getState().setMessages(sessionId, result.messages)
      notify({ text: t('chat.session.cleared'), type: 'success', category: 'queue', sessionId })
    } catch {
      notify({ text: t('chat.error.clearSession'), type: 'error', category: 'error', sessionId })
    }
  }, [sessionId, notify, t])

  if (!session) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('rightPanel.params.noSessions')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Section title={t('rightPanel.params.session')}>
          <Field label="ID" value={session.id.slice(0, 12) + '...'} mono />
          <Field label={t('rightPanel.params.project')} value={session.project_id || t('rightPanel.params.none')} />
          <Field label={t('rightPanel.params.engine')} value={session.engine} />
        </Section>

        <Section title={t('sessionSettings.providerModel')}>
          <ModelSelector sessionId={sessionId} />
        </Section>

        {/* Быстрые ответы */}
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              Быстрые ответы
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">
                    <Icon name="question" className="size-3 text-muted-foreground" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Простые запросы — приветствия, да/нет, классификация задач — обрабатываются мгновенно по правилам или embedding, без вызова большой модели. Это ускоряет ответ и экономит токены. Если запрос сложный или уверенность низкая — автоматически вызывается LLM. Порог уверенности настраивается ниже.
                </TooltipContent>
              </Tooltip>
            </span>
          }
        >
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle enabled={microFirst} onToggle={() => setMicroFirst(!microFirst)} />
            <span className="text-xs text-foreground">
              {microFirst ? 'Включено' : 'Выключено'}
            </span>
          </label>
          {microFirst && (
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Confidence Threshold</span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0.5" max="1.0" step="0.05"
                  value={microConfidenceThreshold}
                  onChange={(e) => setMicroConfidenceThreshold(parseFloat(e.target.value))}
                  className="w-20 h-1 accent-primary"
                />
                <span className="text-foreground font-mono tabular-nums min-w-[3ch]">
                  {microConfidenceThreshold.toFixed(2)}
                </span>
              </div>
            </div>
          )}
        </Section>

        {/* Embedding */}
        {microFirst && (
          <Section title="Embedding">
            <div className="text-[10px] text-muted-foreground/60 mb-2">
              Эмбеддинг-модель для семантической классификации в микро-слое
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <Toggle enabled={embeddingEnabled} onToggle={() => setEmbeddingEnabled(!embeddingEnabled)} />
              <span className="text-xs text-foreground">
                {embeddingEnabled ? 'Включено' : 'Выключено'}
              </span>
            </label>
            {embeddingEnabled && (
              <div className="mt-2">
                <RoutingModelPair
                  label="Embedding модель"
                  provider={embedProvider}
                  model={embedModel}
                  providers={providers}
                  models={models}
                  onProviderChange={setEmbedProvider}
                  onModelChange={setEmbedModel}
                />
              </div>
            )}
          </Section>
        )}

        {/* Маршрутизация */}
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              {t('routing.title')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">
                    <Icon name="question" className="size-3 text-muted-foreground" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Запросы, которые не обработали Быстрые ответы, распределяются между моделями автоматически: стратегия выбирает модель по типу задачи (кодинг/чат/анализ), по стоимости или сочетанием. Дополнительно работает контроль качества: если ответ неуверенный или слишком короткий — запрос пересылается на fallback-модель. Если маршрутизация выключена — используется модель, выбранная в сессии.
                </TooltipContent>
              </Tooltip>
            </span>
          }
        >
          <div className="space-y-3">
            {/* Вкл/Выкл */}
            <label className="flex items-center gap-3 cursor-pointer">
              <Toggle enabled={routingEnabled} onToggle={() => setRoutingEnabled(!routingEnabled)} />
              <span className="text-xs text-foreground">
                {routingEnabled ? t('common.enabled') : t('common.disabled')}
              </span>
            </label>

            {routingEnabled && (
              <>
                {/* Стратегия */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                    {t('routing.strategy')}
                  </label>
                  <select
                    value={routingStrategy}
                    onChange={(e) => setRoutingStrategy(e.target.value as typeof routingStrategy)}
                    className="w-full rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="auto">{t('routing.strategy.auto')}</option>
                    <option value="content">{t('routing.strategy.content')}</option>
                    <option value="cost">{t('routing.strategy.cost')}</option>
                    <option value="content+cost">{t('routing.strategy.contentCost')}</option>
                  </select>
                </div>

                {/* Контентная */}
                <div className="space-y-2 pl-2 border-l-2 border-border/30">
                  <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                    📝 {t('routing.content')}
                  </span>
                  <RoutingModelPair
                    label={t('routing.content.coding')}
                    provider={routingContentCodingProvider}
                    model={routingContentCodingModel}
                    providers={providers}
                    models={models}
                    onProviderChange={setRoutingContentCodingProvider}
                    onModelChange={setRoutingContentCodingModel}
                  />
                  <RoutingModelPair
                    label={t('routing.content.chat')}
                    provider={routingContentChatProvider}
                    model={routingContentChatModel}
                    providers={providers}
                    models={models}
                    onProviderChange={setRoutingContentChatProvider}
                    onModelChange={setRoutingContentChatModel}
                  />
                  <RoutingModelPair
                    label={t('routing.content.research')}
                    provider={routingContentResearchProvider}
                    model={routingContentResearchModel}
                    providers={providers}
                    models={models}
                    onProviderChange={setRoutingContentResearchProvider}
                    onModelChange={setRoutingContentResearchModel}
                  />
                </div>

                {/* Эскалация */}
                <div className="space-y-2 pl-2 border-l-2 border-border/30">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                      ⚠️ {t('routing.escalation')}
                    </span>
                    <Toggle enabled={routingEscalationEnabled} onToggle={() => setRoutingEscalationEnabled(!routingEscalationEnabled)} />
                  </div>
                  {routingEscalationEnabled && (
                    <>
                      <RoutingModelPair
                        label={t('routing.escalation.fallback')}
                        provider={routingEscalationFallbackProvider}
                        model={routingEscalationFallbackModel}
                        providers={providers}
                        models={models}
                        onProviderChange={setRoutingEscalationFallbackProvider}
                        onModelChange={setRoutingEscalationFallbackModel}
                      />
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{t('routing.escalation.minLength')}</span>
                        <input
                          type="number"
                          min={1}
                          value={routingEscalationMinLength}
                          onChange={(e) => setRoutingEscalationMinLength(Number(e.target.value) || 1)}
                          className="w-16 rounded-md bg-input border border-border px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* Стоимость */}
                <div className="space-y-2 pl-2 border-l-2 border-border/30">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                      💰 {t('routing.cost')}
                    </span>
                    <Toggle enabled={routingCostEnabled} onToggle={() => setRoutingCostEnabled(!routingCostEnabled)} />
                  </div>
                  {routingCostEnabled && (
                    <>
                      <RoutingModelPair
                        label={t('routing.cost.cheap')}
                        provider={routingCostCheapProvider}
                        model={routingCostCheapModel}
                        providers={providers}
                        models={models}
                        onProviderChange={setRoutingCostCheapProvider}
                        onModelChange={setRoutingCostCheapModel}
                      />
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{t('routing.cost.threshold')}</span>
                        <input
                          type="number"
                          min={1}
                          value={routingCostMaxTokens}
                          onChange={(e) => setRoutingCostMaxTokens(Number(e.target.value) || 1)}
                          className="w-20 rounded-md bg-input border border-border px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* Саб-агенты */}
                <div className="space-y-2 pl-2 border-l-2 border-border/30">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                      🤖 {t('routing.subagent')}
                    </span>
                    <Toggle enabled={routingSubagentEnabled} onToggle={() => setRoutingSubagentEnabled(!routingSubagentEnabled)} />
                  </div>
                  {routingSubagentEnabled && (
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-muted-foreground/60">{t('routing.subagent.model')}</label>
                      <select
                        value={routingSubagentProvider ? `${routingSubagentProvider}:${routingSubagentModel}` : 'auto'}
                        onChange={(e) => {
                          if (e.target.value === 'auto') {
                            setRoutingSubagentProvider('')
                            setRoutingSubagentModel('')
                          } else {
                            const [p, ...rest] = e.target.value.split(':')
                            setRoutingSubagentProvider(p!)
                            setRoutingSubagentModel(rest.join(':'))
                          }
                        }}
                        className="w-full rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
              </>
            )}
          </div>
        </Section>

        <Section title={t('sessionSettings.debug')}>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle enabled={debugEnabled} onToggle={() => setDebugEnabled(!debugEnabled)} />
            <span className="text-xs text-foreground">{debugEnabled ? t('sessionSettings.debugOn') : t('sessionSettings.debugOff')}</span>
          </label>
        </Section>

        <div className="rounded-lg border border-border bg-input p-3">
          <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('rightPanel.debug.title')}
          </h4>
          <div className="space-y-2">
            <label className="flex items-center gap-3 cursor-pointer">
              <Toggle enabled={debugSystemMessages} onToggle={() => setDebugSystemMessages(!debugSystemMessages)} />
              <span className="text-xs text-foreground">
                {debugSystemMessages ? t('sessionSettings.debugOn') : t('sessionSettings.debugOff')}{' '}
                {t('rightPanel.debug.systemMessages')}
              </span>
            </label>
            <button
              onClick={async () => {
                if (!sessionId) return
                setSendingDebug(true)
                try {
                  await synthApi.sendDebugSystemMessage(sessionId)
                  notify({ text: t('rightPanel.debug.sent'), type: 'success', category: 'system', sessionId })
                } catch (e) {
                  notify({ text: `${t('chat.error.sendFailed')} ${(e as Error).message}`, type: 'error', category: 'error', sessionId })
                } finally {
                  setSendingDebug(false)
                }
              }}
              disabled={sendingDebug}
              className="w-full rounded bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            >
              {sendingDebug ? t('sessionSettings.saving') : t('rightPanel.debug.sendSystemMessage')}
            </button>
          </div>
        </div>

        {mcpServers.length > 0 && (
          <Section title={t('mcp.title')}>
            <div className="flex flex-col gap-1.5">
              {mcpServers.map((srv) => (
                <label key={srv.name} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedMcpServers.includes(srv.name)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedMcpServers((prev) => [...prev, srv.name])
                      } else {
                        setSelectedMcpServers((prev) => prev.filter((n) => n !== srv.name))
                      }
                    }}
                    className="rounded size-3"
                  />
                  <span className="text-xs text-foreground">{srv.name}</span>
                </label>
              ))}
            </div>
          </Section>
        )}

        {agents.length > 0 && (
          <Section title={t('rightPanel.params.agents')}>
            <div className="flex flex-col gap-1">
              {agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  {a.display_name}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-4 space-y-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? t('sessionSettings.saving') : t('common.save')}
        </button>
        <button
          onClick={handleClearSession}
          className="w-full rounded-lg border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
        >
          {t('leftPanel.clearSession')}
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide mb-2">{title}</div>
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

interface ProviderLike { name: string; enabled: boolean }
interface ModelLike { name: string; provider: string; enabled: boolean }

function RoutingModelPair({
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
  providers: ProviderLike[]
  models: ModelLike[]
  onProviderChange: (v: string) => void
  onModelChange: (v: string) => void
}) {
  const availableProviders = providers.filter((p) => p.enabled)
  const filteredModels = models.filter((m) => m.enabled && (!provider || m.provider === provider))

  return (
    <div className="space-y-1">
      <span className="text-[10px] text-muted-foreground/60">{label}</span>
      <div className="flex gap-1">
        <select
          value={provider}
          onChange={(e) => {
            onProviderChange(e.target.value)
            onModelChange('')
          }}
          className="flex-1 min-w-0 rounded-md bg-input border border-border px-1.5 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">Провайдер</option>
          {availableProviders.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          className="flex-1 min-w-0 rounded-md bg-input border border-border px-1.5 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={!provider}
        >
          <option value="">Модель</option>
          {filteredModels.map((m) => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
