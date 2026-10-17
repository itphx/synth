import { useCallback, useEffect, useState } from 'react'
import type { SecurityAuditEntry, SecurityAuditScope } from '@itphx/synth-shared/types'

import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { formatDateTime } from '@/lib/formatDate'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'

const LIMIT_OPTIONS = [50, 100, 200, 500]
const SCOPES: SecurityAuditScope[] = ['tools', 'webhooks', 'mcp']

/** Единый стиль select в logviewer (как в AuditLogPanel). */
const CONTROL_CLASS =
  'rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

const ACTION_BADGE: Record<string, string> = {
  update: 'bg-status-info/15 text-status-info',
  reset: 'bg-status-warning/15 text-status-warning',
}

/**
 * Краткая сводка снимка политики (`before`/`after`): `mode: list; exc …`.
 * `null` — значение не задано (reset); объекты неизвестной формы — JSON.
 */
export function summarizePolicy(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const policy = value as { mode?: unknown; list?: unknown; exceptions?: unknown }
    if (typeof policy.mode === 'string') {
      const list = Array.isArray(policy.list)
        ? policy.list.filter((item): item is string => typeof item === 'string')
        : []
      const exceptions = Array.isArray(policy.exceptions)
        ? policy.exceptions.filter((item): item is string => typeof item === 'string')
        : []
      const parts = [`${policy.mode}: ${list.join(', ') || '∅'}`]
      if (exceptions.length > 0) parts.push(`exc ${exceptions.join(', ')}`)
      return parts.join('; ')
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Категория «Безопасность (политики)» в «Логах и аудите»: журнал изменений
 * egress/security-политик (`GET /audit/security`, ADR-071). Гейт ADMIN/AUDITOR —
 * на уровне модала.
 */
export function SecurityAuditPanel() {
  const { t, locale } = useI18n()
  const [scope, setScope] = useState<SecurityAuditScope | ''>('')
  const [limit, setLimit] = useState(100)
  const [entries, setEntries] = useState<SecurityAuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await synthApi.getSecurityAudit(limit, scope || undefined)
      setEntries(data.entries)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('logs.security.error'))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [limit, scope, t])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{t('logs.security.title')}</h3>
          <p className="text-muted-foreground text-sm mt-1">{t('logs.security.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" className="size-3.5" />
          {t('common.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.security.scope')}
          <select
            data-testid="logs-security-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as SecurityAuditScope | '')}
            className={CONTROL_CLASS}
          >
            <option value="">— {t('logs.security.allScopes')} —</option>
            {SCOPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('logs.security.limit')}
          <select
            data-testid="logs-security-limit"
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
          data-testid="logs-security-error"
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
          data-testid="logs-security-empty"
          className="bg-background rounded-xl border p-8 text-center text-muted-foreground text-sm"
        >
          {t('logs.security.noEntries')}
        </div>
      ) : (
        <div className="bg-background rounded-xl border overflow-auto max-h-[60vh]">
          <table className="w-full text-left text-xs" data-testid="logs-security-table">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.security.time')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.security.actor')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.security.scope')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.security.action')}</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">{t('logs.security.change')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, idx) => {
                const before = summarizePolicy(entry.before)
                const after = summarizePolicy(entry.after)
                return (
                  <tr key={entry.id ?? `${entry.ts}-${idx}`} className="border-t border-border align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatDateTime(entry.ts, locale)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono">{entry.actor || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{entry.scope}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={cn(
                          'inline-block rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                          ACTION_BADGE[entry.action] ?? 'bg-muted text-muted-foreground',
                        )}
                      >
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 min-w-[14rem] text-muted-foreground">
                      <span className="break-words font-mono" title={`${before} → ${after}`}>
                        {before} → {after}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
