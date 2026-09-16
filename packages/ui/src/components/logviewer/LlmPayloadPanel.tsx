import { useEffect, useState, useCallback } from 'react'
import { synthApi, type LlmPayloadEntry, type SessionData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'

const LIMIT_OPTIONS = [50, 100, 200, 500]
const MAX_CONTENT = 3000

/** Единый стиль select/input в logviewer (как в GatewaySettings). */
const CONTROL_CLASS =
  'rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

function formatTime(ts: string): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString()
}

function formatUsage(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): string {
  if (!usage) return '—'
  return `${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}`
}

/** Моноширинный блок с обрезкой длинного контента (кнопка «показать всё»). */
function ContentBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const truncated = content.length > MAX_CONTENT && !expanded
  const shown = truncated ? content.slice(0, MAX_CONTENT) : content

  return (
    <div className="space-y-1">
      <pre className="bg-muted/40 rounded-lg p-2 overflow-auto text-[0.6875rem] leading-relaxed font-mono whitespace-pre-wrap break-all text-foreground">
        {shown}
        {truncated && '…'}
      </pre>
      {content.length > MAX_CONTENT && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[0.6875rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {expanded ? 'свернуть' : 'показать всё'}
        </button>
      )}
    </div>
  )
}

/** Панель «Запросы/ответы LLM»: полный лог обмена с моделями (после обфускации). */
export const LlmPayloadPanel = () => {
  const { t } = useI18n()
  const [sessionId, setSessionId] = useState('')
  const [limit, setLimit] = useState(50)
  const [sessions, setSessions] = useState<SessionData[]>([])
  const [entries, setEntries] = useState<LlmPayloadEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    synthApi
      .getSessions()
      .then((data) => {
        if (cancelled) return
        setSessions([...new Map(data.map((s) => [s.id, s])).values()])
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async (sid: string, lim: number) => {
    setLoading(true)
    setError(null)
    try {
      const data = await synthApi.getLlmPayloads({
        sessionId: sid.trim() || undefined,
        limit: lim,
      })
      setEntries(data.entries)
      setTotal(data.total)
      setExpandedId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('logs.error'))
      setEntries([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [t])

  // Первичная загрузка при монтировании (фильтры применяются кнопкой «Применить»)
  useEffect(() => {
    load(sessionId, limit)
  }, [])

  const handleApply = () => {
    load(sessionId, limit)
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h3 className="text-lg font-semibold">{t('logs.llm.title')}</h3>
        <p className="text-muted-foreground text-sm mt-1">{t('logs.llm.description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.session')}
          <select
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className={`${CONTROL_CLASS} max-w-56`}
          >
            <option value="">— {t('logs.audit.all')} —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.name || s.id}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.limit')}
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className={CONTROL_CLASS}
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>

        <button
          onClick={handleApply}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-foreground bg-interactive-selection hover:bg-interactive-hover transition-colors disabled:opacity-50"
        >
          <Icon name="search" className="size-4" />
          {t('logs.audit.apply')}
        </button>

        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{total}</span>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading && !error ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-1.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 bg-muted rounded w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground text-sm">
          {t('logs.llm.noEntries')}
        </div>
      ) : (
        <div className="space-y-2 overflow-auto max-h-[60vh] pr-1">
          {entries.map((e, idx) => {
            const open = expandedId === idx
            return (
              <div key={`${e.ts}-${idx}`} className="bg-background rounded-xl border">
                <button
                  onClick={() => setExpandedId(open ? null : idx)}
                  className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs"
                >
                  <span className="text-muted-foreground tabular-nums">{formatTime(e.ts)}</span>
                  <span className="font-medium">
                    {e.provider || '—'}
                    {e.model && <span className="text-muted-foreground"> / {e.model}</span>}
                  </span>
                  <span className="font-mono text-muted-foreground">{e.sessionId ?? '—'}</span>
                  <span className="text-muted-foreground tabular-nums">{formatUsage(e.response.usage)}</span>
                  <span className="ml-auto">
                    <Icon name={open ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 text-muted-foreground" />
                  </span>
                </button>

                {open && (
                  <div className="border-t border-border px-3 py-3 space-y-3 text-xs">
                    <div className="space-y-1.5">
                      <div className="font-medium text-muted-foreground">{t('logs.llm.request')}</div>
                      {e.request.systemPrompt && (
                        <div className="space-y-0.5">
                          <div className="text-muted-foreground">system</div>
                          <ContentBlock content={e.request.systemPrompt} />
                        </div>
                      )}
                      {e.request.messages.map((m, mi) => (
                        <div key={mi} className="space-y-0.5">
                          <div className="text-muted-foreground">{m.role}</div>
                          <ContentBlock content={typeof m.content === 'string' ? m.content : JSON.stringify(m.content)} />
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1.5">
                      <div className="font-medium text-muted-foreground">{t('logs.llm.response')}</div>
                      <ContentBlock content={e.response.content} />
                    </div>
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
