import React, { Fragment, useEffect, useState, useMemo } from 'react'
import type { SessionStats } from '@itphx/synth-shared'
import { cn, resolveColor, userColor } from '@/lib/utils'
import { useChatStore, selectLiveSubagentUsage } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useSkillsStore } from '@/stores/skillsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cacheHitPct, cacheHitRate, formatCost, formatCostMap, formatDuration, formatTokens, formatTps, DEFAULT_CHARS_PER_TOKEN } from '@/lib/formatStats'
import { buildUsageSegments } from '@/lib/statsSegments'
import { readMessageSubagents } from '@/lib/subagentStats'
import type { ProjectStats, ModelGroup, PromptInfoResponse, SessionMcpEffectiveResponse, SessionSkillsResponse, EffectiveSkillEntry } from '@/lib/api/synthApi'
import type { PromptToolDetail, McpServerEffective } from '@itphx/synth-shared'
import { PanelTab } from './PanelTab'

/** Фолбэк контекстного окна, если у модели не задано своё. */
const DEFAULT_CONTEXT_WINDOW = 200_000
/** Порог предупреждения «контекст близко к лимиту», %. */
const CONTEXT_NEAR_LIMIT_PCT = 90

function dash(v: number | undefined, format: (v: number) => string): string {
  if (v === undefined) return '\u2014'
  return format(v)
}

/** Сумма двух возможно-undefined значений: undefined, только если оба не заданы. */
function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

/** C2b: добавляет стоимость в валютную карту; отсутствующая валюта → USD. */
function addCost(map: Record<string, number>, value: number | undefined, currency?: string): void {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return
  const key = currency || 'USD'
  map[key] = (map[key] ?? 0) + value
}

/** C2b: сливает мультивалютную карту в целевую (без смешивания валют). */
function addCostMap(target: Record<string, number>, map?: Record<string, number>): void {
  if (!map) return
  for (const [currency, value] of Object.entries(map)) addCost(target, value, currency)
}

/**
 * C2b: карта стоимости по валютам. Если `cost_by_currency` нет/пуста (старые
 * данные) — fallback на `cost_usd` как USD.
 */
function costMapOrFallback(
  map: Record<string, number> | undefined,
  costUsd: number | undefined,
): Record<string, number> | undefined {
  const hasValue = !!map && Object.values(map).some((v) => Number.isFinite(v) && v > 0)
  if (hasValue) return map
  if (costUsd !== undefined) return { USD: costUsd }
  return undefined
}

/** Округлённый процент из доли 0..1 (для серверных `cache_hit_rate`). */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/** AD-070 §2.5: подпись hit/miss последнего хода (из `promptMeta`). */
function promptCacheLabel(
  info: PromptInfoResponse,
  t: (key: string) => string,
  format: (v: number) => string,
): string {
  const meta = info.lastPromptMeta
  if (!meta) return '\u2014'
  const verdict = meta.expected === 'hit'
    ? t('rightPanel.stats.promptHit')
    : t('rightPanel.stats.promptMiss')
  const cached = meta.cachedTokens > 0 ? ` · ${format(meta.cachedTokens)}` : ''
  return `${verdict} · gen ${meta.generation}${cached}`
}

/**
 * AD-071 §2.6: подпись доступности встроенного тула. В режиме `available`
 * недоступные тулы не уходят в запрос — помечаем их как скрытые; в
 * `consistency` показываем причину (переключить режим / делегировать роли).
 */
function toolAvailabilityLabel(
  tool: PromptToolDetail,
  toolsPolicy: string | undefined,
  t: (key: string) => string,
): string {
  if (tool.available) return t('rightPanel.stats.toolAvailable')
  if (toolsPolicy === 'available') return t('rightPanel.stats.toolHidden')
  if (tool.reason === 'role') return t('rightPanel.stats.toolUnavailableRole')
  if (tool.reason === 'mode') return t('rightPanel.stats.toolUnavailableMode')
  if (tool.reason === 'dependency') return t('rightPanel.stats.toolUnavailableDependency')
  return t('rightPanel.stats.toolUnavailable')
}

/** AD-071 §2.6: подпись доступности MCP-сервера (disabled + причина). */
function mcpAvailabilityLabel(server: McpServerEffective, t: (key: string) => string): string {
  if (server.enabled) return t('rightPanel.stats.toolAvailable')
  if (!server.reason) return t('rightPanel.stats.mcpDisabled')
  const reason = t(`rightPanel.stats.mcpReason.${server.reason}`)
  return `${t('rightPanel.stats.mcpDisabled')} · ${reason}`
}

/** AD-046 §9.3: подпись доступности скилла (capability-aware). */
function skillAvailabilityLabel(skill: EffectiveSkillEntry, t: (key: string) => string): string {
  return skill.available ? t('rightPanel.stats.toolAvailable') : t('rightPanel.stats.toolUnavailable')
}

/** AD-046 §9.3: подпись «включён в сессии» (disabled + причина). */
function skillEnabledLabel(skill: EffectiveSkillEntry, t: (key: string) => string): string {
  if (!skill.disabled) return t('rightPanel.stats.skillEnabled')
  if (!skill.disabledReason) return t('rightPanel.stats.mcpDisabled')
  return `${t('rightPanel.stats.mcpDisabled')} · ${t(`rightPanel.stats.skillDisabledReason.${skill.disabledReason}`)}`
}

/**
 * AD-046 §9.3: источник записи скилла — `session` (включён/выключен в сессии),
 * `project` (гейт проекта) или `stable` (системный каталог промпта).
 */
function skillSourceLabel(skill: EffectiveSkillEntry, t: (key: string) => string): string {
  if (skill.level === 'session' || skill.disabledReason === 'session') {
    return t('rightPanel.stats.skillSource.session')
  }
  if (skill.disabledReason === 'project') return t('rightPanel.stats.skillSource.project')
  return t('rightPanel.stats.skillSource.stable')
}

/**
 * AD-046 §9.3: локальная оценка вклада скилла в каталог промпта —
 * строка `name` + `description`. `~` — оценка, ratio берётся из манифеста.
 */
