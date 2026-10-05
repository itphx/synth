import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { TodoItem, TodoStatus, TodoPriority, McpServerEffective } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { usePanelSettingSave } from '@/hooks/usePanelSettingSave'
import { formatDateTime } from '@/lib/formatDate'
import { synthApi, type AgentInfo, type EffectiveSkillEntry, type ToolsPolicy } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '../ui/Toggle'
import { DEFAULT_SESSION_ICON_COLOR, resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { ModelSelector } from '../chat/ModelSelector'
import { ProjectInstructions } from './ProjectInstructions'
import { ExpandableListRow, RowBadge } from './ExpandableListRow'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import { SelectContent, SelectItem } from '../ui/select'
import { InfoField as Field, InfoSection as Section, ModelPairSelect, SelectField, SliderField } from '../ui/settings'
import { PanelTab } from './PanelTab'

/** Задержка автосохранения для инпутов/слайдеров (тумблеры/селекты сохраняются сразу). */
const AUTOSAVE_DEBOUNCE_MS = 500

/** Поля формы вкладки «Сессия», участвующие в автосохранении. */
interface SessionFormValues {
  debugEnabled: boolean
  toolsPolicy: ToolsPolicy | ''
  mcpPolicy: ToolsPolicy | ''
  routingEnabled: boolean
  routingStrategy: 'auto' | 'content' | 'cost' | 'content+cost'
  routingContentCodingProvider: string
  routingContentCodingModel: string
  routingContentChatProvider: string
  routingContentChatModel: string
  routingContentResearchProvider: string
  routingContentResearchModel: string
  routingEscalationEnabled: boolean
  routingEscalationFallbackProvider: string
  routingEscalationFallbackModel: string
  routingEscalationMinLength: number
  routingCostEnabled: boolean
  routingCostCheapProvider: string
  routingCostCheapModel: string
  routingCostMaxTokens: number
  routingSubagentEnabled: boolean
  routingSubagentModel: string
  routingSubagentProvider: string
  microFirst: boolean
  microConfidenceThreshold: number
  embeddingEnabled: boolean
  embedProvider: string
  embedModel: string
  askTimeoutEnabled: boolean
  askTimeoutSec: string
}

/** Поля, сохраняемые немедленно: тумблеры и селекты. Инпуты/слайдеры — с debounce. */
const IMMEDIATE_FORM_KEYS: ReadonlySet<keyof SessionFormValues> = new Set([
  'debugEnabled',
  'toolsPolicy',
  'mcpPolicy',
  'routingEnabled',
  'routingStrategy',
  'routingContentCodingProvider',
  'routingContentCodingModel',
  'routingContentChatProvider',
  'routingContentChatModel',
  'routingContentResearchProvider',
  'routingContentResearchModel',
  'routingEscalationEnabled',
  'routingEscalationFallbackProvider',
  'routingEscalationFallbackModel',
  'routingCostEnabled',
  'routingCostCheapProvider',
  'routingCostCheapModel',
  'routingSubagentEnabled',
  'routingSubagentModel',
  'routingSubagentProvider',
  'microFirst',
  'embeddingEnabled',
  'embedProvider',
  'embedModel',
  'askTimeoutEnabled',
])

/**
 * Нормализация полей таймаута для сравнения «есть ли изменения»: 0 или пустые секунды
 * означают «таймаут выключен» (askTimeoutMs=0 — без таймаута), поэтому неактивный
 * тумблер с нулевым вводом приравнивается к выключенному. Тело запроса при этом
 * строится по «сырым» значениям формы (семантика `askTimeoutMs` не меняется).
 */
function normalizeAskTimeout(values: SessionFormValues): SessionFormValues {
  const active = values.askTimeoutEnabled && (Number(values.askTimeoutSec) || 0) > 0
  return {
    ...values,
    askTimeoutEnabled: active,
    askTimeoutSec: active ? String(Number(values.askTimeoutSec)) : '',
  }
}

/**
 * Нормализованный слепок формы из настроек сессии: отсутствующие ключи заменяются
 * дефолтами формы, `askTimeoutMs` — эффективным значением (per-session override или
 * глобальный дефолт). Используется и для гидратации, и как эталон «нет изменений»
 * при автосохранении (сравнение `form` ↔ `sessionValues`).
 */
function formValuesFromSettings(
  settings: Record<string, unknown> | undefined,
  defaultAskTimeoutMs: number,
): SessionFormValues {
  const s = settings ?? {}
  const permCfg = s.permission as { askTimeoutMs?: number } | undefined
  const effMs = permCfg?.askTimeoutMs !== undefined ? permCfg.askTimeoutMs : defaultAskTimeoutMs
  const rc = s.routingContent as Record<string, { provider?: string; model?: string }> | undefined
  const resc = s.routingEscalation as Record<string, unknown> | undefined
  const rcost = s.routingCost as Record<string, unknown> | undefined
  const sar = s.subagentRouting as Record<string, unknown> | undefined
  return {
    debugEnabled: (s.debugEnabled as boolean | undefined) ?? false,
    toolsPolicy: (s.toolsPolicy as ToolsPolicy | undefined) ?? '',
    mcpPolicy: (s.mcpPolicy as ToolsPolicy | undefined) ?? '',
    routingEnabled: (s.routingEnabled as boolean | undefined) ?? false,
    routingStrategy: (s.routingStrategy as SessionFormValues['routingStrategy'] | undefined) ?? 'auto',
    routingContentCodingProvider: rc?.coding?.provider ?? '',
    routingContentCodingModel: rc?.coding?.model ?? '',
    routingContentChatProvider: rc?.chat?.provider ?? '',
    routingContentChatModel: rc?.chat?.model ?? '',
    routingContentResearchProvider: rc?.research?.provider ?? '',
    routingContentResearchModel: rc?.research?.model ?? '',
    routingEscalationEnabled: (resc?.enabled as boolean | undefined) ?? false,
    routingEscalationFallbackProvider: (resc?.fallbackProvider as string | undefined) ?? '',
    routingEscalationFallbackModel: (resc?.fallbackModel as string | undefined) ?? '',
    routingEscalationMinLength: (resc?.minLength as number | undefined) ?? 10,
    routingCostEnabled: (rcost?.enabled as boolean | undefined) ?? false,
    routingCostCheapProvider: (rcost?.cheapProvider as string | undefined) ?? '',
    routingCostCheapModel: (rcost?.cheapModel as string | undefined) ?? '',
    routingCostMaxTokens: (rcost?.maxCheapTokens as number | undefined) ?? 500,
    routingSubagentEnabled: (sar?.enabled as boolean | undefined) ?? false,
    routingSubagentModel: (sar?.model as string | undefined) ?? '',
    routingSubagentProvider: (sar?.provider as string | undefined) ?? '',
    microFirst: (s.microFirst as boolean | undefined) ?? false,
    microConfidenceThreshold: (s.microConfidenceThreshold as number | undefined) ?? 0.8,
    embeddingEnabled: (s.embeddingEnabled as boolean | undefined) ?? false,
    embedProvider: (s.embedProvider as string | undefined) ?? '',
    embedModel: (s.embedModel as string | undefined) ?? '',
    askTimeoutEnabled: permCfg?.askTimeoutMs !== 0,
    askTimeoutSec: String(Math.round(effMs / 1000)),
  }
}

/**
 * Тело `PATCH /sessions/:id`, идентичное прежнему `handleSave`: семантика `askTimeout`
 * сохранена (0 — «без таймаута»; значение, равное глобальному дефолту, не пишем как
 * override, сессия следует дефолту).
 */
function buildSettingsBody(
  values: SessionFormValues,
  session: { id: string; settings: Record<string, unknown> },
  provider: string | null,
  model: string | null,
  defaultAskTimeoutMs: number,
): Record<string, unknown> {
  const currentPermission = session.settings.permission as Record<string, unknown> | undefined
  const enteredMs = Math.round((Number(values.askTimeoutSec) || 0) * 1000)
  let permissionSettings: Record<string, unknown> | undefined
  if (values.askTimeoutEnabled) {
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
    permissionSettings = { ...(currentPermission ?? {}), askTimeoutMs: 0 }
  }

  // Гигиена автосейва: не пишем пустой `permission: {}` (создаёт «мусорный»
  // override, маскирующий дефолт). Если в результате не осталось ключей —
  // ключ `permission` из настроек вовсе опускается, сессия следует дефолту.
  if (permissionSettings && Object.keys(permissionSettings).length === 0) {
    permissionSettings = undefined
  }

  // `permission` пересобирается ниже; исключаем исходное значение из spread,
  // чтобы пустой объект не «просачивался» через `...session.settings`.
  const restSettings = { ...session.settings }
  delete restSettings.permission

  return {
    ...restSettings,
    provider,
    model,
    debugEnabled: values.debugEnabled,
    routingEnabled: values.routingEnabled,
    routingStrategy: values.routingStrategy,
    routingContent: {
      coding: { provider: values.routingContentCodingProvider, model: values.routingContentCodingModel },
      chat: { provider: values.routingContentChatProvider, model: values.routingContentChatModel },
      research: { provider: values.routingContentResearchProvider, model: values.routingContentResearchModel },
    },
    routingEscalation: {
      enabled: values.routingEscalationEnabled,
      fallbackProvider: values.routingEscalationFallbackProvider,
      fallbackModel: values.routingEscalationFallbackModel,
      checks: ['min_length' as const],
      minLength: values.routingEscalationMinLength,
    },
    routingCost: {
      enabled: values.routingCostEnabled,
      cheapProvider: values.routingCostCheapProvider,
      cheapModel: values.routingCostCheapModel,
      maxCheapTokens: values.routingCostMaxTokens,
    },
    subagentRouting: {
      enabled: values.routingSubagentEnabled,
      model: values.routingSubagentModel,
      provider: values.routingSubagentProvider || undefined,
    },
    microFirst: values.microFirst,
    microConfidenceThreshold: values.microConfidenceThreshold,
    embeddingEnabled: values.embeddingEnabled,
    embedProvider: values.embedProvider,
    embedModel: values.embedModel,
    // AD-071 §2.3: '' → undefined (сессия следует глобальной политике).
    toolsPolicy: values.toolsPolicy || undefined,
    mcpPolicy: values.mcpPolicy || undefined,
    ...(permissionSettings ? { permission: permissionSettings } : {}),
  }
}

export function SessionSettingsTab() {
  const { t, locale } = useI18n()
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
  // Отложенное (debounce) сохранение и его таймер — для best-effort дофлаша.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<(() => void) | null>(null)

  const [mcpEffective, setMcpEffective] = useState<McpServerEffective[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)

  // AD-046 §4.5: per-session скиллы (вкл/выкл), аналог MCP-скоупа
  const [sessionSkills, setSessionSkills] = useState<EffectiveSkillEntry[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  // AD-071 §2.3: per-session override политики инструментов ('' = следовать глобальной)
  const [toolsPolicy, setToolsPolicy] = useState<ToolsPolicy | ''>('')
  const [mcpPolicy, setMcpPolicy] = useState<ToolsPolicy | ''>('')
  // Актуальные глобальные политики — для метки наследования «Глобальная (<политика>)».
  const [globalToolsPolicy, setGlobalToolsPolicy] = useState<ToolsPolicy | null>(null)
  const [globalMcpPolicy, setGlobalMcpPolicy] = useState<ToolsPolicy | null>(null)

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

  const { run, isPending } = usePanelSettingSave({ sessionId })
  /** Pending конкретного поля формы (проп `Toggle.pending`). */
  const isFieldPending = useCallback(
    (field: string) => isPending(`autosave:${field}`),
    [isPending],
  )

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

  const loadSkillsEffective = useCallback(async (id: string) => {
    setSkillsLoading(true)
    try {
      const r = await synthApi.getSessionSkills(id)
      setSessionSkills(r.skills)
      // Синхронизируем локальную сессию, чтобы общий Save не затёр свежие overrides.
      const current = useSessionsStore.getState().sessions.find((s) => s.id === id)
      if (current) {
        useSessionsStore.getState().upsertSession({
          ...current,
          settings: {
            ...(current.settings as Record<string, unknown>),
            skills: r.enabled,
            skillsDisabled: r.disabled,
          },
        } as typeof current)
      }
    } catch {
      setSessionSkills([])
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (sessionId) {
      synthApi.getAgents(sessionId).then((r) => setAgents(r.agents)).catch(() => {})
      void loadMcpEffective(sessionId)
      void loadSkillsEffective(sessionId)
    } else {
      setMcpEffective([])
      setSessionSkills([])
    }
  }, [sessionId, loadMcpEffective, loadSkillsEffective])

  useEffect(() => {
    synthApi.getSecuritySettings()
      .then((s) => setDefaultAskTimeoutMs(s.askTimeoutMs ?? 30_000))
      .catch(() => {})
  }, [])

  // Актуальное глобальное значение политик — только для метки наследования.
  // Ошибка запроса не блокирует рендер: остаёмся на фоллбеке «Глобальная».
  useEffect(() => {
    synthApi.getToolsPolicyInfo().then((r) => setGlobalToolsPolicy(r.policy)).catch(() => {})
    synthApi.getMcpPolicyInfo().then((r) => setGlobalMcpPolicy(r.policy)).catch(() => {})
  }, [])

  // «Эпоха» гидратации формы: для какой сессии и какого глобального дефолта таймаута
  // форма заполнена. Ref защищает гидратацию от лишних прогонов (ставится синхронно),
  // а одноимённый state — гейт автосохранения: он фиксируется только вместе с
  // закоммиченными значениями формы. В StrictMode эффекты монтируются дважды, и без
  // разделения ref/state автосохранение во втором прогоне увидело бы устаревшую
  // (дефолтную) форму и записало её в сессию (регрессия: ложные `panel.saved`).
  const hydratedRef = useRef<{ id: string | undefined; defaultMs: number } | null>(null)
  const [hydrated, setHydrated] = useState<{ id: string | undefined; defaultMs: number } | null>(null)

  // Слепок текущих значений формы и эталон «как в session.settings» (с дефолтами).
  // Равенство `form` ↔ `sessionValues` означает «изменений нет» — сохранять нечего.
  const form = useMemo<SessionFormValues>(() => ({
    debugEnabled,
    toolsPolicy,
    mcpPolicy,
    routingEnabled,
    routingStrategy,
    routingContentCodingProvider,
    routingContentCodingModel,
    routingContentChatProvider,
    routingContentChatModel,
    routingContentResearchProvider,
    routingContentResearchModel,
    routingEscalationEnabled,
    routingEscalationFallbackProvider,
    routingEscalationFallbackModel,
    routingEscalationMinLength,
    routingCostEnabled,
    routingCostCheapProvider,
    routingCostCheapModel,
    routingCostMaxTokens,
    routingSubagentEnabled,
    routingSubagentModel,
    routingSubagentProvider,
    microFirst,
    microConfidenceThreshold,
    embeddingEnabled,
    embedProvider,
    embedModel,
    askTimeoutEnabled,
    askTimeoutSec,
  }), [
    debugEnabled, toolsPolicy, mcpPolicy, routingEnabled, routingStrategy,
    routingContentCodingProvider, routingContentCodingModel,
    routingContentChatProvider, routingContentChatModel,
    routingContentResearchProvider, routingContentResearchModel,
    routingEscalationEnabled, routingEscalationFallbackProvider, routingEscalationFallbackModel,
    routingEscalationMinLength, routingCostEnabled, routingCostCheapProvider, routingCostCheapModel,
    routingCostMaxTokens, routingSubagentEnabled, routingSubagentModel, routingSubagentProvider,
    microFirst, microConfidenceThreshold, embeddingEnabled, embedProvider, embedModel,
    askTimeoutEnabled, askTimeoutSec,
  ])

  const sessionValues = useMemo(
    () => formValuesFromSettings(session?.settings, defaultAskTimeoutMs),
    [session?.settings, defaultAskTimeoutMs],
  )

  const dirtyKeys = useMemo(() => {
    if (!session) return []
    const formForCompare = normalizeAskTimeout(form)
    const sessionForCompare = normalizeAskTimeout(sessionValues)
    return (Object.keys(formForCompare) as Array<keyof SessionFormValues>)
      .filter((key) => formForCompare[key] !== sessionForCompare[key])
  }, [form, sessionValues, session])

  // Провайдер/модель берём из стора (как раньше в `handleSave`) — через ref, чтобы
  // не пересоздавать сохранение на каждое изменение выбора модели.
  const providerRef = useRef(selectedProviderName)
  const modelRef = useRef(selectedModelName)
  const defaultTimeoutRef = useRef(defaultAskTimeoutMs)
  providerRef.current = selectedProviderName
  modelRef.current = selectedModelName
  defaultTimeoutRef.current = defaultAskTimeoutMs

  /** Применить значения формы (гидратация при смене сессии и откат при ошибке автосохранения). */
  const applyFormValues = useCallback((values: SessionFormValues) => {
    setDebugEnabled(values.debugEnabled)
    setToolsPolicy(values.toolsPolicy)
    setMcpPolicy(values.mcpPolicy)
    setRoutingEnabled(values.routingEnabled)
    setRoutingStrategy(values.routingStrategy)
    setRoutingContentCodingProvider(values.routingContentCodingProvider)
    setRoutingContentCodingModel(values.routingContentCodingModel)
    setRoutingContentChatProvider(values.routingContentChatProvider)
    setRoutingContentChatModel(values.routingContentChatModel)
    setRoutingContentResearchProvider(values.routingContentResearchProvider)
    setRoutingContentResearchModel(values.routingContentResearchModel)
    setRoutingEscalationEnabled(values.routingEscalationEnabled)
    setRoutingEscalationFallbackProvider(values.routingEscalationFallbackProvider)
    setRoutingEscalationFallbackModel(values.routingEscalationFallbackModel)
    setRoutingEscalationMinLength(values.routingEscalationMinLength)
    setRoutingCostEnabled(values.routingCostEnabled)
    setRoutingCostCheapProvider(values.routingCostCheapProvider)
    setRoutingCostCheapModel(values.routingCostCheapModel)
    setRoutingCostMaxTokens(values.routingCostMaxTokens)
    setRoutingSubagentEnabled(values.routingSubagentEnabled)
    setRoutingSubagentModel(values.routingSubagentModel)
    setRoutingSubagentProvider(values.routingSubagentProvider)
    setMicroFirst(values.microFirst)
    setMicroConfidenceThreshold(values.microConfidenceThreshold)
    setEmbeddingEnabled(values.embeddingEnabled)
    setEmbedProvider(values.embedProvider)
    setEmbedModel(values.embedModel)
    setAskTimeoutEnabled(values.askTimeoutEnabled)
    setAskTimeoutSec(values.askTimeoutSec)
  }, [])

  const runSave = useCallback(async (
    field: string,
    values: SessionFormValues,
    target: { id: string; settings: Record<string, unknown> },
  ) => {
    await run({
      key: `autosave:${field}`,
      run: async () => {
        const body = buildSettingsBody(values, target, providerRef.current, modelRef.current, defaultTimeoutRef.current)
        return synthApi.updateSession(target.id, { settings: body })
      },
      onSuccess: (updated) => {
        useSessionsStore.getState().upsertSession(updated)
      },
      onError: () => {
        // Ошибка сохранения: форма возвращается к последнему серверному состоянию —
        // никаких «залипших» оптимистичных значений.
        applyFormValues(formValuesFromSettings(target.settings, defaultTimeoutRef.current))
      },
    })
  }, [run, applyFormValues])
  const runSaveRef = useRef(runSave)
  runSaveRef.current = runSave

  // Автосохранение: тумблеры/селекты — сразу, инпуты/слайдеры — с debounce ~500 мс.
  // До гидратации формы под текущую сессию/дефолт (hydrated) и при отсутствии
  // реальных отличий от session.settings (dirtyKeys пуст) запрос не шлём.
  useEffect(() => {
    if (
      !sessionId
      || !session
      || hydrated?.id !== session.id
      || hydrated.defaultMs !== defaultAskTimeoutMs
    ) {
      return
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    pendingSaveRef.current = null
    if (dirtyKeys.length === 0) return

    const field = dirtyKeys[0]!
    const target = session
    const values = form
    const save = () => {
      void runSaveRef.current(field, values, target)
    }
    if (dirtyKeys.some((key) => IMMEDIATE_FORM_KEYS.has(key))) {
      save()
    } else {
      pendingSaveRef.current = save
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        pendingSaveRef.current = null
        save()
      }, AUTOSAVE_DEBOUNCE_MS)
    }
  }, [dirtyKeys, form, session, sessionId, defaultAskTimeoutMs, hydrated])

  // Best-effort дофлаш отложенного (debounce) сохранения при размонтировании/смене
  // сессии, чтобы не потерять последний ввод.
  useEffect(() => {
    return () => {
      const flush = pendingSaveRef.current
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      pendingSaveRef.current = null
      flush?.()
    }
  }, [sessionId])

  // Гидратация формы: только при смене сессии или глобального дефолта таймаута — иначе
  // любое обновление объекта сессии (WS-события, наше же сохранение) затирало бы
  // несохранённые правки.

  useEffect(() => {
    if (!session || !session.settings) return
    if (
      hydratedRef.current?.id === session.id
      && hydratedRef.current?.defaultMs === defaultAskTimeoutMs
    ) {
      return
    }
    hydratedRef.current = { id: session.id, defaultMs: defaultAskTimeoutMs }

    // Провайдер/модель живут в общем сторе — не сбрасываем, если в сессии не заданы.
    const sp = session.settings.provider as string | undefined
    const sm = session.settings.model as string | undefined
    if (sp) setSelectedProvider(sp)
    if (sm) setSelectedModel(sm)

    // Остальные поля заполняем безусловно (отсутствующие → дефолт), чтобы форма точно
    // отражала session.settings.
    applyFormValues(formValuesFromSettings(session.settings, defaultAskTimeoutMs))
    // Публикуем гидратацию как state — гейт автосохранения зафиксируется вместе с
    // закоммиченными значениями формы (см. комментарий у `hydrated`).
    setHydrated({ id: session.id, defaultMs: defaultAskTimeoutMs })
  }, [session, defaultAskTimeoutMs, setSelectedProvider, setSelectedModel, applyFormValues])

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
    if (!sessionId) return
    const key = `mcp:${server.name}`
    if (isPending(key)) return
    await run({
      key,
      run: () => synthApi.updateSessionMcp(sessionId, { name: server.name, enabled: !server.enabled }),
      onSuccess: (r) => {
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
      },
    })
  }

  /** AD-046 §4.5: точечный toggle скилла в сессии (`{ name, enabled }`). */
  const handleToggleSkill = async (skill: EffectiveSkillEntry) => {
    if (!sessionId) return
    const key = `skill:${skill.name}`
    if (isPending(key)) return
    await run({
      key,
      run: () => synthApi.updateSessionSkills(sessionId, { name: skill.name, enabled: !skill.enabled }),
      onSuccess: (r) => {
        setSessionSkills(r.skills)
        const current = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
        if (current) {
          useSessionsStore.getState().upsertSession({
            ...current,
            settings: {
              ...(current.settings as Record<string, unknown>),
              skills: r.enabled,
              skillsDisabled: r.disabled,
            },
          } as typeof current)
        }
      },
    })
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
    await run({
      key: `permission:${rule.tool}:${rule.path ?? ''}`,
      run: () => synthApi.updateSession(sessionId, {
        settings: { ...session.settings, permission: nextPermission },
      }),
      onSuccess: (updated) => useSessionsStore.getState().upsertSession(updated),
    })
  }

  /** AD-071 §2.3: метка наследования — «Глобальная (<короткое имя>)», фоллбек — «Глобальная». */
  const inheritLabel = (prefix: 'toolsPolicy' | 'mcpPolicy', value: ToolsPolicy | null) =>
    value
      ? t(`${prefix}.inherit`, { policy: t(`policy.short.${value}`) })
      : t(`${prefix}.inheritUnknown`)

  if (!session) {
    return (
      <PanelTab>
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          {t('rightPanel.params.noSessions')}
        </div>
      </PanelTab>
    )
  }

  return (
    <PanelTab>
        <Section title={t('rightPanel.params.session')}>
          <Field
            label={t('rightPanel.params.name')}
            valueNode={
              <button
                type="button"
                data-testid="session-edit-trigger"
                onClick={() => useEntityEditStore.getState().openEntityEdit({
                  kind: 'session',
                  id: session.id,
                  name: session.name || session.id,
                  icon: session.icon ?? null,
                  color: session.color ?? null,
                })}
                title={t('leftPanel.editSession')}
                className="inline-flex min-w-0 items-center justify-end gap-1.5 rounded-md px-1 py-0.5 align-middle transition-colors hover:bg-interactive-hover"
              >
                <Icon
                  name={resolveIconName(session.icon) ?? (session.session_origin === 'subagent' ? 'cpu' : 'chat-new')}
                  className="size-4 shrink-0"
                  style={{ color: resolveIconColor(session.color) ?? DEFAULT_SESSION_ICON_COLOR }}
                />
                <span className="min-w-0 break-words">{session.name || t('rightPanel.params.none')}</span>
              </button>
            }
          />
          <Field label="ID" value={session.id} mono />
          <Field label={t('rightPanel.params.project')} value={projectName || session.project_id || t('rightPanel.params.none')} />
          <Field label={t('rightPanel.params.creator')} value={session.user_id || session.owner_id || t('rightPanel.params.none')} />
          <Field label={t('rightPanel.params.created')} value={formatDateTime(session.created_at, locale)} />
          <Field label={t('rightPanel.params.engine')} value={session.engine} />
        </Section>

        <Section title={t('sessionTab.todos.title')}>
          <SessionTodosBlock todos={session.todos} />
        </Section>

        {/* AD-069 §9.3: прозрачность проектных инструкций (AGENTS.md chain/sources) */}
        <Section title={t('sessionTab.instructions.title')}>
          <ProjectInstructions sessionId={session.id} />
        </Section>

        <Section title={t('sessionSettings.providerModel')}>
          <ModelSelector sessionId={sessionId} alwaysShowLabel />
        </Section>

        {/* Таймаут подтверждения (ask) */}
        <Section title={t('sessionSettings.askTimeout')}>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle
              enabled={askTimeoutEnabled}
              onToggle={() => {
                if (!askTimeoutEnabled && (Number(askTimeoutSec) || 0) <= 0) {
                  // 0 = «без таймаута»: при включении подставляем глобальный дефолт,
                  // иначе «включено с 0 секунд» эквивалентно выключенному состоянию.
                  setAskTimeoutSec(String(Math.round(defaultAskTimeoutMs / 1000) || 30))
                }
                setAskTimeoutEnabled(!askTimeoutEnabled)
              }}
              pending={isFieldPending('askTimeoutEnabled')}
            />
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
            <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
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
            <Toggle enabled={microFirst} onToggle={() => setMicroFirst(!microFirst)} pending={isFieldPending('microFirst')} />
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
            <div className="text-[0.625rem] text-muted-foreground/60">
              {t('sessionSettings.micro.embeddingHint')}
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <Toggle enabled={embeddingEnabled} onToggle={() => setEmbeddingEnabled(!embeddingEnabled)} pending={isFieldPending('embeddingEnabled')} />
              <span className="text-xs text-foreground">
                {embeddingEnabled ? t('common.enabled') : t('common.disabled')}
              </span>
            </label>
            {embeddingEnabled && (
              <div>
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
              <Toggle enabled={routingEnabled} onToggle={() => setRoutingEnabled(!routingEnabled)} pending={isFieldPending('routingEnabled')} />
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
                    <Toggle enabled={routingEscalationEnabled} onToggle={() => setRoutingEscalationEnabled(!routingEscalationEnabled)} pending={isFieldPending('routingEscalationEnabled')} />
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
                    <Toggle enabled={routingCostEnabled} onToggle={() => setRoutingCostEnabled(!routingCostEnabled)} pending={isFieldPending('routingCostEnabled')} />
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
                    <Toggle enabled={routingSubagentEnabled} onToggle={() => setRoutingSubagentEnabled(!routingSubagentEnabled)} pending={isFieldPending('routingSubagentEnabled')} />
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
            <Toggle enabled={debugEnabled} onToggle={() => setDebugEnabled(!debugEnabled)} pending={isFieldPending('debugEnabled')} />
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
                  <ExpandableListRow
                    key={srv.name}
                    testId={`session-mcp-${srv.name}`}
                    name={srv.name}
                    badges={
                      <RowBadge tone="neutral">{t(`rightPanel.stats.mcpLevel.${srv.level}`)}</RowBadge>
                    }
                    aside={
                      <label className="flex items-center gap-1">
                        <Toggle
                          enabled={srv.enabled}
                          onToggle={() => handleToggleMcp(srv)}
                          disabled={srv.reason === 'system_disabled' || srv.reason === 'project_disabled'}
                          pending={isPending(`mcp:${srv.name}`)}
                          ariaLabel={srv.enabled ? t('mcp.disable') : t('mcp.enable')}
                        />
                      </label>
                    }
                    details={
                      srv.enabled
                        ? t(`rightPanel.stats.mcpStatus.${srv.status ?? 'connected'}`)
                        : `${t('rightPanel.stats.mcpStatus.disabled')}${srv.reason ? ` · ${t(`rightPanel.stats.mcpReason.${srv.reason}`)}` : ''}`
                    }
                  />
                ))}
              </div>
            )}
            <p className="text-[0.625rem] text-muted-foreground/60">{t('sessionSettings.mcp.hint')}</p>
          </Section>
        )}

        {(sessionSkills.length > 0 || skillsLoading) && (
          <Section title={t('sessionSettings.skills.title')}>
            {skillsLoading && sessionSkills.length === 0 ? (
              <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
            ) : (
              <div className="flex flex-col gap-1.5" data-testid="session-skills-list">
                {sessionSkills.map((skill) => (
                  <ExpandableListRow
                    key={skill.name}
                    testId={`session-skill-${skill.name}`}
                    name={skill.name}
                    badges={
                      <>
                        <RowBadge tone="neutral">{t(`skills.scope.${skill.scope}`)}</RowBadge>
                        <RowBadge tone="neutral">{t(`skills.level.${skill.level}`)}</RowBadge>
                        {!skill.trusted && <RowBadge tone="danger">{t('skills.untrusted')}</RowBadge>}
                        {!skill.available && <RowBadge tone="muted">{t('skills.unavailable')}</RowBadge>}
                      </>
                    }
                    aside={
                      <label className="flex items-center gap-1">
                        <Toggle
                          enabled={skill.enabled}
                          onToggle={() => handleToggleSkill(skill)}
                          disabled={skill.disabledReason === 'system' || skill.disabledReason === 'project'}
                          pending={isPending(`skill:${skill.name}`)}
                          ariaLabel={skill.enabled ? t('sessionSettings.skills.disable') : t('sessionSettings.skills.enable')}
                        />
                      </label>
                    }
                    details={
                      <div className="flex flex-col gap-0.5">
                        {skill.description && <span>{skill.description}</span>}
                        <span>
                          {skill.disabled
                            ? `${t('sessionSettings.skills.disabled')}${skill.disabledReason ? ` · ${t(`sessionSettings.skills.disabledReason.${skill.disabledReason}`)}` : ''}`
                            : skill.enabled
                              ? t('sessionSettings.skills.enabled')
                              : t('sessionSettings.skills.notEnabled')}
                        </span>
                      </div>
                    }
                  />
                ))}
              </div>
            )}
            <p className="text-[0.625rem] text-muted-foreground/60">{t('sessionSettings.skills.hint')}</p>
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
                { value: '', label: inheritLabel('toolsPolicy', globalToolsPolicy) },
                { value: 'consistency', label: t('policy.short.consistency') },
                { value: 'available', label: t('policy.short.available') },
                { value: 'auto', label: t('policy.short.auto') },
              ]}
            >
              <SelectContent>
                <SelectItem value="">{inheritLabel('toolsPolicy', globalToolsPolicy)}</SelectItem>
                <SelectItem value="consistency">{t('policy.short.consistency')}</SelectItem>
                <SelectItem value="available">{t('policy.short.available')}</SelectItem>
                <SelectItem value="auto">{t('policy.short.auto')}</SelectItem>
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
                { value: '', label: inheritLabel('mcpPolicy', globalMcpPolicy) },
                { value: 'consistency', label: t('policy.short.consistency') },
                { value: 'available', label: t('policy.short.available') },
                { value: 'auto', label: t('policy.short.auto') },
              ]}
            >
              <SelectContent>
                <SelectItem value="">{inheritLabel('mcpPolicy', globalMcpPolicy)}</SelectItem>
                <SelectItem value="consistency">{t('policy.short.consistency')}</SelectItem>
                <SelectItem value="available">{t('policy.short.available')}</SelectItem>
                <SelectItem value="auto">{t('policy.short.auto')}</SelectItem>
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

    </PanelTab>
  )
}

const TODO_STATUS_STYLES: Record<TodoStatus, { labelKey: string; className: string }> = {
  pending: { labelKey: 'sessionTab.todo.status.pending', className: 'bg-muted text-muted-foreground' },
  in_progress: { labelKey: 'sessionTab.todo.status.in_progress', className: 'bg-status-info/15 text-status-info' },
  completed: { labelKey: 'sessionTab.todo.status.completed', className: 'bg-status-success/15 text-status-success' },
  cancelled: { labelKey: 'sessionTab.todo.status.cancelled', className: 'bg-destructive/10 text-destructive line-through' },
}

const TODO_PRIORITY_STYLES: Record<TodoPriority, { labelKey: string; className: string }> = {
  high: { labelKey: 'sessionTab.todo.priority.high', className: 'text-status-error' },
  medium: { labelKey: 'sessionTab.todo.priority.medium', className: 'text-status-warning' },
  low: { labelKey: 'sessionTab.todo.priority.low', className: 'text-muted-foreground' },
}

function SessionTodosBlock({ todos }: { todos?: TodoItem[] | null }) {
  const { t } = useI18n()

  if (!todos || todos.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-inset px-3 py-2">
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

