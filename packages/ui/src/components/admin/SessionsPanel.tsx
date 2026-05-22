import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

const TSM_COLORS: Record<string, string> = {
  planning: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  execution: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  validation: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
}

export const SessionsPanel = () => {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<SessionData[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getSessions()
      setSessions(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleUnlock = async (id: string) => {
    try {
      await fetch(`/api/v2/queue/${encodeURIComponent(id)}/resume`, {
        method: 'POST',
        credentials: 'include',
      })
      await load()
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.sessions.title')}</h3>
          <p className="text-muted-foreground text-sm">{t('admin.sessions.count', { count: sessions.length })}</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name="refresh" className="size-3.5" />
          {t('admin.sessions.refresh')}
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1,2,3].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-48 mb-2" />
              <div className="h-3 bg-muted rounded w-32" />
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          {t('admin.sessions.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const isBlocked = !!s.status.blocked
            const isExpanded = expandedId === s.id

            return (
              <div key={s.id} className="bg-background rounded-lg border overflow-hidden">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      "size-2 rounded-full shrink-0",
                      isBlocked ? "bg-red-500" : "bg-emerald-500"
                    )} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-mono text-muted-foreground truncate">
                          {s.id.slice(0, 12)}...
                        </code>
                        <span className={cn(
                          "px-1.5 py-0.5 rounded text-[10px] font-medium",
                          TSM_COLORS[s.status.state] || 'bg-slate-100 text-slate-600'
                        )}>
                          {s.status.state}
                        </span>
                        {isBlocked && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
                            {t('admin.sessions.blocked')}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-3 text-xs text-muted-foreground mt-1">
                        <span>{t('admin.sessions.messageCount', { count: s.messages?.length || 0 })}</span>
                        <span>IN: {s.input_tokens || 0}</span>
                        <span>OUT: {s.output_tokens || 0}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover"
                    >
                      {isExpanded ? t('admin.sessions.hide') : t('admin.sessions.details')}
                    </button>
                    {isBlocked && (
                      <button
                        onClick={() => handleUnlock(s.id)}
                        className="px-2 py-1 rounded text-xs bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-300"
                      >
                        {t('admin.sessions.unlock')}
                      </button>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border px-4 py-3 bg-slate-50 dark:bg-slate-900 space-y-2 text-xs">
                    <div><span className="text-muted-foreground">{t('admin.sessions.id')}</span> <code>{s.id}</code></div>
                    <div><span className="text-muted-foreground">{t('admin.sessions.engine')}</span> {s.engine}</div>
                    <div><span className="text-muted-foreground">{t('admin.sessions.project')}</span> {s.project_id || '—'}</div>
                    <div><span className="text-muted-foreground">{t('admin.sessions.created')}</span> {new Date(s.created_at).toLocaleString('ru')}</div>
                    <div><span className="text-muted-foreground">{t('admin.sessions.updated')}</span> {new Date(s.updated_at).toLocaleString('ru')}</div>
                    <div><span className="text-muted-foreground">{t('admin.sessions.pending')}</span> {s.pending_messages?.length || 0}</div>
                    {isBlocked && (
                      <div className="text-red-600 dark:text-red-400">
                        <span className="text-muted-foreground">{t('admin.sessions.blockedStatus')}</span> {s.status.blocked}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
