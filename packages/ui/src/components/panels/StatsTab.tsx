import React, { useEffect, useState, useMemo } from 'react'
import type { SessionStats } from '@itphx/synth-shared'
import { cn, resolveColor, userColor } from '@/lib/utils'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { formatCost, formatDuration, formatTokens, formatTps } from '@/lib/formatStats'
import { readMessageSubagents } from '@/lib/subagentStats'
import type { ProjectStats, ModelGroup, PromptInfoResponse } from '@/lib/api/synthApi'

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

export const StatsTab: React.FC = () => {
  const { t } = useI18n()
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null)
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])
  const [promptInfo, setPromptInfo] = useState<PromptInfoResponse | null>(null)
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

  useEffect(() => {
    synthApi.getModels().then(setModelGroups).catch(() => {})
  }, [])

  const sessionModelId = (activeSession?.settings as Record<string, unknown>)?.model as string | undefined

  const contextWindowModel = useMemo(() => {
    const all = modelGroups.flatMap((g) => g.models)
    return all.find((m) => m.id === sessionModelId)
  }, [modelGroups, sessionModelId])

  const contextWindowMax = contextWindowModel?.context_window ?? 200_000
  const lastInputTokens = lastAssistantMsg?.usage?.input_tokens ?? 0
  const windowPercent = contextWindowMax > 0 ? (lastInputTokens / contextWindowMax) * 100 : 0
  // Предупреждение только при реальном окне модели (не фолбэк 200_000)
  const hasRealContextWindow = !!contextWindowModel?.context_window && contextWindowModel.context_window > 0
  const isContextNearLimit = hasRealContextWindow && windowPercent >= 90

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

  const hasLastMsgUsage = !!(lastAssistantMsg?.usage && Object.keys(lastAssistantMsg.usage).length > 0)
  const hasSubagents = !!sessionStats?.agents.some((a) => a.subagent_sessions > 0)
  // AD-070 §2.6: блок сабагентов в «Последнем ответе» — из статистики самого
  // последнего сообщения (metadata.subagents), а не сессионной сводки: иначе он
  // висит и после ответов без сабагентов.
  const lastSubagents = readMessageSubagents(lastAssistantMsg?.metadata)
  const hasLastSubagents = !!lastSubagents && lastSubagents.sessions > 0

  // AD-070 §2.6: суммы секции «Сессия» включают сабагентов (sessionStats.subagents),
  // если сессионная статистика загружена.
  const sessionSub = sessionStats?.subagents
  const sessionInput = (activeSession?.input_tokens || 0) + (sessionSub?.input_tokens || 0)
  const sessionOutput = (activeSession?.output_tokens || 0) + (sessionSub?.output_tokens || 0)
  const sessionCacheRead = sumDefined(activeSession?.cache_read_tokens, sessionSub?.cache_read_tokens)
  const sessionCacheWrite = sumDefined(activeSession?.cache_write_tokens, sessionSub?.cache_write_tokens)
  const sessionReasoning = sumDefined(activeSession?.reasoning_tokens, sessionSub?.reasoning_tokens)
  const sessionHitRate = sessionStats
    ? hitRate(sessionCacheRead, sessionInput)
    : (activeSession?.cache_hit_rate ?? hitRate(activeSession?.cache_read_tokens, activeSession?.input_tokens))
  const hasSessionSubagents = !!sessionSub && sessionSub.sessions > 0

  return (
    <div className="flex flex-col gap-4 p-3">
      {hasLastMsgUsage && (
        <Section title={t('rightPanel.stats.lastAnswer')}>
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('rightPanel.stats.contextWindow')}</span>
              <span className="tabular-nums">
                {fmt(lastInputTokens)} / {fmt(contextWindowMax)} ({Math.round(windowPercent)}%)
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
            <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={fmt(lastInputTokens)} />
            <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={fmt(lastAssistantMsg!.usage!.output_tokens)} />
            <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(lastAssistantMsg!.usage!.cache_read_tokens)} />
            <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(lastAssistantMsg!.usage!.cache_write_tokens)} />
            <div className="col-span-2">
              <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(lastAssistantMsg!.usage!.reasoning_tokens)} />
            </div>
            <div className="col-span-2">
              <StatCell
                icon="line-chart"
                color="text-teal-400"
                label={t('rightPanel.stats.cacheHitRate')}
                value={pct(hitRate(lastAssistantMsg!.usage!.cache_read_tokens, lastInputTokens))}
              />
            </div>
            {lastTps !== undefined && (
              <StatCell icon="rocket" color="text-orange-400" label={t('rightPanel.stats.speed')} value={formatTps(lastTps)} />
            )}
            {lastDurationMs !== undefined && (
              <StatCell icon="time" color="text-sky-400" label={t('rightPanel.stats.duration')} value={formatDuration(lastDurationMs)} />
            )}
            {lastCostUsd !== undefined && (
              <div className="col-span-2">
                <StatCell icon="bar-chart-2" color="text-emerald-400" label={t('rightPanel.stats.cost')} value={formatCost(lastCostUsd)} />
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
          {hasSessionSubagents && (
            <div className="col-span-2 text-[0.6875rem] text-muted-foreground">
              {t('rightPanel.stats.subagentsIncluded')}:{' '}
              {formatTokens(sessionSub!.input_tokens)} {t('chat.messageStats.in')} ·{' '}
              {formatTokens(sessionSub!.output_tokens)} {t('chat.messageStats.out')}
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

      {sessionStats && sessionStats.agents.length > 0 && (
        <Section title={t('rightPanel.stats.agentsStats')}>
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
