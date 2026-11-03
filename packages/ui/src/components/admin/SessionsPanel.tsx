import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { SettingsItem, SettingsPanel, SettingsSection } from '../ui/settings'
import { notifyMessage } from '@/hooks/useNotification'

/**
 * Размер страницы списка сессий в админ-панели.
 *
 * Список сессий пагинирован на сервере (`GET /api/v2/sessions` → страница с
 * `total`/`next_offset`), поэтому панель показывает страницу и догружает
 * остальное по кнопке.
 */
const SESSIONS_PAGE_LIMIT = 50

export const SessionsPanel = () => {
  const { t, locale } = useI18n()
  const [sessions, setSessions] = useState<SessionData[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const page = await synthApi.getSessionsPage({ limit: SESSIONS_PAGE_LIMIT })
      setSessions(page.sessions ?? [])
      setTotal(typeof page.total === 'number' ? page.total : (page.sessions?.length ?? 0))
      setNextOffset(typeof page.next_offset === 'number' ? page.next_offset : null)
    } finally {
      setLoading(false)
    }
  }

  /** Догрузка следующей страницы списка (кнопка «Показать ещё»). */
  const loadMore = async () => {
    if (loadingMore || nextOffset === null) return
    setLoadingMore(true)
    try {
      const page = await synthApi.getSessionsPage({
        limit: SESSIONS_PAGE_LIMIT,
        offset: nextOffset,
      })
      const incoming = page.sessions ?? []
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id))
        return [...prev, ...incoming.filter((s) => !seen.has(s.id))]
      })
      if (typeof page.total === 'number') setTotal(page.total)
      setNextOffset(typeof page.next_offset === 'number' ? page.next_offset : null)
    } catch (err) {
      notifyMessage({
        text: `${t('common.error')}: ${err instanceof Error ? err.message : ''}`.trim(),
        type: 'error',
        category: 'error',
      })
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleUnlock = async (id: string) => {
    try {
      await synthApi.resumeQueue(id)
      await load()
    } catch (err) {
      notifyMessage({
        text: `${t('admin.sessions.unlockError')}: ${err instanceof Error ? err.message : ''}`.trim(),
        type: 'error',
        category: 'error',
        sessionId: id,
      })
    }
  }

  return (
    <SettingsPanel
      title={t('admin.sessions.title')}
      meta={t('admin.sessions.count', { count: total })}
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
        <SettingsSection>
          {sessions.map((s) => {
            const isBlocked = !!s.status.blocked
            const isExpanded = expandedId === s.id

            return (
              <SettingsItem key={s.id} className="p-0">
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
                        {/* Счётчика сообщений нет: список сессий не содержит
                            истории (она — постранично в `GET /sessions/:id/messages`). */}
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1">
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
                      <div><span className="text-muted-foreground">{t('admin.sessions.project')}</span> {s.project_id || '—'}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.created')}</span> {new Date(s.created_at).toLocaleString(locale)}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.updated')}</span> {new Date(s.updated_at).toLocaleString(locale)}</div>
                      <div><span className="text-muted-foreground">{t('admin.sessions.pending')}</span> {s.pending_messages?.length || 0}</div>
                      {isBlocked && (
                        <div className="text-status-error">
                          <span className="text-muted-foreground">{t('admin.sessions.blockedStatus')}</span> {s.status.blocked}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </SettingsItem>
            )
          })}

          {nextOffset !== null && (
            <div className="px-4 py-2">
              <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
                <Icon name="refresh" className={cn('size-3.5', loadingMore && 'animate-spin')} />
                {loadingMore ? t('admin.sessions.loadingMore') : t('admin.sessions.showMore')}
              </Button>
            </div>
          )}
        </SettingsSection>
      )}
    </SettingsPanel>
  )
}
