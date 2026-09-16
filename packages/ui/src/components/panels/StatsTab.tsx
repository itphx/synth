import React, { useEffect, useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import type { ProjectStats, ModelGroup } from '@/lib/api/synthApi'

const fmt = (v: number): string => v.toLocaleString()

function dash(v: number | undefined): string {
  if (v === undefined) return '\u2014'
  return fmt(v)
}

export const StatsTab: React.FC = () => {
  const { t } = useI18n()
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null)
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const activeSessionId = activeTab?.data?.sessionId
  const { messagesBySession } = useChatStore()
  const { sessions } = useSessionsStore()

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

  useEffect(() => {
    if (sessionProjectId) {
      synthApi.getProjectStats(sessionProjectId).then(setProjectStats).catch(() => {})
    } else {
      setProjectStats(null)
    }
  }, [sessionProjectId])

  const hasLastMsgUsage = !!(lastAssistantMsg?.usage && Object.keys(lastAssistantMsg.usage).length > 0)

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
          </div>
        </Section>
      )}

      {!hasLastMsgUsage && (
        <div className="text-sm text-muted-foreground text-center py-2">
          {t('rightPanel.stats.noData')}
        </div>
      )}

      <Section title={t('rightPanel.stats.session')}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <StatCell icon="arrow-down" color="text-blue-400" label={t('rightPanel.stats.inputTokens')} value={fmt(activeSession?.input_tokens || 0)} />
          <StatCell icon="arrow-up" color="text-green-400" label={t('rightPanel.stats.outputTokens')} value={fmt(activeSession?.output_tokens || 0)} />
          <StatCell icon="database-2" color="text-amber-400" label={t('rightPanel.stats.cacheReadTokens')} value={dash(activeSession?.cache_read_tokens)} />
          <StatCell icon="server" color="text-purple-400" label={t('rightPanel.stats.cacheWriteTokens')} value={dash(activeSession?.cache_write_tokens)} />
          <div className="col-span-2">
            <StatCell icon="brain" color="text-pink-400" label={t('rightPanel.stats.reasoningTokens')} value={dash(activeSession?.reasoning_tokens)} />
          </div>
        </div>
      </Section>

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
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto tabular-nums text-foreground">{value}</span>
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
