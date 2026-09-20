import React, { Fragment, useEffect, useState, useMemo } from 'react'
import type { SessionStats } from '@itphx/synth-shared'
import { cn, resolveColor, userColor } from '@/lib/utils'
import { useChatStore, selectLiveSubagentUsage } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { formatCost, formatDuration, formatTokens, formatTps } from '@/lib/formatStats'
import { buildUsageSegments } from '@/lib/statsSegments'
import { readMessageSubagents } from '@/lib/subagentStats'
import type { ProjectStats, ModelGroup, PromptInfoResponse, SessionMcpEffectiveResponse } from '@/lib/api/synthApi'
import type { PromptToolDetail, McpServerEffective } from '@itphx/synth-shared'

const fmt = (v: number): string => v.toLocaleString()

function dash(v: number | undefined): string {
  if (v === undefined) return '\u2014'
  return fmt(v)
}

/** Сумма двух возможно-undefined значений: undefined, только если оба не заданы. */
function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

/** AD-070 §2.3: cache hit rate = cacheRead / input (0 при input = 0). */
function hitRate(read: number | undefined, input: number | undefined): number {
  const inp = input || 0
  if (inp <= 0) return 0
  return (read || 0) / inp
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/** AD-070 §2.5: подпись hit/miss последнего хода (из `promptMeta`). */
function promptCacheLabel(info: PromptInfoResponse, t: (key: string) => string): string {
  const meta = info.lastPromptMeta
  if (!meta) return '\u2014'
  const verdict = meta.expected === 'hit'
    ? t('rightPanel.stats.promptHit')
    : t('rightPanel.stats.promptMiss')
  const cached = meta.cachedTokens > 0 ? ` · ${meta.cachedTokens.toLocaleString()}` : ''
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
  return t('rightPanel.stats.toolUnavailable')
}

/** AD-071 §2.6: подпись доступности MCP-сервера (disabled + причина). */
function mcpAvailabilityLabel(server: McpServerEffective, t: (key: string) => string): string {
  if (server.enabled) return t('rightPanel.stats.toolAvailable')
  if (!server.reason) return t('rightPanel.stats.mcpDisabled')
  const reason = t(`rightPanel.stats.mcpReason.${server.reason}`)
  return `${t('rightPanel.stats.mcpDisabled')} · ${reason}`
}

export const StatsTab: React.FC = () => {
  const { t } = useI18n()
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null)
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])
  const [promptInfo, setPromptInfo] = useState<PromptInfoResponse | null>(null)
  const [mcpEffective, setMcpEffective] = useState<SessionMcpEffectiveResponse | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const activeSessionId = activeTab?.data?.sessionId
  const { messagesBySession } = useChatStore()
  // Сигнал завершения стрима (успех/отмена/ошибка): `finishStream` часто
  // обновляет существующее assistant-сообщение без смены id, поэтому
  // `lastAssistantMsg?.id` не гарантирует перезапрос статистики.
  const streamFinishTick = useChatStore((s) =>
    activeSessionId ? s.streamFinishTickBySession[activeSessionId] ?? 0 : 0,
  )
  const { sessions } = useSessionsStore()
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

  const contextWindowMax = contextWindowModel?.context_window ?? 200_000

  const sessionProjectId = activeSession?.project_id

  // AD-070 §2.6: скорость/длительность/стоимость последнего ответа из metadata.
  const lastDurationMs = typeof lastAssistantMsg?.metadata?.duration_ms === 'number'
    ? lastAssistantMsg.metadata.duration_ms
    : undefined
  const lastCostUsd = typeof lastAssistantMsg?.metadata?.cost_usd === 'number'
    ? lastAssistantMsg.metadata.cost_usd
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
  const displayTokenPrefix = hasLiveUsage ? (activeStream?.usageEstimated ? '~' : '') : lastTokenPrefix
  const displayModel = activeStream?.model ?? lastAssistantMsg?.model
  // Пока стрим активен, длительность/скорость ответа ещё не финализированы.
  const displayDurationMs = hasLiveUsage ? undefined : lastDurationMs
  const displayTps = hasLiveUsage ? undefined : lastTps

  const displayInputTokens = displayUsage?.input_tokens ?? 0
  const windowPercent = contextWindowMax > 0 ? (displayInputTokens / contextWindowMax) * 100 : 0
  // Предупреждение только при реальном окне модели (не фолбэк 200_000)
  const hasRealContextWindow = !!contextWindowModel?.context_window && contextWindowModel.context_window > 0
  const isContextNearLimit = hasRealContextWindow && windowPercent >= 90

  // AD-070 §2.6 (live): компактная live-строка стрима — тот же билдер сегментов,
  // что у StreamingPlaceholder/MessageStats.
  const liveSegments = activeStream
    ? buildUsageSegments(
        {
          usage: activeStream.usage,
          costUsd: activeStream.costUsd,
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
  }, [activeSessionId, lastAssistantMsg?.id, streamFinishTick])

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
  }, [activeSessionId, lastAssistantMsg?.id, streamFinishTick])

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
  const toolsPolicy = promptInfo?.manifest.toolsPolicy
  const mcpServers = mcpEffective?.servers ?? []

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
  const liveCost = (activeStream?.costUsd || 0) + (liveSubagent?.costUsd || 0)

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
  const sessionHitRate = sessionStats
    ? hitRate(sessionCacheRead, sessionInput)
    : (activeSession?.cache_hit_rate ?? hitRate(sessionCacheRead, sessionInput))
  const hasSessionSubagents = !!sessionSub && sessionSub.sessions > 0

  // AD-070 §2.6: стоимость сессии — сумма по агентам (их итоги включают
  // сабагентов) + live-дельта текущего стрима/сабагентов.
  const serverSessionCost = sessionStats && sessionStats.agents.length > 0
    ? sessionStats.agents.reduce((acc, a) => acc + (a.cost_usd || 0), 0)
    : undefined
  const hasSessionCost = serverSessionCost !== undefined || liveCost > 0
  const sessionCost = (serverSessionCost ?? 0) + liveCost

  return (
    <div className="flex flex-col gap-4 p-3">
      {hasLastMsgUsage && (
        <Section title={t('rightPanel.stats.lastAnswer')}>
          {activeStream && (liveSegments.length > 0 || displayModel) && (
            <div
              data-testid="stats-live"
              className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-muted-foreground tabular-nums"
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
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('rightPanel.stats.contextWindow')}</span>
              <span className="tabular-nums">
                {fmt(displayInputTokens)} / {fmt(contextWindowMax)} ({Math.round(windowPercent)}%)
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-foreground/10">
              <div
                className={cn('h-2 rounded-full transition-all', isContextNearLimit ? 'bg-destructive' : 'bg-primary')}
                style={{ width: `${Math.min(windowPercent, 100)}%` }}
              />
            </div>
            {isContextNearLimit && (
              <div className="mt-1 text-[0.6875rem] text-destructive">
                Лимит контекста близко
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={`${displayTokenPrefix}${fmt(displayInputTokens)}`} />
            <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={`${displayTokenPrefix}${fmt(displayUsage!.output_tokens)}`} />
            <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(displayUsage!.cache_read_tokens)} />
            <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(displayUsage!.cache_write_tokens)} />
            <div className="col-span-2">
              <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(displayUsage!.reasoning_tokens)} />
            </div>
            <div className="col-span-2">
              <StatCell
                icon="line-chart"
                color="text-teal-400"
                label={t('rightPanel.stats.cacheHitRate')}
                value={pct(hitRate(displayUsage!.cache_read_tokens, displayInputTokens))}
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
                <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCost(displayCostUsd)} />
              </div>
            )}
          </div>

          {hasLastSubagents && (
            <div className="mt-3 border-t border-border/40 pt-3">
              <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                <Icon name="user-3" className="size-3 shrink-0" />
                <span>{t('rightPanel.stats.subagentsTitle')}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <StatCell icon="chat-new" color="text-cyan-400" label={t('rightPanel.stats.subagentsSessions')} value={fmt(lastSubagents!.sessions)} />
                <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={formatTokens(lastSubagents!.input_tokens)} />
                <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={formatTokens(lastSubagents!.output_tokens)} />
                <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={formatTokens(lastSubagents!.cache_read_tokens)} />
                <div className="col-span-2">
                  <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCost(lastSubagents!.cost_usd)} />
                </div>
              </div>
              <div className="mt-1 text-[0.6875rem] text-muted-foreground">
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
          <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(sessionCacheRead)} />
          <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(sessionCacheWrite)} />
          <div className="col-span-2">
            <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(sessionReasoning)} />
          </div>
          <div className="col-span-2">
            <StatCell
              icon="line-chart"
              color="text-teal-400"
              label={t('rightPanel.stats.cacheHitRate')}
              value={pct(sessionHitRate)}
            />
          </div>
          {hasSessionCost && (
            <div className="col-span-2">
              <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCost(sessionCost)} />
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
                  <span>{formatCost(liveSubagent!.costUsd)}</span>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('rightPanel.stats.promptComposition')}>
        {promptInfo ? (
          <>
            <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
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
                  value={promptCacheLabel(promptInfo, t)}
                />
              </div>
            </div>
            <button
              type="button"
              aria-expanded={promptExpanded}
              onClick={() => setPromptExpanded((v) => !v)}
              className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icon name={promptExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
              <span>{promptExpanded ? t('rightPanel.stats.collapse') : t('rightPanel.stats.expand')}</span>
            </button>
            {promptExpanded && (
              <div className="mt-2 overflow-x-auto">
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

      {/* AD-071 §2.6: встроенные инструменты — имя/capability/доступность/источник. */}
      <Section title={t('rightPanel.stats.builtinTools')}>
        {toolsDetail.length > 0 ? (
          <div className="overflow-x-auto" data-testid="stats-builtin-tools">
            <table className="w-full text-[0.6875rem]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-0.5 text-left font-medium first:pl-0">{t('rightPanel.stats.colTool')}</th>
                  <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.colCapability')}</th>
                  <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colAvailable')}</th>
                  <th className="px-2 py-0.5 text-center font-medium last:pr-0">{t('rightPanel.stats.colSource')}</th>
                </tr>
              </thead>
              <tbody>
                {toolsDetail.map((tool) => (
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
                    <td className="px-2 py-0.5 text-center last:pr-0">{tool.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noData')}</div>
        )}
      </Section>

      {/* AD-071 §2.6: MCP — сервер/уровень/статус/доступность/тулы/автор.
          Показываются все серверы, включая отключённые (disabled + причина). */}
      <Section title={t('rightPanel.stats.mcpServers')}>
        {mcpServers.length > 0 ? (
          <div className="overflow-x-auto" data-testid="stats-mcp-servers">
            <table className="w-full text-[0.6875rem]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-0.5 text-left font-medium first:pl-0">{t('rightPanel.stats.colServer')}</th>
                  <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colLevel')}</th>
                  <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colStatus')}</th>
                  <th className="px-2 py-0.5 text-left font-medium">{t('rightPanel.stats.colAvailable')}</th>
                  <th className="px-2 py-0.5 text-center font-medium">{t('rightPanel.stats.colTools')}</th>
                  <th className="px-2 py-0.5 text-left font-medium last:pr-0">{t('rightPanel.stats.colAuthor')}</th>
                </tr>
              </thead>
              <tbody>
                {mcpServers.map((server) => {
                  const status = server.status
                    ?? (server.enabled ? (server.connected ? 'connected' : 'error') : 'disabled')
                  return (
                    <tr
                      key={server.name}
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
                      <td className="px-2 py-0.5 text-left max-w-[7rem] truncate last:pr-0">{server.author?.username ?? '\u2014'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">{t('rightPanel.stats.noData')}</div>
        )}
      </Section>

      {promptInfo && (
        <Section title={t('rightPanel.stats.history')}>
          <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
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
          <button
            type="button"
            aria-expanded={historyExpanded}
            onClick={() => setHistoryExpanded((v) => !v)}
            className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Icon name={historyExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
            <span>{historyExpanded ? t('rightPanel.stats.collapse') : t('rightPanel.stats.expand')}</span>
          </button>
          {historyExpanded && (
            <div className="mt-2 overflow-x-auto">
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
              <div className="mt-2 space-y-0.5 text-[0.6875rem] text-muted-foreground">
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
                      <td className={cn('px-2 py-0.5 tabular-nums first:pl-0 last:pr-0', hasSubagents ? 'text-center' : 'text-right')}>{formatCost(a.cost_usd)}</td>
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
              className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border/40 pt-2 text-[0.6875rem] text-muted-foreground tabular-nums"
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
                      <td className="px-2 py-0.5 text-right tabular-nums first:pl-0 last:pr-0">{formatCost(u.cost_usd)}</td>
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
            <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(projectStats.total_cache_read_tokens)} />
            <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(projectStats.total_cache_write_tokens)} />
            <div className="col-span-2">
              <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(projectStats.total_reasoning_tokens)} />
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">
            {t('rightPanel.stats.noProject')}
          </div>
        )}
      </Section>
    </div>
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
    <div className="rounded-lg border border-border bg-interactive p-3">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      {children}
    </div>
  )
}