function skillTokenEstimate(
  skill: EffectiveSkillEntry,
  ratio: number | undefined,
  format: (v: number) => string,
): string {
  const chars = skill.name.length + skill.description.length
  const est = Math.ceil(chars / (ratio ?? DEFAULT_CHARS_PER_TOKEN))
  return `~${format(est)}`
}

/**
 * AD-071 §2.6: оценка токенов. `~` — оценка без калибровки (`ratio` = дефолт
 * chars-per-token), без `~` — калиброванный ratio модели. Пусто → прочерк.
 */
function tokenEstimate(
  estTokens: number | undefined,
  ratio: number | undefined,
  format: (v: number) => string,
): string {
  if (estTokens === undefined) return '\u2014'
  const calibrated = ratio !== undefined && ratio !== DEFAULT_CHARS_PER_TOKEN
  return `${calibrated ? '' : '~'}${format(estTokens)}`
}

/** Тултип-пояснение к оценке токенов: символы и применённый ratio. */
function tokenEstimateTitle(
  estTokens: number | undefined,
  ratio: number | undefined,
  chars: number | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | undefined {
  if (estTokens === undefined) return undefined
  return t('rightPanel.stats.tokenEstimate', {
    tokens: estTokens,
    chars: chars ?? 0,
    ratio: ratio ?? DEFAULT_CHARS_PER_TOKEN,
  })
}

/** Паттерн сворачивания (как у «Состава промпта»/«Истории»). */
function ExpandToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
      <span>{expanded ? t('rightPanel.stats.collapse') : t('rightPanel.stats.expand')}</span>
    </button>
  )
}

