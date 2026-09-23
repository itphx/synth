import { useState, useEffect, useCallback, useRef } from 'react'
import type { TodoItem, TodoStatus, TodoPriority, McpServerEffective } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useChatStore } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { synthApi, type AgentInfo, type ToolsPolicy } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '../ui/Toggle'
import { ModelSelector } from '../chat/ModelSelector'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import { SelectContent, SelectItem } from '../ui/select'
import { InfoField as Field, InfoSection as Section, ModelPairSelect, SelectField, SliderField } from '../ui/settings'

export function SessionSettingsTab() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const sessions = useSessionsStore(s => s.sessions)
  const selectedProviderName = useProvidersStore(s => s.selectedProviderName)
  const selectedModelName = useProvidersStore(s => s.selectedModelName)
  const setSelectedProvider = useProvidersStore(s => s.setSelectedProvider)
  const setSelectedModel = useProvidersStore(s => s.setSelectedModel)
  const loadProviders = useProvidersStore(s => s.loadProviders)
  const loadModels = useProvidersStore(s => s.loadModels)

  const providers = useProvidersStore((s) => s.providers)
  const models = useProvidersStore((s) => s.models)

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [saving, setSaving] = useState(false)

  const [mcpEffective, setMcpEffective] = useState<McpServerEffective[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpToggling, setMcpToggling] = useState<string | null>(null)

  // AD-071 §2.3: per-session override политики инструментов ('' = следовать глобальной)
  const [toolsPolicy, setToolsPolicy] = useState<ToolsPolicy | ''>('')
  const [mcpPolicy, setMcpPolicy] = useState<ToolsPolicy | ''>('')

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
  // Таймаут подтверждения (сек)
  const [askTimeoutSec, setAskTimeoutSec] = useState<string>('')
  // Вкл/Выкл таймаута подтверждения (0 = выключен → запросы ждут ответа бесконечно)
  const [askTimeoutEnabled, setAskTimeoutEnabled] = useState(true)
  // Глобальный дефолт таймаута подтверждения из «Безопасность»
  const [defaultAskTimeoutMs, setDefaultAskTimeoutMs] = useState(30_000)

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId

  const session = sessions.find((s) => s.id === sessionId)
  const projects = useProjectsStore(s => s.projects)
  const projectName = projects.find(p => p.id === session?.project_id)?.name

  // Догружаем проект в стор, если его там нет (имя нужно для отображения).
  useEffect(() => {
    const projectId = session?.project_id
    if (projectId && !useProjectsStore.getState().projects.some(p => p.id === projectId)) {
      useProjectsStore.getState().getProject(projectId).catch(() => {})
    }
  }, [session?.project_id])

  useEffect(() => {
    loadProviders()
    loadModels()
  }, [loadProviders, loadModels])

  const loadMcpEffective = useCallback(async (id: string) => {
    setMcpLoading(true)
    try {
      const r = await synthApi.getSessionMcpEffective(id)
      setMcpEffective(r.servers)
      // Синхронизируем локальную сессию, чтобы общий Save не затёр свежие overrides.
      const current = useSessionsStore.getState().sessions.find((s) => s.id === id)
      if (current) {
        useSessionsStore.getState().upsertSession({
          ...current,
          settings: {
            ...(current.settings as Record<string, unknown>),
            mcpServers: r.mcpServers,
            mcpDisabledServers: r.mcpDisabledServers,
          },
        } as typeof current)
      }
    } catch {
      setMcpEffective([])
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => {
    if (sessionId) {
      synthApi.getAgents(sessionId).then((r) => setAgents(r.agents)).catch(() => {})
      void loadMcpEffective(sessionId)
    } else {
      setMcpEffective([])
    }
  }, [sessionId, loadMcpEffective])

  useEffect(() => {
    synthApi.getSecuritySettings()
      .then((s) => setDefaultAskTimeoutMs(s.askTimeoutMs ?? 30_000))
      .catch(() => {})
  }, [])

  // Синхронизируем локальную форму с сессией только при смене сессии или
  // глобального дефолта таймаута — иначе любое обновление объекта сессии
  // (WS-события, сохранение) затирало бы несохранённые правки.
  const lastSyncedRef = useRef<{ id: string | undefined; defaultMs: number } | null>(null)

  useEffect(() => {
    if (session && session.settings) {
      if (
        lastSyncedRef.current?.id === session.id
        && lastSyncedRef.current?.defaultMs === defaultAskTimeoutMs
      ) {
        return
      }
      lastSyncedRef.current = { id: session.id, defaultMs: defaultAskTimeoutMs }

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
      // Таймаут подтверждения: per-session override, иначе глобальный дефолт.
      // askTimeoutMs === 0 → «таймаут выключен» (toggle off).
      const permCfg = session.settings.permission as { askTimeoutMs?: number } | undefined
      const effMs = permCfg?.askTimeoutMs !== undefined ? permCfg.askTimeoutMs : defaultAskTimeoutMs
      setAskTimeoutEnabled(permCfg?.askTimeoutMs !== 0)
      setAskTimeoutSec(String(Math.round(effMs / 1000)))
      // AD-071 §2.3: per-session override политики инструментов ('' = глобальная).
      setToolsPolicy((session.settings.toolsPolicy as ToolsPolicy | undefined) ?? '')
      setMcpPolicy((session.settings.mcpPolicy as ToolsPolicy | undefined) ?? '')
    }
  }, [session, defaultAskTimeoutMs])

  const handleSave = async () => {
    if (!sessionId) return
    if (!session) {
      notify({ text: t('sessionSettings.notLoaded'), type: 'warning', category: 'error', sessionId: sessionId || undefined })
      return
    }
    setSaving(true)
    try {
      // Per-session таймаут подтверждения (askTimeoutMs). ВКЛ: применяется таймаут
      // из поля (значение, равное глобальному дефолту, не пишем как override —
      // сессия следует дефолту). ВЫКЛ: askTimeoutMs=0 («без таймаута», ждём ответа
      // бесконечно) — override пишем всегда.
      const currentPermission = session.settings.permission as Record<string, unknown> | undefined
      const enteredMs = Math.round((Number(askTimeoutSec) || 0) * 1000)
      let permissionSettings: Record<string, unknown> | undefined
      if (askTimeoutEnabled) {
        // ВКЛ: применяется таймаут из поля. Значение, равное глобальному дефолту,
        // не пишем как override (сессия следует дефолту) — как и раньше.
        if (enteredMs === defaultAskTimeoutMs) {
          if (currentPermission && 'askTimeoutMs' in currentPermission) {
            const rest = { ...currentPermission }
            delete rest.askTimeoutMs
            permissionSettings = rest
          } else {
            permissionSettings = currentPermission
          }
        } else {
          permissionSettings = { ...(currentPermission ?? {}), askTimeoutMs: enteredMs }
        }
      } else {
        // ВЫКЛ: таймаут отключён (0 = «без таймаута»), override пишем всегда.
        permissionSettings = { ...(currentPermission ?? {}), askTimeoutMs: 0 }
      }

      const updated = await synthApi.updateSession(sessionId, {
        settings: {
          ...(session.settings as Record<string, unknown>),
          provider: selectedProviderName,
          model: selectedModelName,
          debugEnabled: debugEnabled,
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
          // AD-071 §2.3: '' → undefined (сессия следует глобальной политике).
          toolsPolicy: toolsPolicy || undefined,
          mcpPolicy: mcpPolicy || undefined,
          ...(permissionSettings ? { permission: permissionSettings } : {}),
        },
      })
      useSessionsStore.getState().upsertSession(updated)
      notify({ text: t('sessionSettings.saved'), type: 'success', category: 'system', sessionId: sessionId || undefined })
    } catch {
      notify({ text: t('sessionSettings.saveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
    } finally {
      setSaving(false)
    }
  }

  const handleClearSession = useCallback(async () => {
    if (!sessionId) return
    const ok = await confirm({ title: t('leftPanel.confirmClearSession'), variant: 'warning' })
    if (!ok) return
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

  // Сессионные одобрения (AD-029): allow-правила, добавленные при «Разрешить в сессии».
  // Правило может быть строкой ('allow' — весь тул) или объектом { путь: 'allow' }
  // (конкретный путь). Панель показывает «тул: путь» для объектных правил.
  const sessionPermission = session?.settings.permission as { rules?: Record<string, string | Record<string, string>>; askTimeoutMs?: number } | undefined
  const sessionAllowRules = sessionPermission?.rules
    ? Object.entries(sessionPermission.rules).flatMap(([tool, value]) => {
        if (typeof value === 'string') return value === 'allow' ? [{ label: tool, tool, path: undefined as string | undefined }] : []
        if (value && typeof value === 'object') {
          return Object.entries(value as Record<string, string>)
            .filter(([, a]) => a === 'allow')
            .map(([path]) => ({ label: `${tool}: ${path}`, tool, path }))
        }
        return []
      })
    : []

  /** AD-071 §2.4: точечный toggle MCP-сервера в сессии (в т.ч. opt-out системного). */
  const handleToggleMcp = async (server: McpServerEffective) => {
    if (!sessionId || mcpToggling) return
    setMcpToggling(server.name)
    try {
      const r = await synthApi.updateSessionMcp(sessionId, { name: server.name, enabled: !server.enabled })
      setMcpEffective(r.servers)
      const current = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
      if (current) {
        useSessionsStore.getState().upsertSession({
          ...current,
          settings: {
            ...(current.settings as Record<string, unknown>),
            mcpServers: r.mcpServers,
            mcpDisabledServers: r.mcpDisabledServers,
          },
        } as typeof current)
      }
    } catch {
      notify({ text: t('sessionSettings.mcp.toggleError'), type: 'error', category: 'error', sessionId })
    } finally {
      setMcpToggling(null)
    }
  }

  const handleRemoveAllowRule = async (rule: { tool: string; path?: string }) => {
    if (!sessionId || !session) return
    const rules = { ...(sessionPermission?.rules ?? {}) }
    if (rule.path !== undefined) {
      const obj = { ...(rules[rule.tool] as Record<string, string> | undefined ?? {}) }
      delete obj[rule.path]
      if (Object.keys(obj).length === 0) delete rules[rule.tool]
      else rules[rule.tool] = obj
    } else {
      delete rules[rule.tool]
    }
    const nextPermission = { ...(sessionPermission ?? {}), rules }
    try {
      const updated = await synthApi.updateSession(sessionId, {
        settings: { ...session.settings, permission: nextPermission },
      })
      useSessionsStore.getState().upsertSession(updated)
    } catch {
      notify({ text: t('sessionSettings.saveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
    }
  }

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
          <Field label={t('rightPanel.params.name')} value={session.name || t('rightPanel.params.none')} />
          <Field label="ID" value={session.id} mono />
          <Field label={t('rightPanel.params.project')} value={projectName || session.project_id || t('rightPanel.params.none')} />
          <Field label={t('rightPanel.params.creator')} value={session.user_id || session.owner_id || t('rightPanel.params.none')} />
          <Field label={t('rightPanel.params.created')} value={formatDateTime(session.created_at, locale)} />
          <Field label={t('rightPanel.params.engine')} value={session.engine} />
        </Section>

        <Section title={t('sessionTab.todos.title')}>
          <SessionTodosBlock todos={session.todos} />
        </Section>

        <Section title={t('sessionSettings.providerModel')}>
          <ModelSelector sessionId={sessionId} alwaysShowLabel />
        </Section>

        {/* Таймаут подтверждения (ask) */}
        <Section title={t('sessionSettings.askTimeout')}>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle enabled={askTimeoutEnabled} onToggle={() => setAskTimeoutEnabled(!askTimeoutEnabled)} />
            <span className="text-xs text-foreground">
              {askTimeoutEnabled ? t('sessionSettings.askTimeoutEnabled') : t('sessionSettings.askTimeoutDisabled')}
            </span>
          </label>
          {askTimeoutEnabled && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground">{t('sessionSettings.askTimeoutSeconds')}</span>
              <input
                type="number"
                min={0}
                value={askTimeoutSec}
                onChange={(e) => setAskTimeoutSec(e.target.value)}
                className="w-24 shrink-0 rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
        </Section>

        {/* Сессионные одобрения (AD-029) */}
        <Section title={t('sessionSettings.allow.title')}>
          {sessionAllowRules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">{t('sessionSettings.allow.empty')}</div>
              <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60">
                {t('sessionSettings.allow.hint')}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {sessionAllowRules.map((rule) => (
                <div key={rule.tool + (rule.path ?? '')} className="flex items-center gap-2 rounded-lg border border-border/60 bg-input px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground font-mono">{rule.label}</span>
                  <button
                    onClick={() => handleRemoveAllowRule(rule)}
                    className="shrink-0 rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    {t('sessionSettings.allow.remove')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Быстрые ответы */}
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              {t('sessionSettings.micro.title')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">
                    <Icon name="question" className="size-3 text-muted-foreground" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t('sessionSettings.micro.tooltip')}
                </TooltipContent>
              </Tooltip>
            </span>
          }
        >
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle enabled={microFirst} onToggle={() => setMicroFirst(!microFirst)} />
            <span className="text-xs text-foreground">
              {microFirst ? t('common.enabled') : t('common.disabled')}
            </span>
          </label>
          {microFirst && (
            <SliderField
              label={t('sessionSettings.micro.confidence')}
              min={0.5}
              max={1}
              step={0.05}
              value={microConfidenceThreshold}
              onValueChange={setMicroConfidenceThreshold}
              formatValue={(value) => value.toFixed(2)}
            />
          )}
        </Section>

        {/* Embedding */}
        {microFirst && (
          <Section title={t('sessionSettings.micro.embedding')}>
            <div className="text-[0.625rem] text-muted-foreground/60 mb-2">
              {t('sessionSettings.micro.embeddingHint')}
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <Toggle enabled={embeddingEnabled} onToggle={() => setEmbeddingEnabled(!embeddingEnabled)} />
              <span className="text-xs text-foreground">
                {embeddingEnabled ? t('common.enabled') : t('common.disabled')}
              </span>
            </label>
            {embeddingEnabled && (
              <div className="mt-2">
                <ModelPairSelect
                  variant="compact"
                  filterOptions
                  label={t('sessionSettings.micro.embeddingModel')}
                  provider={embedProvider}
                  model={embedModel}
                  providers={providers}
                  models={models}
                  providerLabel={t('settings.microFirst.provider')}
                  modelLabel={t('settings.microFirst.model')}
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
                  {t('sessionSettings.routing.tooltip')}
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
                <SelectField
                  label={t('routing.strategy')}
                  value={routingStrategy}
                  onValueChange={(value) => setRoutingStrategy(value as typeof routingStrategy)}
                  ariaLabel={t('routing.strategy')}
                >
                  <SelectContent>
                    <SelectItem value="auto">{t('routing.strategy.auto')}</SelectItem>
                    <SelectItem value="content">{t('routing.strategy.content')}</SelectItem>
                    <SelectItem value="cost">{t('routing.strategy.cost')}</SelectItem>
                    <SelectItem value="content+cost">{t('routing.strategy.contentCost')}</SelectItem>
                  </SelectContent>
                </SelectField>

                {/* Контентная */}
                <div className="space-y-2 pl-2 border-l-2 border-border/30">
                  <span className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
                    {t('routing.content')}
                  </span>
                  <ModelPairSelect
                    variant="compact"
                    filterOptions
                    label={t('routing.content.coding')}
                    provider={routingContentCodingProvider}
                    model={routingContentCodingModel}
                    providers={providers}
                    models={models}
                    providerLabel={t('settings.microFirst.provider')}
                    modelLabel={t('settings.microFirst.model')}
                    onProviderChange={setRoutingContentCodingProvider}
                    onModelChange={setRoutingContentCodingModel}
                  />
                  <ModelPairSelect
                    variant="compact"
                    filterOptions
                    label={t('routing.content.chat')}
                    provider={routingContentChatProvider}
                    model={routingContentChatModel}
                    providers={providers}
                    models={models}
                    providerLabel={t('settings.microFirst.provider')}
                    modelLabel={t('settings.microFirst.model')}
                    onProviderChange={setRoutingContentChatProvider}
                    onModelChange={setRoutingContentChatModel}
                  />
                  <ModelPairSelect
                    variant="compact"
                    filterOptions
                    label={t('routing.content.research')}
                    provider={routingContentResearchProvider}
                    model={routingContentResearchModel}
                    providers={providers}
                    models={models}
                    providerLabel={t('settings.microFirst.provider')}
                    modelLabel={t('settings.microFirst.model')}
                    onProviderChange={setRoutingContentResearchProvider}
                    onModelChange={setRoutingContentResearchModel}
                  />
                </div>

                {/* Эскалация */}
                <div className="space-y-2 pl-2 border-l-2 border-border/30">
                  <div className="flex items-center gap-2">
                    <span className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
                      {t('routing.escalation')}
                    </span>
                    <Toggle enabled={routingEscalationEnabled} onToggle={() => setRoutingEscalationEnabled(!routingEscalationEnabled)} />
                  </div>
                  {routingEscalationEnabled && (
                    <>
                      <ModelPairSelect
                        variant="compact"
                        filterOptions
                        label={t('routing.escalation.fallback')}
                        provider={routingEscalationFallbackProvider}
                        model={routingEscalationFallbackModel}
                        providers={providers}
                        models={models}
                        providerLabel={t('settings.microFirst.provider')}
                        modelLabel={t('settings.microFirst.model')}
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
                    <span className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
                      {t('routing.cost')}
                    </span>
                    <Toggle enabled={routingCostEnabled} onToggle={() => setRoutingCostEnabled(!routingCostEnabled)} />
                  </div>
                  {routingCostEnabled && (
                    <>
                      <ModelPairSelect
                        variant="compact"
                        filterOptions
                        label={t('routing.cost.cheap')}
                        provider={routingCostCheapProvider}
                        model={routingCostCheapModel}
                        providers={providers}
                        models={models}
                        providerLabel={t('settings.microFirst.provider')}
                        modelLabel={t('settings.microFirst.model')}
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
                    <span className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
                      {t('routing.subagent')}
                    </span>
                    <Toggle enabled={routingSubagentEnabled} onToggle={() => setRoutingSubagentEnabled(!routingSubagentEnabled)} />
                  </div>
                  {routingSubagentEnabled && (
                    <SelectField
                      label={t('routing.subagent.model')}
                      value={routingSubagentProvider ? `${routingSubagentProvider}:${routingSubagentModel}` : 'auto'}
                      onValueChange={(value) => {
                        if (value === 'auto') {
                          setRoutingSubagentProvider('')
                          setRoutingSubagentModel('')
                        } else {
                          const [provider, ...rest] = value.split(':')
                          setRoutingSubagentProvider(provider!)
                          setRoutingSubagentModel(rest.join(':'))
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

        {(mcpEffective.length > 0 || mcpLoading) && (
          <Section title={t('sessionSettings.mcp.title')}>
            {mcpLoading && mcpEffective.length === 0 ? (
              <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
            ) : (
              <div className="flex flex-col gap-1.5" data-testid="session-mcp-list">
                {mcpEffective.map((srv) => (
                  <div
                    key={srv.name}
                    data-testid={`session-mcp-${srv.name}`}
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-input px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="truncate text-xs text-foreground">{srv.name}</span>
                        <span className="rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
                          {t(`rightPanel.stats.mcpLevel.${srv.level}`)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[0.625rem] text-muted-foreground/70">
                        {srv.enabled
                          ? t(`rightPanel.stats.mcpStatus.${srv.status ?? 'connected'}`)
                          : `${t('rightPanel.stats.mcpStatus.disabled')}${srv.reason ? ` · ${t(`rightPanel.stats.mcpReason.${srv.reason}`)}` : ''}`}
                      </div>
                    </div>
                    <Toggle
                      enabled={srv.enabled}
                      onToggle={() => handleToggleMcp(srv)}
                      ariaLabel={srv.enabled ? t('mcp.disable') : t('mcp.enable')}
                    />
                  </div>
                ))}
              </div>
            )}
            <p className="text-[0.625rem] text-muted-foreground/60">{t('sessionSettings.mcp.hint')}</p>
          </Section>
        )}

        {/* AD-071 §2.3: политики включения инструментов (per-session override) */}
        <Section title={t('toolsPolicy.title')}>
          <div className="flex flex-col gap-1">
            <SelectField
              value={toolsPolicy}
              onValueChange={(v) => setToolsPolicy(v as ToolsPolicy | '')}
              ariaLabel={t('toolsPolicy.label')}
              items={[
                { value: '', label: t('toolsPolicy.inherit') },
                { value: 'consistency', label: t('toolsPolicy.consistency') },
                { value: 'available', label: t('toolsPolicy.available') },
                { value: 'auto', label: t('toolsPolicy.auto') },
              ]}
            >
              <SelectContent>
                <SelectItem value="">{t('toolsPolicy.inherit')}</SelectItem>
                <SelectItem value="consistency">{t('toolsPolicy.consistency')}</SelectItem>
                <SelectItem value="available">{t('toolsPolicy.available')}</SelectItem>
                <SelectItem value="auto">{t('toolsPolicy.auto')}</SelectItem>
              </SelectContent>
            </SelectField>
            <p className="text-[0.625rem] text-muted-foreground/60">{t('toolsPolicy.sessionHelp')}</p>
          </div>
        </Section>

        <Section title={t('mcpPolicy.title')}>
          <div className="flex flex-col gap-1">
            <SelectField
              value={mcpPolicy}
              onValueChange={(v) => setMcpPolicy(v as ToolsPolicy | '')}
              ariaLabel={t('mcpPolicy.label')}
              items={[
                { value: '', label: t('mcpPolicy.inherit') },
                { value: 'consistency', label: t('mcpPolicy.consistency') },
                { value: 'available', label: t('mcpPolicy.available') },
                { value: 'auto', label: t('mcpPolicy.auto') },
              ]}
            >
              <SelectContent>
                <SelectItem value="">{t('mcpPolicy.inherit')}</SelectItem>
                <SelectItem value="consistency">{t('mcpPolicy.consistency')}</SelectItem>
                <SelectItem value="available">{t('mcpPolicy.available')}</SelectItem>
                <SelectItem value="auto">{t('mcpPolicy.auto')}</SelectItem>
              </SelectContent>
            </SelectField>
            <p className="text-[0.625rem] text-muted-foreground/60">{t('mcpPolicy.sessionHelp')}</p>
          </div>
        </Section>

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

const TODO_STATUS_STYLES: Record<TodoStatus, { labelKey: string; className: string }> = {
  pending: { labelKey: 'sessionTab.todo.status.pending', className: 'bg-muted/60 text-muted-foreground' },
  in_progress: { labelKey: 'sessionTab.todo.status.in_progress', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  completed: { labelKey: 'sessionTab.todo.status.completed', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  cancelled: { labelKey: 'sessionTab.todo.status.cancelled', className: 'bg-destructive/10 text-destructive line-through' },
}

const TODO_PRIORITY_STYLES: Record<TodoPriority, { labelKey: string; className: string }> = {
  high: { labelKey: 'sessionTab.todo.priority.high', className: 'text-red-600 dark:text-red-400' },
  medium: { labelKey: 'sessionTab.todo.priority.medium', className: 'text-amber-600 dark:text-amber-400' },
  low: { labelKey: 'sessionTab.todo.priority.low', className: 'text-muted-foreground' },
}

function SessionTodosBlock({ todos }: { todos?: TodoItem[] | null }) {
  const { t } = useI18n()

  if (!todos || todos.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
        <div className="text-xs text-muted-foreground">{t('sessionTab.todos.empty')}</div>
        <div className="mt-0.5 text-[0.625rem] text-muted-foreground/60">{t('sessionTab.todos.hint')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {todos.map((todo, i) => {
        const statusStyle = TODO_STATUS_STYLES[todo.status]
        const priorityStyle = TODO_PRIORITY_STYLES[todo.priority] || TODO_PRIORITY_STYLES.low
        return (
          <div key={todo.id ?? i} className="flex items-start gap-2 rounded-lg border border-border/60 bg-input px-2.5 py-1.5">
            <span className={`mt-0.5 inline-flex shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium ${statusStyle.className}`}>
              {t(statusStyle.labelKey)}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-xs text-foreground ${todo.status === 'completed' ? 'line-through opacity-60' : ''}`}>
                {todo.content}
              </div>
              <div className={`mt-0.5 text-[0.625rem] font-medium uppercase tracking-wide ${priorityStyle.className}`}>
                {t(priorityStyle.labelKey)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

