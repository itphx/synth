import { useEffect, useState, useCallback } from 'react'
import { synthApi, type AuditEntry } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

const AUDIT_TYPES = ['obfuscated', 'blocked', 'revealed', 'rate_limited', 'output_guard'] as const
const LIMIT_OPTIONS = [50, 100, 200, 500]

const TYPE_COLORS: Record<string, string> = {
  obfuscated: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
  blocked: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  revealed: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  rate_limited: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  output_guard: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
}

interface AuditFilters {
  type: string
  userId: string
  sessionId: string
  since: string
  until: string
  limit: number
}

const DEFAULT_FILTERS: AuditFilters = {
  type: '',
  userId: '',
  sessionId: '',
  since: '',
  until: '',
  limit: 100,
}

/** Преобразует значение datetime-local ("YYYY-MM-DDTHH:mm") в ISO, или undefined. */
function toIso(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function formatTime(ts: string): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString()
}

function formatCost(costUsd?: number): string {
  if (costUsd === undefined || costUsd === null) return '—'
  return `$${costUsd.toFixed(6)}`
}

/** Панель «Журнал аудита» (AD-036): события LLM Gateway с фильтрами. */
export const AuditLogPanel = () => {
  const { t } = useI18n()
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (f: AuditFilters) => {
    setLoading(true)
    setError(null)
    try {
      const data = await synthApi.getAudit({
        userId: f.userId.trim() || undefined,
        sessionId: f.sessionId.trim() || undefined,
        since: toIso(f.since),
        until: toIso(f.until),
        limit: f.limit,
      })
      const typed = f.type ? data.entries.filter((e) => e.type === f.type) : data.entries
      setEntries(typed)
      setTotal(f.type ? typed.length : data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('logs.error'))
      setEntries([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [t])

  // Мгновенная перезагрузка при смене select'ов (тип события и лимит)
  useEffect(() => {
    load(filters)
  }, [filters.type, filters.limit])

  const handleApply = () => {
    load(filters)
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h3 className="text-lg font-semibold">{t('logs.audit.title')}</h3>
        <p className="text-muted-foreground text-sm mt-1">{t('logs.audit.description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.type')}
          <select
            value={filters.type}
            onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
            className="bg-interactive-selection border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">—</option>
            {AUDIT_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.user')}
          <input
            type="text"
            value={filters.userId}
            onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))}
            className="w-32 rounded-lg bg-interactive-selection border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.session')}
          <input
            type="text"
            value={filters.sessionId}
            onChange={(e) => setFilters((f) => ({ ...f, sessionId: e.target.value }))}
            className="w-36 rounded-lg bg-interactive-selection border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.since')}
          <input
            type="datetime-local"
            value={filters.since}
            onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value }))}
            className="rounded-lg bg-interactive-selection border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.until')}
          <input
            type="datetime-local"
            value={filters.until}
            onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value }))}
            className="rounded-lg bg-interactive-selection border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.audit.limit')}
          <select
            value={filters.limit}
            onChange={(e) => setFilters((f) => ({ ...f, limit: Number(e.target.value) }))}
            className="bg-interactive-selection border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 bg-muted rounded w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground text-sm">
          {t('logs.audit.noEntries')}
        </div>
      ) : (
        <div className="bg-background rounded-xl border overflow-auto max-h-[60vh]">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.time')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.type')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.user')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.session')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.placeholder')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.provider')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">in/out</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.cost')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.audit.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, idx) => (
                <tr key={`${e.ts}-${idx}`} className="border-t border-border align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums">{formatTime(e.ts)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', TYPE_COLORS[e.type] || 'bg-muted text-muted-foreground')}>
                      {e.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{e.userId ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono">{e.sessionId ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono">{e.placeholder ?? (e.placeholders?.join(', ') ?? '—')}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {e.provider || e.model ? (
                      <>
                        {e.provider && <span>{e.provider}</span>}
                        {e.model && <span className="text-muted-foreground"> / {e.model}</span>}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {e.tokensIn !== undefined || e.tokensOut !== undefined
                      ? `${e.tokensIn ?? 0}/${e.tokensOut ?? 0}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatCost(e.costUsd)}</td>
                  <td className="px-3 py-2 min-w-[140px] text-muted-foreground">{e.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