export const StatsTab: React.FC = () => {
  const { t, locale } = useI18n()
  const fmt = (v: number): string => v.toLocaleString(locale)
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null)
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])
  const [promptInfo, setPromptInfo] = useState<PromptInfoResponse | null>(null)
  const [mcpEffective, setMcpEffective] = useState<SessionMcpEffectiveResponse | null>(null)
  const [skillsEffective, setSkillsEffective] = useState<SessionSkillsResponse | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  // AD-071 §2.6: таблицы инструментов и MCP свёрнуты по умолчанию (как промпт/история).
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [mcpExpanded, setMcpExpanded] = useState(false)
  // AD-046 §9.3: таблица скиллов и счётчики команд.
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const [commandsExpanded, setCommandsExpanded] = useState(false)

  // AD-046 §8.2: счётчики вызовов из событий skill.invoked / command.invoked.
  const skillInvocationCounts = useSkillsStore((s) => s.skillInvocationCounts)
  const commandInvocationCounts = useSkillsStore((s) => s.commandInvocationCounts)
  const lastSkillInvocation = useSkillsStore((s) => s.lastSkillInvocation)
  const lastCommandInvocation = useSkillsStore((s) => s.lastCommandInvocation)

  const toolsDisabledTick = useUIStore((s) => s.toolsDisabledTick)

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const activeSessionId = activeTab?.data?.sessionId
  const messagesBySession = useChatStore((s) => s.messagesBySession)
  // Сигнал завершения стрима (успех/отмена/ошибка): `finishStream` часто
  // обновляет существующее assistant-сообщение без смены id, поэтому
  // `lastAssistantMsg?.id` не гарантирует перезапрос статистики.
  const streamFinishTick = useChatStore((s) =>
    activeSessionId ? s.streamFinishTickBySession[activeSessionId] ?? 0 : 0,
  )
  const sessions = useSessionsStore((s) => s.sessions)
  const agents = useAgentsStore((s) => s.agents)

  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined

  const sessionMessages = activeSessionId ? messagesBySession[activeSessionId] || [] : []

  const lastAssistantMsg = useMemo(() => {
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      const m = sessionMessages[i]!
      if (m.role === 'assistant' && !m.disabled && !m.hidden) return m
    }
    return null
  }, [sessionMessages])

  // AD-070 §2.6 (live): активный стрим сессии — источник live-значений
  // «Последнего ответа» и дельты секции «Сессия». `finishStream`/`cancelStream`
  // удаляют StreamState и сбрасывают live-сабагентов, поэтому после завершения
  // панель автоматически возвращается к серверным/сообщенческим значениям.
  const activeStream = useChatStore((s) => {
    if (!activeSessionId) return undefined
    const streams = s.streamingBySession[activeSessionId]
    if (!streams) return undefined
    return Object.values(streams).find((st) => st.isStreaming)
  })
  const liveSubagent = useChatStore(selectLiveSubagentUsage(activeSessionId ?? ''))

  useEffect(() => {
    synthApi.getModels().then(setModelGroups).catch(() => {})
  }, [])

  const sessionModelId = (activeSession?.settings as Record<string, unknown>)?.model as string | undefined

  const contextWindowModel = useMemo(() => {
    const all = modelGroups.flatMap((g) => g.models)
    return all.find((m) => m.id === sessionModelId)
  }, [modelGroups, sessionModelId])

  const contextWindowMax = contextWindowModel?.context_window ?? DEFAULT_CONTEXT_WINDOW

  const sessionProjectId = activeSession?.project_id

  // AD-070 §2.6: скорость/длительность/стоимость последнего ответа из metadata.
  const lastDurationMs = typeof lastAssistantMsg?.metadata?.duration_ms === 'number'
    ? lastAssistantMsg.metadata.duration_ms
    : undefined
  const lastCostUsd = typeof lastAssistantMsg?.metadata?.cost_usd === 'number'
    ? lastAssistantMsg.metadata.cost_usd
    : undefined
  // C2b: валюта стоимости последнего ответа (metadata.cost_currency; C2a).
  const lastCostCurrency = typeof lastAssistantMsg?.metadata?.cost_currency === 'string'
    ? lastAssistantMsg.metadata.cost_currency
    : undefined
  const lastOutputTokens = lastAssistantMsg?.usage?.output_tokens
  const lastTps = lastDurationMs && lastDurationMs > 0 && typeof lastOutputTokens === 'number'
    ? lastOutputTokens / (lastDurationMs / 1000)
    : undefined
  // Bug 4 (AD-070 §2.6): usage мог быть оценён при отмене/сбое — помечаем `~`.
  const lastTokenPrefix = lastAssistantMsg?.metadata?.usage_estimated === true ? '~' : ''

  // AD-070 §2.6 (live): если активный стрим уже отдал usage — «Последний ответ»
  // берёт значения из него, иначе из последнего assistant-сообщения. Оценка
  // (`usageEstimated`) помечается `~`; точный usage оценкой не подменяется.
  const liveStreamUsage = activeStream?.usage
  const hasLiveUsage = !!liveStreamUsage && Object.keys(liveStreamUsage).length > 0
  const displayUsage = hasLiveUsage ? liveStreamUsage : lastAssistantMsg?.usage
  const displayCostUsd = hasLiveUsage ? activeStream?.costUsd : lastCostUsd
  const displayCostCurrency = hasLiveUsage ? activeStream?.costCurrency : lastCostCurrency
  const displayTokenPrefix = hasLiveUsage ? (activeStream?.usageEstimated ? '~' : '') : lastTokenPrefix
  const displayModel = activeStream?.model ?? lastAssistantMsg?.model
  // Пока стрим активен, длительность/скорость ответа ещё не финализированы.
  const displayDurationMs = hasLiveUsage ? undefined : lastDurationMs
  const displayTps = hasLiveUsage ? undefined : lastTps

  const displayInputTokens = displayUsage?.input_tokens ?? 0
  const windowPercent = contextWindowMax > 0 ? (displayInputTokens / contextWindowMax) * 100 : 0
  // Предупреждение только при реальном окне модели (не фолбэк 200_000)
  const hasRealContextWindow = !!contextWindowModel?.context_window && contextWindowModel.context_window > 0
  const isContextNearLimit = hasRealContextWindow && windowPercent >= CONTEXT_NEAR_LIMIT_PCT

  // AD-070 §2.6 (live): компактная live-строка стрима — тот же билдер сегментов,
  // что у StreamingPlaceholder/MessageStats.
  const liveSegments = activeStream
    ? buildUsageSegments(
        {
          usage: activeStream.usage,
          costUsd: activeStream.costUsd,
          costCurrency: activeStream.costCurrency,
          tokenPrefix: activeStream.usageEstimated ? '~' : '',
        },
        t,
      )
    : []

  useEffect(() => {
    if (sessionProjectId) {
      synthApi.getProjectStats(sessionProjectId).then(setProjectStats).catch(() => {})
    } else {
      setProjectStats(null)
    }
  }, [sessionProjectId, streamFinishTick])

  // AD-070 §2.5: состав системного промпта (read-only). Обновляем при смене
  // сессии и после каждого нового ответа (меняется promptMeta).
  useEffect(() => {
    if (!activeSessionId) {
      setPromptInfo(null)
      return
    }
    let cancelled = false
    synthApi.getSessionPrompt(activeSessionId)
      .then((info) => { if (!cancelled) setPromptInfo(info) })
      .catch(() => { if (!cancelled) setPromptInfo(null) })
    return () => { cancelled = true }
  }, [activeSessionId, lastAssistantMsg?.id, streamFinishTick, toolsDisabledTick])

  // AD-071 §2.4/§2.6: эффективный MCP-скоуп сессии (включая отключённые с
  // причиной) — для таблицы «MCP» рядом с «Составом промпта». Тот же триггер.
  useEffect(() => {
    if (!activeSessionId) {
      setMcpEffective(null)
      return
    }
    let cancelled = false
    synthApi.getSessionMcpEffective(activeSessionId)
      .then((info) => { if (!cancelled) setMcpEffective(info) })
      .catch(() => { if (!cancelled) setMcpEffective(null) })
    return () => { cancelled = true }
  }, [activeSessionId, lastAssistantMsg?.id, streamFinishTick, toolsDisabledTick])

  // AD-046 §4.5/§9.3: эффективный per-session скоуп скиллов для таблицы «Скиллы».
  useEffect(() => {
    if (!activeSessionId) {
      setSkillsEffective(null)
      return
    }
    let cancelled = false
    Promise.resolve()
      .then(() => synthApi.getSessionSkills(activeSessionId))
      .then((info) => { if (!cancelled) setSkillsEffective(info) })
      .catch(() => { if (!cancelled) setSkillsEffective(null) })
    return () => { cancelled = true }
  }, [activeSessionId, lastAssistantMsg?.id, streamFinishTick, toolsDisabledTick])

  // AD-070 §2.6: статистика по агентам/авторам. Тот же триггер, что и у промпта.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionStats(null)
      return
    }
    let cancelled = false
    synthApi.getSessionStats(activeSessionId)
      .then((stats) => { if (!cancelled) setSessionStats(stats) })
      .catch(() => { if (!cancelled) setSessionStats(null) })
    return () => { cancelled = true }
  }, [activeSessionId, lastAssistantMsg?.id, streamFinishTick])

  // AD-070 §2.5: порядок записей задаёт бэкенд (реальный порядок отправки:
  // тир → order, tools — последним). UI не пересортировывает.
  const promptEntries = promptInfo?.manifest.entries ?? []

  // AD-071 §2.6: данные таблиц «Встроенные инструменты» и «MCP».
  const toolsDetail = promptInfo?.toolsDetail ?? []
  // Admin-disabled тулы не уходят в запрос — в таблице состава их не показываем.
  const visibleTools = toolsDetail.filter((tool) => !tool.adminDisabled)
  const toolsPolicy = promptInfo?.manifest.toolsPolicy
  const mcpServers = mcpEffective?.servers ?? []

  // AD-046 §9.3: скиллы сессии + блочные размеры каталога из манифеста.
  const skillsList = skillsEffective?.skills ?? []
  const skillsCatalogEntries = promptEntries.filter(
    (entry) => entry.key === 'skills.catalog' || entry.key === 'skills.catalog.session',
  )
  const skillsCatalogTokens = skillsCatalogEntries.reduce((sum, entry) => sum + entry.estTokens, 0)
  const manifestRatio = promptInfo?.manifest.ratio

  // AD-046 §8.2: счётчики вызовов команд/скиллов из стора.
  const commandCounterRows = Object.entries(commandInvocationCounts).sort((a, b) => b[1] - a[1])
  const skillCounterRows = Object.entries(skillInvocationCounts).sort((a, b) => b[1] - a[1])
  const hasInvocations = commandCounterRows.length > 0
    || skillCounterRows.length > 0
    || lastCommandInvocation !== null
    || lastSkillInvocation !== null

  const hasLastMsgUsage = !!displayUsage && Object.keys(displayUsage).length > 0
  const hasSubagents = !!sessionStats?.agents.some((a) => a.subagent_sessions > 0)
  // AD-070 §2.6: блок сабагентов в «Последнем ответе» — из статистики самого
  // последнего сообщения (metadata.subagents), а не сессионной сводки: иначе он
  // висит и после ответов без сабагентов.
  const lastSubagents = readMessageSubagents(lastAssistantMsg?.metadata)
  const hasLastSubagents = !!lastSubagents && lastSubagents.sessions > 0

  // AD-070 §2.6 (live): live-вклад саб-агентов родителя (subagent.progress).
  const liveSubUsage = liveSubagent?.usage
  const hasLiveSubagents = !!liveSubUsage
    && (liveSubUsage.input_tokens > 0 || liveSubUsage.output_tokens > 0)
  const hasLiveStream = !!activeStream && (!!activeStream.usage || !!activeStream.agentRole)

  // AD-070 §2.6: суммы секции «Сессия» включают сабагентов (sessionStats.subagents)
  // и live-дельту активного стрима/сабагентов. Live-значения ещё не в хранилище,
  // поэтому сложение не даёт задвоения; после завершения стрима live сбрасывается.
  const sessionSub = sessionStats?.subagents
  const liveInput = (liveStreamUsage?.input_tokens || 0) + (liveSubUsage?.input_tokens || 0)
  const liveOutput = (liveStreamUsage?.output_tokens || 0) + (liveSubUsage?.output_tokens || 0)
  const liveCacheRead = sumDefined(liveStreamUsage?.cache_read_tokens, liveSubUsage?.cache_read_tokens)
  const liveCacheWrite = sumDefined(liveStreamUsage?.cache_write_tokens, liveSubUsage?.cache_write_tokens)
  const liveReasoning = sumDefined(liveStreamUsage?.reasoning_tokens, liveSubUsage?.reasoning_tokens)
  const hasLiveCost = (activeStream?.costUsd ?? 0) > 0 || (liveSubagent?.costUsd ?? 0) > 0

  const sessionInput = (activeSession?.input_tokens || 0) + (sessionSub?.input_tokens || 0) + liveInput
  const sessionOutput = (activeSession?.output_tokens || 0) + (sessionSub?.output_tokens || 0) + liveOutput
  const sessionCacheRead = sumDefined(
    sumDefined(activeSession?.cache_read_tokens, sessionSub?.cache_read_tokens),
    liveCacheRead,
  )
  const sessionCacheWrite = sumDefined(
    sumDefined(activeSession?.cache_write_tokens, sessionSub?.cache_write_tokens),
    liveCacheWrite,
  )
  const sessionReasoning = sumDefined(
    sumDefined(activeSession?.reasoning_tokens, sessionSub?.reasoning_tokens),
    liveReasoning,
  )
  const sessionHitPct = sessionStats
    ? cacheHitPct(sessionCacheRead, sessionInput)
    : Math.round((activeSession?.cache_hit_rate ?? cacheHitRate(sessionCacheRead, sessionInput)) * 100)
  const hasSessionSubagents = !!sessionSub && sessionSub.sessions > 0

  // AD-070 §2.6 / C2b: стоимость сессии — раздельные суммы по валютам (не
  // арифметика разных валют). Серверные агенты уже включают сабагентов; live-
  // дельта текущего стрима/сабагентов добавляется в свою валюту.
  const serverSessionCostMap = useMemo(() => {
    if (!sessionStats || sessionStats.agents.length === 0) return undefined
    const map: Record<string, number> = {}
    for (const agent of sessionStats.agents) {
      const src = costMapOrFallback(agent.cost_by_currency, agent.cost_usd)
      if (!src) continue
      for (const [currency, value] of Object.entries(src)) addCost(map, value, currency)
    }
    return map
  }, [sessionStats])
  const hasSessionCost = serverSessionCostMap !== undefined || hasLiveCost
  const sessionCostMap: Record<string, number> = { ...(serverSessionCostMap ?? {}) }
  addCost(sessionCostMap, activeStream?.costUsd, activeStream?.costCurrency)
  // C2b: live-сабагенты — разбивка по валютам; при её отсутствии (старые
  // данные) — одиночный costUsd/costCurrency.
  if (liveSubagent?.costByCurrency) addCostMap(sessionCostMap, liveSubagent.costByCurrency)
  else addCost(sessionCostMap, liveSubagent?.costUsd, liveSubagent?.costCurrency)

  return (
    <PanelTab>
      {hasLastMsgUsage && (
        <Section title={t('rightPanel.stats.lastAnswer')}>
          {activeStream && (liveSegments.length > 0 || displayModel) && (
            <div
              data-testid="stats-live"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-muted-foreground tabular-nums"
            >
              <span className="inline-flex items-center gap-1 text-primary">
                <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                {t('rightPanel.stats.live')}
              </span>
              {displayModel && <span className="text-foreground">{displayModel}</span>}
              {liveSegments.map((segment, i) => (
                <Fragment key={i}>
                  {i > 0 && <span aria-hidden="true">·</span>}
                  <span>{segment}</span>
                </Fragment>
              ))}
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('rightPanel.stats.contextWindow')}</span>
              <span className="tabular-nums">
                {fmt(displayInputTokens)} / {fmt(contextWindowMax)} ({Math.round(windowPercent)}%)
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-foreground/10">
              <div
                className={cn('h-2 rounded-full transition-[width,background-color] duration-150 ease-out', isContextNearLimit ? 'bg-destructive' : 'bg-primary')}
                style={{ width: `${Math.min(windowPercent, 100)}%` }}
              />
            </div>
            {isContextNearLimit && (
              <div className="text-[0.6875rem] text-destructive">
                {t('rightPanel.stats.contextNearLimit')}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={`${displayTokenPrefix}${fmt(displayInputTokens)}`} />
            <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={`${displayTokenPrefix}${fmt(displayUsage!.output_tokens)}`} />
            <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(displayUsage!.cache_read_tokens, fmt)} />
            <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(displayUsage!.cache_write_tokens, fmt)} />
            <div className="col-span-2">
              <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(displayUsage!.reasoning_tokens, fmt)} />
            </div>
            <div className="col-span-2">
              <StatCell
                icon="line-chart"
                color="text-teal-400"
                label={t('rightPanel.stats.cacheHitRate')}
                value={`${cacheHitPct(displayUsage!.cache_read_tokens, displayInputTokens)}%`}
              />
            </div>
            {displayTps !== undefined && (
              <StatCell icon="rocket" color="text-orange-400" label={t('rightPanel.stats.speed')} value={formatTps(displayTps)} />
            )}
            {displayDurationMs !== undefined && (
              <StatCell icon="time" color="text-sky-400" label={t('rightPanel.stats.duration')} value={formatDuration(displayDurationMs)} />
            )}
            {displayCostUsd !== undefined && (
              <div className="col-span-2">
                <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCost(displayCostUsd, displayCostCurrency)} />
              </div>
            )}
          </div>

          {hasLastSubagents && (
            <div className="border-t border-border/40 pt-3 space-y-1">
              <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                <Icon name="user-3" className="size-3 shrink-0" />
                <span>{t('rightPanel.stats.subagentsTitle')}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <StatCell icon="chat-new" color="text-cyan-400" label={t('rightPanel.stats.subagentsSessions')} value={fmt(lastSubagents!.sessions)} />
                <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={formatTokens(lastSubagents!.input_tokens)} />
                <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={formatTokens(lastSubagents!.output_tokens)} />
                <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={formatTokens(lastSubagents!.cache_read_tokens)} />
                <div className="col-span-2">
                  <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCostMap(lastSubagents!.cost_by_currency, lastSubagents!.cost_usd)} />
                </div>
              </div>
              <div className="text-[0.6875rem] text-muted-foreground">
                {t('rightPanel.stats.subagentsNote')}
              </div>
            </div>
          )}
        </Section>
      )}

      {!hasLastMsgUsage && (
        <div className="text-sm text-muted-foreground text-center py-2">
          {t('rightPanel.stats.noData')}
        </div>
      )}

      <Section title={t('rightPanel.stats.session')}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={fmt(sessionInput)} />
          <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={fmt(sessionOutput)} />
          <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(sessionCacheRead, fmt)} />
          <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(sessionCacheWrite, fmt)} />
          <div className="col-span-2">
            <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(sessionReasoning, fmt)} />
          </div>
          <div className="col-span-2">
            <StatCell
              icon="line-chart"
              color="text-teal-400"
              label={t('rightPanel.stats.cacheHitRate')}
              value={`${sessionHitPct}%`}
            />
          </div>
          {hasSessionCost && (
            <div className="col-span-2">
              <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCostMap(sessionCostMap, 0)} />
            </div>
          )}
          {hasSessionSubagents && (
            <div className="col-span-2 text-[0.6875rem] text-muted-foreground">
              {t('rightPanel.stats.subagentsIncluded')}:{' '}
              {formatTokens(sessionSub!.input_tokens)} {t('chat.messageStats.in')} ·{' '}
              {formatTokens(sessionSub!.output_tokens)} {t('chat.messageStats.out')}
            </div>
          )}
          {hasLiveSubagents && (
            <div
              data-testid="stats-session-live-subagents"
              className="col-span-2 flex flex-wrap items-center gap-x-1.5 text-[0.6875rem] text-muted-foreground tabular-nums"
            >
              <span className="inline-flex items-center gap-1 text-primary">
                <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                {t('rightPanel.stats.subagentsTitle')}:
              </span>
              <span>{formatTokens(liveSubUsage!.input_tokens)} {t('chat.messageStats.in')}</span>
              <span aria-hidden="true">·</span>
              <span>{formatTokens(liveSubUsage!.output_tokens)} {t('chat.messageStats.out')}</span>
              {liveSubagent!.costUsd !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatCostMap(liveSubagent!.costByCurrency, liveSubagent!.costUsd)}</span>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('rightPanel.stats.promptComposition')}>
        {promptInfo ? (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <StatCell
                icon="database-2"
                color="text-amber-400"
                label={t('rightPanel.stats.promptTotal')}
                value={`${fmt(promptInfo.manifest.totalChars)}\n~${fmt(promptInfo.manifest.estTokens)}`}
              />
              <StatCell
                icon="server"
                color="text-purple-400"
                label={t('rightPanel.stats.promptStaticPrefix')}
                value={fmt(promptInfo.manifest.staticPrefixChars)}
              />
              <div className="col-span-2">
                <StatCell
                  icon="line-chart"
                  color="text-teal-400"
                  label={t('rightPanel.stats.promptCache')}
                  value={promptCacheLabel(promptInfo, t, fmt)}
                />
              </div>
            </div>
            <ExpandToggle expanded={promptExpanded} onToggle={() => setPromptExpanded((v) => !v)} />
            {promptExpanded && (
              <div className="overflow-x-auto">
                <table className="w-full text-[0.6875rem]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTier')}</th>
                      <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.promptColKey')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColChars')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTokens')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promptEntries.map((entry) => {
                      const labelKey = `rightPanel.stats.promptBlock.${entry.key}`
                      const translated = t(labelKey)
                      return (
                        <tr
                          key={entry.key}
                          className={cn(
                            'border-t border-border/30',
                            entry.status !== 'loaded' && 'text-muted-foreground/60',
                          )}
                          title={entry.provenance || undefined}
                        >
                          <td className="px-2 py-0.5 text-center">{t(`rightPanel.stats.promptTier.${entry.tier}`)}</td>
                          <td className="px-2 py-0.5 text-left truncate max-w-[8rem]">
                            {translated === labelKey ? entry.label : translated}
                          </td>
                          <td className="px-2 py-0.5 text-center tabular-nums">{fmt(entry.chars)}</td>
                          <td className="px-2 py-0.5 text-center tabular-nums">{fmt(entry.estTokens)}</td>
                          <td className="px-2 py-0.5 text-center">{t(`rightPanel.stats.promptStatus.${entry.status}`)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-muted-foreground italic">
            {t('rightPanel.stats.noData')}
          </div>
        )}
      </Section>

      {/* AD-071 §2.6: встроенные инструменты — имя/capability/доступность/токены/источник.
          Свёрнуты по умолчанию (как «Состав промпта»); admin-disabled не показываем. */}
      <Section title={t('rightPanel.stats.builtinTools')}>
        {toolsDetail.length > 0 ? (
          visibleTools.length > 0 ? (
            <>
              <ExpandToggle expanded={toolsExpanded} onToggle={() => setToolsExpanded((v) => !v)} />
              {toolsExpanded && (
                <div className="overflow-x-auto" data-testid="stats-builtin-tools">
                  <table className="w-full text-[0.6875rem]">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="px-2 py-0.5 text-left font-medium first:pl-0">{t('rightPanel.stats.colTool')}</th>
                        <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.colCapability')}</th>
                        <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colAvailable')}</th>
                        <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTokens')}</th>
                        <th className="px-2 py-0.5 text-center font-medium last:pr-0">{t('rightPanel.stats.colSource')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTools.map((tool) => (
                        <tr
                          key={tool.name}
                          data-testid={`stats-tool-${tool.name}`}
                          className={cn('border-t border-border/30', !tool.available && 'text-muted-foreground/60')}
                        >
                          <td className="px-2 py-0.5 text-left max-w-[8rem] truncate first:pl-0" title={tool.name}>{tool.name}</td>
                          <td className="px-2 py-0.5 text-left max-w-[8rem] truncate" title={tool.capabilities.join(', ')}>
                            {tool.capabilities.join(', ') || '\u2014'}
                          </td>
                          <td className="px-2 py-0.5 text-center">{toolAvailabilityLabel(tool, toolsPolicy, t)}</td>
                          <td
                            className="px-2 py-0.5 text-center tabular-nums"
                            title={tokenEstimateTitle(tool.estTokens, tool.ratio, tool.chars, t)}
                          >
                            {tokenEstimate(tool.estTokens, tool.ratio, fmt)}
                          </td>
                          <td className="px-2 py-0.5 text-center last:pr-0">{tool.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noData')}</div>
          )
        ) : (
          <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noData')}</div>
        )}
      </Section>

      {/* AD-071 §2.6: MCP — сервер/уровень/статус/доступность/тулы/токены/автор.
          Показываются все серверы, включая отключённые (disabled + причина).
          Свёрнуто по умолчанию; при раскрытии — агрегат по серверу и строки тулов. */}
      <Section title={t('rightPanel.stats.mcpServers')}>
        {mcpServers.length > 0 ? (
          <>
            <ExpandToggle expanded={mcpExpanded} onToggle={() => setMcpExpanded((v) => !v)} />
            {mcpExpanded && (
              <div className="overflow-x-auto" data-testid="stats-mcp-servers">
                <table className="w-full text-[0.6875rem]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-0.5 text-left font-medium first:pl-0">{t('rightPanel.stats.colServer')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colLevel')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colStatus')}</th>
                      <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.colAvailable')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colTools')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTokens')}</th>
                      <th className="px-2 py-0.5 text-left font-medium last:pr-0">{t('rightPanel.stats.colAuthor')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mcpServers.map((server) => {
                      const status = server.status
                        ?? (server.enabled ? (server.connected ? 'connected' : 'error') : 'disabled')
                      return (
                        <Fragment key={server.name}>
                          <tr
                            data-testid={`stats-mcp-${server.name}`}
                            className={cn('border-t border-border/30', !server.enabled && 'text-muted-foreground/60')}
                          >
                            <td className="px-2 py-0.5 text-left max-w-[7rem] truncate first:pl-0" title={server.name}>{server.name}</td>
                            <td className="px-2 py-0.5 text-center">{t(`rightPanel.stats.mcpLevel.${server.level}`)}</td>
                            <td className="px-2 py-0.5 text-center">{t(`rightPanel.stats.mcpStatus.${status}`)}</td>
                            <td className="px-2 py-0.5 text-left">{mcpAvailabilityLabel(server, t)}</td>
                            <td
                              className="px-2 py-0.5 text-center tabular-nums"
                              title={server.tools && server.tools.length > 0 ? server.tools.join(', ') : undefined}
                            >
                              {server.tools?.length ?? 0}
                            </td>
                            <td
                              className="px-2 py-0.5 text-center tabular-nums"
                              title={tokenEstimateTitle(server.estTokens, server.ratio, server.chars, t)}
                            >
                              {tokenEstimate(server.estTokens, server.ratio, fmt)}
                            </td>
                            <td className="px-2 py-0.5 text-left max-w-[7rem] truncate last:pr-0">{server.author?.username ?? '\u2014'}</td>
                          </tr>
                          {server.toolDetails?.map((tool) => (
                            <tr
                              key={`${server.name}:${tool.name}`}
                              data-testid={`stats-mcp-tool-${server.name}-${tool.name}`}
                              className={cn('text-muted-foreground/80', tool.adminDisabled && 'line-through opacity-60')}
                            >
                              <td className="px-2 py-0.5 text-left first:pl-0" colSpan={5}>
                                <span className="pl-3 font-mono truncate inline-block max-w-[10rem]" title={tool.name}>
                                  {'\u2514'} {tool.name}
                                </span>
                              </td>
                              <td
                                className="px-2 py-0.5 text-center tabular-nums"
                                title={tokenEstimateTitle(tool.estTokens, tool.ratio, tool.chars, t)}
                              >
                                {tokenEstimate(tool.estTokens, tool.ratio, fmt)}
                              </td>
                              <td className="px-2 py-0.5 last:pr-0" />
                            </tr>
                          ))}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noData')}</div>
        )}
      </Section>

      {/* AD-046 §4.5/§9.3: скиллы — имя/scope-уровень/доступность/включение/
          причина/trust/вклад в каталог/источник. Включая отключённые (disabled + причина). */}
      <Section title={t('rightPanel.stats.skills')}>
        {skillsList.length > 0 ? (
          <>
            <ExpandToggle expanded={skillsExpanded} onToggle={() => setSkillsExpanded((v) => !v)} />
            {skillsExpanded && (
              <div className="overflow-x-auto space-y-1" data-testid="stats-skills">
                <table className="w-full text-[0.6875rem]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-0.5 text-left font-medium first:pl-0">{t('rightPanel.stats.colSkill')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colLevel')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colAvailable')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colEnabled')}</th>
                      <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.colUnavailable')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colTrusted')}</th>
                      <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTokens')}</th>
                      <th className="px-2 py-0.5 text-left font-medium last:pr-0">{t('rightPanel.stats.colSource')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillsList.map((skill: EffectiveSkillEntry) => (
                      <tr
                        key={skill.name}
                        data-testid={`stats-skill-${skill.name}`}
                        className={cn('border-t border-border/30', !skill.enabled && 'text-muted-foreground/60')}
                      >
                        <td className="px-2 py-0.5 text-left max-w-[8rem] truncate first:pl-0" title={skill.name}>{skill.name}</td>
                        <td className="px-2 py-0.5 text-center">
                          {t(`skills.scope.${skill.scope}`)} / {t(`skills.level.${skill.level}`)}
                        </td>
                        <td className="px-2 py-0.5 text-center">{skillAvailabilityLabel(skill, t)}</td>
                        <td className="px-2 py-0.5 text-center">{skillEnabledLabel(skill, t)}</td>
                        <td className="px-2 py-0.5 text-left">{skill.unavailableReason ?? '\u2014'}</td>
                        <td className="px-2 py-0.5 text-center">
                          {skill.trusted ? t('rightPanel.stats.trusted') : t('skills.untrusted')}
                        </td>
                        <td
                          className="px-2 py-0.5 text-center tabular-nums"
                          title={t('rightPanel.stats.skillTokenEstimate', {
                            tokens: Math.ceil((skill.name.length + skill.description.length) / (manifestRatio ?? DEFAULT_CHARS_PER_TOKEN)),
                            chars: skill.name.length + skill.description.length,
                            ratio: manifestRatio ?? DEFAULT_CHARS_PER_TOKEN,
                          })}
                        >
                          {skillTokenEstimate(skill, manifestRatio, fmt)}
                        </td>
                        <td className="px-2 py-0.5 text-left last:pr-0">
                          {skillSourceLabel(skill, t)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {skillsCatalogEntries.length > 0 && (
                  <div className="text-[0.625rem] text-muted-foreground/60">
                    {t('rightPanel.stats.skillsCatalogTokens', { tokens: fmt(skillsCatalogTokens) })}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noData')}</div>
        )}
      </Section>

      {/* AD-046 §8.2/§9.3: счётчики вызовов команд и скиллов из событий. */}
      <Section title={t('rightPanel.stats.commands')}>
        {hasInvocations ? (
          <>
            <ExpandToggle expanded={commandsExpanded} onToggle={() => setCommandsExpanded((v) => !v)} />
            {commandsExpanded && (
              <div className="space-y-2" data-testid="stats-invocations">
                {lastCommandInvocation && (
                  <div className="text-xs" data-testid="stats-last-command">
                    {t('rightPanel.stats.lastCommand')}:{' '}
                    <span className="font-mono">/{lastCommandInvocation.command}</span>
                    {lastCommandInvocation.actor ? ` · ${lastCommandInvocation.actor}` : ''}
                  </div>
                )}
                {lastSkillInvocation && (
                  <div className="text-xs" data-testid="stats-last-skill">
                    {t('rightPanel.stats.lastSkill')}:{' '}
                    <span className="font-mono">{lastSkillInvocation.name}</span>
                    {lastSkillInvocation.source ? ` · ${lastSkillInvocation.source}` : ''}
                  </div>
                )}
                {commandCounterRows.length > 0 && (
                  <div data-testid="stats-command-invocations">
                    <div className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {t('rightPanel.stats.commandsCounters')}
                    </div>
                    <ul className="mt-0.5 space-y-0.5">
                      {commandCounterRows.map(([name, count]) => (
                        <li key={name} className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-mono truncate">/{name}</span>
                          <span className="tabular-nums text-muted-foreground">{fmt(count)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {skillCounterRows.length > 0 && (
                  <div data-testid="stats-skill-invocations">
                    <div className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {t('rightPanel.stats.skillsCounters')}
                    </div>
                    <ul className="mt-0.5 space-y-0.5">
                      {skillCounterRows.map(([name, count]) => (
                        <li key={name} className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-mono truncate">{name}</span>
                          <span className="tabular-nums text-muted-foreground">{fmt(count)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noInvocations')}</div>
        )}
      </Section>

      {promptInfo && (
        <Section title={t('rightPanel.stats.history')}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <StatCell
              icon="chat-new"
              color="text-blue-400"
              label={t('rightPanel.stats.historyMessages')}
              value={fmt(promptInfo.history.messages.count)}
            />
            <StatCell
              icon="file-text"
              color="text-amber-400"
              label={t('rightPanel.stats.promptColChars')}
              value={fmt(promptInfo.history.messages.chars)}
            />
            <div className="col-span-2">
              <StatCell
                icon="line-chart"
                color="text-teal-400"
                label={t('rightPanel.stats.promptColTokens')}
                value={`~${fmt(promptInfo.history.messages.estTokens)}`}
              />
            </div>
          </div>
          <ExpandToggle expanded={historyExpanded} onToggle={() => setHistoryExpanded((v) => !v)} />
          {historyExpanded && (
            <div className="overflow-x-auto space-y-2">
              <table className="w-full text-[0.6875rem]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.historyColType')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.historyColCount')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColChars')}</th>
                    <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.promptColTokens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {promptInfo.history.stateMessages.map((state) => (
                    <tr key={state.type} className="border-t border-border/30">
                      <td className="px-2 py-0.5 text-left truncate max-w-[8rem]">{state.type}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums">{fmt(state.count)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums">{fmt(state.chars)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums">{fmt(state.estTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="space-y-0.5 text-[0.6875rem] text-muted-foreground">
                <div className="flex items-center justify-between gap-2">
                  <span>{t('rightPanel.stats.historyExcluded')}</span>
                  <span className="tabular-nums">
                    {t('rightPanel.stats.historyDisabled')} {promptInfo.history.excluded.disabled} ·{' '}
                    {t('rightPanel.stats.historyHidden')} {promptInfo.history.excluded.hidden} ·{' '}
                    {t('rightPanel.stats.historyInfo')} {promptInfo.history.excluded.info}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>{t('rightPanel.stats.historyAttachments')}</span>
                  <span className="tabular-nums">
                    {fmt(promptInfo.history.attachments.count)} / {fmt(promptInfo.history.attachments.chars)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>{t('rightPanel.stats.historySecrets')}</span>
                  <span className="tabular-nums">{fmt(promptInfo.history.secretPlaceholders)}</span>
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      {(hasLiveStream || hasLiveSubagents || (sessionStats && sessionStats.agents.length > 0)) && (
        <Section title={t('rightPanel.stats.agentsStats')}>
          {sessionStats && sessionStats.agents.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[0.6875rem]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-0.5 text-left font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.agent')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.messages')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.inputTokens')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.outputTokens')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.colCache')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.colCacheHit')}</th>
                  <th className={cn('px-2 py-0.5 font-medium first:pl-0 last:pr-0', hasSubagents ? 'text-center' : 'text-right')}>{t('rightPanel.stats.cost')}</th>
                  {hasSubagents && (
                    <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.subagents')}</th>
                  )}
                  {hasSubagents && (
                    <th className="px-2 py-0.5 text-right font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.subagentTokens')}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {sessionStats.agents.map((a) => {
                  const agent = agents.find((x) => x.id === a.agent_role)
                  const agentName = agent?.display_name || a.agent_role
                  const agentColor = resolveColor(agent?.color ?? null)
                  return (
                    <tr key={a.agent_role} className="border-t border-border/30">
                      <td className="px-2 py-0.5 text-left max-w-[8rem] first:pl-0 last:pr-0">
                        <span
                          className={cn('inline-flex items-center gap-1', !agentColor && 'text-primary')}
                          style={agentColor ? { color: agentColor } : undefined}
                        >
                          <Icon name={agent?.icon || 'user-smile'} className="size-3 shrink-0" />
                          <span className="truncate">{agentName}</span>
                        </span>
                      </td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{a.messages}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{formatTokens(a.input_tokens)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{formatTokens(a.output_tokens)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{formatTokens(a.cache_read_tokens)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{pct(a.cache_hit_rate)}</td>
                      <td className={cn('px-2 py-0.5 tabular-nums first:pl-0 last:pr-0', hasSubagents ? 'text-center' : 'text-right')}>{formatCostMap(a.cost_by_currency, a.cost_usd)}</td>
                      {hasSubagents && (
                        <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">
                          {a.subagent_sessions > 0 ? a.subagent_sessions : '\u2014'}
                        </td>
                      )}
                      {hasSubagents && (
                        <td className="px-2 py-0.5 text-right tabular-nums first:pl-0 last:pr-0">
                          {a.subagent_sessions > 0 ? formatTokens(a.subagent_tokens) : '\u2014'}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
          {(hasLiveStream || hasLiveSubagents) && (
            <div
              data-testid="stats-agents-live"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border/40 pt-2 text-[0.6875rem] text-muted-foreground tabular-nums"
            >
              <span className="inline-flex items-center gap-1 text-primary">
                <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                {t('rightPanel.stats.live')}
              </span>
              {hasLiveStream && activeStream?.agentRole && (
                <span className="text-foreground">
                  {agents.find((x) => x.id === activeStream.agentRole)?.display_name || activeStream.agentRole}
                </span>
              )}
              {hasLiveUsage && liveStreamUsage && (
                <span>
                  {formatTokens(liveStreamUsage.input_tokens)} {t('chat.messageStats.in')} ·{' '}
                  {formatTokens(liveStreamUsage.output_tokens)} {t('chat.messageStats.out')}
                </span>
              )}
              {hasLiveSubagents && (
                <span>
                  {t('rightPanel.stats.subagentsTitle')}: {formatTokens(liveSubUsage!.input_tokens)} {t('chat.messageStats.in')} ·{' '}
                  {formatTokens(liveSubUsage!.output_tokens)} {t('chat.messageStats.out')}
                </span>
              )}
            </div>
          )}
        </Section>
      )}

      {sessionStats && sessionStats.users.length > 0 && (
        <Section title={t('rightPanel.stats.usersStats')}>
          <div className="overflow-x-auto">
            <table className="w-full text-[0.6875rem]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-0.5 text-left font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.user')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.messages')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.inputTokens')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.outputTokens')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.colCache')}</th>
                  <th className="px-2 py-0.5 text-center font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.colCacheHit')}</th>
                  <th className="px-2 py-0.5 text-right font-medium first:pl-0 last:pr-0">{t('rightPanel.stats.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {sessionStats.users.map((u) => {
                  const userName = u.display_name || u.author
                  return (
                    <tr key={u.author} className="border-t border-border/30">
                      <td className="px-2 py-0.5 text-left max-w-[8rem] first:pl-0 last:pr-0">
                        <span className="inline-flex items-center gap-1" style={{ color: userColor(userName) }}>
                          <Icon name="user-3" className="size-3 shrink-0" />
                          <span className="truncate">{userName}</span>
                        </span>
                      </td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{u.messages}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{formatTokens(u.input_tokens)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{formatTokens(u.output_tokens)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{formatTokens(u.cache_read_tokens)}</td>
                      <td className="px-2 py-0.5 text-center tabular-nums first:pl-0 last:pr-0">{pct(u.cache_hit_rate)}</td>
                      <td className="px-2 py-0.5 text-right tabular-nums first:pl-0 last:pr-0">{formatCostMap(u.cost_by_currency, u.cost_usd)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title={t('rightPanel.stats.project')}>
        {projectStats ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={fmt(projectStats.total_input_tokens)} />
            <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={fmt(projectStats.total_output_tokens)} />
            <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(projectStats.total_cache_read_tokens, fmt)} />
            <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(projectStats.total_cache_write_tokens, fmt)} />
            <div className="col-span-2">
              <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(projectStats.total_reasoning_tokens, fmt)} />
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">
            {t('rightPanel.stats.noProject')}
          </div>
        )}
      </Section>
    </PanelTab>
  )
}

function StatCell({ icon, color, label, value }: { icon: string; color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon name={icon} className={`size-3 ${color} shrink-0`} />
      <span className="whitespace-pre-line text-muted-foreground">{label}</span>
      <span className="ml-auto whitespace-pre-line text-right tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </div>
  )
}
