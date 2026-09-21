import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { SettingsPanel, SettingsSection } from '../ui/settings'

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
    <SettingsPanel
      title={t('admin.sessions.title')}
      description={t('admin.sessions.count', { count: sessions.length })}
      actions={
        <Button variant="ghost" onClick={load}>
          <Icon name="refresh" className="size-3.5" />
          {t('admin.sessions.refresh')}
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-48 mb-2" />
              <div className="h-3 bg-muted rounded w-32" />
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">{t('admin.sessions.empty')}</p>
        </SettingsSection>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const isBlocked = !!s.status.blocked
            const isExpanded = expandedId === s.id

            return (
              <SettingsSection key={s.id} className="p-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={cn(
                        'size-2 rounded-full shrink-0',
                        isBlocked ? 'bg-status-error' : 'bg-status-success',
                      )} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <code className="text-xs font-mono text-muted-foreground truncate">
                            {s.id.slice(0, 12)}...
                          </code>
                          <span className={cn(
                            'px-1.5 py-0.5 rounded text-[0.625rem] font-medium',
                            isBlocked
                              ? 'bg-status-error/15 text-status-error'
                              : 'bg-secondary text-muted-foreground',
                          )}>
                            {isBlocked ? t('admin.sessions.blocked') : '—'}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1">
                          <span>{t('admin.sessions.messageCount', { count: s.messages?.length || 0 })}</span>
                          <span>IN: {s.input_tokens || 0}</span>
                          <span>OUT: {s.output_tokens || 0}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      >
                        {isExpanded ? t('admin.sessions.hide') : t('admin.sessions.details')}
                      </Button>
                      {isBlocked && (
                        <Button
                          variant="ghost"
                          onClick={() => handleUnlock(s.id)}
                          className="bg-status-warning/15 text-status-warning hover:bg-status-warning/25"
                        >
                          {t('admin.sessions.unlock')}
                        </Button>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-border px-4 py-3 bg-surface-subtle space-y-2 text-xs min-w-0 break-words">
                      <div><span className="text-muted-foreground">{t('admin.sessions.id')}</span> <code>{s.id}</code></div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.engine')}</span> {s.engine}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.project')}</span> {s.project_id || '—'}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.created')}</span> {new Date(s.created_at).toLocaleString('ru')}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.updated')}</span> {new Date(s.updated_at).toLocaleString('ru')}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.pending')}</span> {s.pending_messages?.length || 0}</div>
                      {isBlocked && (
                        <div className="text-status-error">
                          <span className="text-muted-foreground">{t('admin.sessions.blockedStatus')}</span> {s.status.blocked}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </SettingsSection>
            )
          })}
        </div>
      )}
    </SettingsPanel>
  )
}
