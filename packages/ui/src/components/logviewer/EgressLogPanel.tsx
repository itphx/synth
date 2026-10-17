import { useCallback, useEffect, useState } from 'react'
import type {
  EgressRequestLogEntry,
  EgressRequestScope,
  EgressRequestStatus,
} from '@itphx/synth-shared/types'

import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { formatDateTime } from '@/lib/formatDate'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'

const LIMIT_OPTIONS = [50, 100, 200, 500]
const SCOPES: EgressRequestScope[] = [
  'web_fetch',
  'web_search',
  'skills',
  'instructions',
  'webhooks',
  'providers',
  'mcp',
]
const STATUSES: EgressRequestStatus[] = ['allowed', 'blocked', 'error']

/** Единый стиль select в logviewer (как в AuditLogPanel). */
const CONTROL_CLASS =
  'rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

const STATUS_BADGE: Record<string, string> = {
  allowed: 'bg-status-success/15 text-status-success',
  blocked: 'bg-status-error/15 text-status-error',
  error: 'bg-status-warning/15 text-status-warning',
}

/**
 * Категория «Внешние запросы» в «Логах и аудите»: журнал egress
 * (`GET /audit/egress`, ADR-071) — вердикт, статус, длительность и причина.
 * Гейт ADMIN/AUDITOR — на уровне модала.
 */
export function EgressLogPanel() {
  const { t, locale } = useI18n()
  const [scope, setScope] = useState<EgressRequestScope | ''>('')
  const [status, setStatus] = useState<EgressRequestStatus | ''>('')
  const [limit, setLimit] = useState(100)
  const [entries, setEntries] = useState<EgressRequestLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await synthApi.getEgressLog(limit, scope || undefined, status || undefined)
      setEntries(data.entries)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('logs.egress.error'))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [limit, scope, status, t])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{t('logs.egress.title')}</h3>
          <p className="text-muted-foreground text-sm mt-1">{t('logs.egress.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" className="size-3.5" />
          {t('common.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.egress.scope')}
          <select
            data-testid="logs-egress-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as EgressRequestScope | '')}
            className={CONTROL_CLASS}
          >
            <option value="">— {t('logs.egress.allScopes')} —</option>
            {SCOPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.egress.status')}
          <select
            data-testid="logs-egress-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as EgressRequestStatus | '')}
            className={CONTROL_CLASS}
          >
            <option value="">— {t('logs.egress.allStatuses')} —</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`logs.egress.status.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.egress.limit')}
          <select
            data-testid="logs-egress-limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className={CONTROL_CLASS}
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{entries.length}</span>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="logs-egress-error"
          className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
        >
          {error}
        </div>
      )}

      {loading && !error ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-1.5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 bg-muted rounded w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div
          data-testid="logs-egress-empty"
          className="bg-background rounded-xl border p-8 text-center text-muted-foreground text-sm"
        >
          {t('logs.egress.noEntries')}
        </div>
      ) : (
        <div className="bg-background rounded-xl border overflow-auto max-h-[60vh]">
          <table className="w-full text-left text-xs" data-testid="logs-egress-table">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.time')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.scope')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.target')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.status')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.code')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.duration')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.egress.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, idx) => (
                <tr key={entry.id ?? `${entry.ts}-${idx}`} className="border-t border-border align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatDateTime(entry.ts, locale)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{entry.scope}</td>
                  <td className="px-3 py-2 min-w-[12rem]">
                    <span className="block font-mono text-foreground break-all" title={entry.url}>
                      {entry.host || entry.url || '—'}
                    </span>
                    {entry.host && entry.url && (
                      <span className="block text-muted-foreground break-all" title={entry.url}>
                        {entry.url}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={cn(
                        'inline-block rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                        STATUS_BADGE[entry.status] ?? 'bg-muted text-muted-foreground',
                      )}
                    >
                      {t(`logs.egress.status.${entry.status}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {entry.httpStatus ?? '—'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {entry.durationMs !== undefined ? `${entry.durationMs} ms` : '—'}
                  </td>
                  <td className="px-3 py-2 min-w-[10rem] text-muted-foreground">
                    <span className="break-words">{entry.reason ?? '—'}</span>
                    {entry.matchedRule && (
                      <span className="block break-words font-mono text-[0.625rem]">
                        {entry.matchedRule}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
