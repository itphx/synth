import React, { useEffect, useState, useMemo } from 'react'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import type { ProjectStats } from '@/lib/api/synthApi'

export const StatsTab: React.FC = () => {
  const { t } = useI18n()
  const { sessions } = useSessionsStore()
  const { projects } = useProjectsStore()
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null)

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const activeSessionId = activeTab?.data?.sessionId
  const { messagesBySession } = useChatStore()

  const sessionMessages = activeSessionId ? messagesBySession[activeSessionId] || [] : []
  const sessionTokens = useMemo(() => ({
    input: sessionMessages.reduce((sum, m) => sum + ((m.usage?.input_tokens) || 0), 0),
    output: sessionMessages.reduce((sum, m) => sum + ((m.usage?.output_tokens) || 0), 0),
  }), [sessionMessages])

  // Автовыбор первого проекта
  useEffect(() => {
    if (!activeProjectId && projects.length > 0) {
      setActiveProjectId(projects[0].id)
    }
  }, [projects, activeProjectId])

  useEffect(() => {
    if (activeProjectId) {
      synthApi.getProjectStats(activeProjectId).then(setProjectStats).catch(() => {})
    }
  }, [activeProjectId])

  const projectSessions = sessions.filter((s) => s.project_id === activeProjectId)
  const totalInput = projectSessions.reduce((sum, s) => sum + (s.input_tokens || 0), 0)
  const totalOutput = projectSessions.reduce((sum, s) => sum + (s.output_tokens || 0), 0)
  const totalTokens = totalInput + totalOutput
  const totalMessages = projectSessions.reduce((sum, s) => sum + (s.messages?.length || 0), 0)

  return (
    <div className="flex flex-col gap-3 p-3">
      {projects.length > 1 && (
        <select
          value={activeProjectId || ''}
          onChange={(e) => setActiveProjectId(e.target.value)}
          className="rounded bg-interactive px-2 py-1 text-sm text-foreground outline-none"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      <div>
        <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('rightPanel.stats.projectStats')}
        </h4>
        <div className="space-y-2">
          <StatRow label={t('rightPanel.stats.sessions')} value={projectStats?.total_sessions ?? projectSessions.length} />
          <StatRow label={t('rightPanel.stats.inputTokens')} value={projectStats?.total_input_tokens ?? totalInput} />
          <StatRow label={t('rightPanel.stats.outputTokens')} value={projectStats?.total_output_tokens ?? totalOutput} />
          <StatRow label={t('rightPanel.stats.totalTokens')} value={projectStats?.total_tokens ?? totalTokens} />
          <StatRow label={t('rightPanel.stats.messages')} value={projectStats?.total_messages ?? totalMessages} />
        </div>
      </div>

      {activeSessionId && (
        <div>
          <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('rightPanel.stats.activeSession')}
          </h4>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Icon name="arrow-right" className="size-3 rotate-180 text-blue-400" />
              {sessionTokens.input.toLocaleString()}
            </span>
            <span className="flex items-center gap-1">
              <Icon name="arrow-right" className="size-3 text-green-400" />
              {sessionTokens.output.toLocaleString()}
            </span>
            <span className="text-[10px] tabular-nums">
              = {(sessionTokens.input + sessionTokens.output).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {projectSessions.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('rightPanel.stats.sessions')}
          </h4>
          <div className="space-y-1.5">
            {projectSessions.map((s) => (
              <div key={s.id} className="rounded bg-interactive px-2 py-1 text-xs">
                <div className="truncate text-foreground">{s.id.slice(0, 20)}</div>
                <div className="text-muted-foreground">
                  {t('rightPanel.stats.tokens')}: {s.total_tokens || 0}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {projects.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-4">
          {t('rightPanel.stats.noData')}
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  )
}
