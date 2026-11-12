import { useCallback, useEffect, useState } from 'react'
import type { CommandAuditDecision, CommandAuditEntry } from '@itphx/synth-shared/types'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { downloadBlob } from '@/lib/download'
import { formatDateTime } from '@/lib/formatDate'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { synthApi } from '@/lib/api/synthApi'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { NumberField, SelectField, TextField } from '@/components/ui/settings'
import { SelectContent, SelectItem } from '@/components/ui/select'

/** Статус HTTP-ошибки (`403` — нет прав, `503` — журнал недоступен). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Сколько записей можно запросить одним списком. */
const LIMIT_OPTIONS = [50, 100, 500]

/** Решения permission-слоя, которые попадают в журнал. */
const DECISIONS: CommandAuditDecision[] = ['allow', 'deny', 'ask']

/** Бейдж решения: цвет по сути решения (разрешено/запрещено/спросили). */
const DECISION_CLASS: Record<CommandAuditDecision, string> = {
  allow: 'bg-status-success/15 text-status-success',
  deny: 'bg-destructive/15 text-destructive',
  ask: 'bg-status-warning/15 text-status-warning',
}

/** Короткая форма id (колонка «сессия»): первые 8 символов. */
export function shortAuditId(id: string | undefined): string {
  if (!id) return '—'
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** CSV-экранирование: значение в кавычках, внутренние кавычки удваиваются. */
export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

/** Заголовок CSV-выгрузки журнала исполнений. */
export const COMMAND_AUDIT_CSV_HEADER = [
  'ts',
  'tool',
  'decision',
  'phase',
  'sessionId',
  'projectId',
  'agentRole',
  'actor',
  'command',
  'cwd',
  'background',
  'durationMs',
  'exitCode',
  'bytesOut',
  'truncated',
  'provider',
  'reason',
] as const

/** CSV журнала (RFC 4180: поля в кавычках, `""` вместо кавычки). */
export function buildCommandAuditCsv(entries: CommandAuditEntry[]): string {
  const rows = entries.map((entry) => [
    entry.ts,
    entry.tool,
    entry.decision,
    entry.phase,
    entry.sessionId ?? '',
    entry.projectId ?? '',
    entry.agentRole ?? '',
    entry.actor ?? '',
    entry.command,
    entry.cwd,
    entry.background ? '1' : '0',
    entry.durationMs ?? '',
    entry.exitCode ?? '',
    entry.bytesOut ?? '',
    entry.truncated ? '1' : '0',
    entry.provider ? `${entry.provider.kind}:${entry.provider.action}` : '',
    entry.reason ?? '',
  ])
  return [COMMAND_AUDIT_CSV_HEADER, ...rows]
    .map((row) => row.map((cell) => csvCell(cell)).join(','))
    .join('\n')
}

/** Имя файла выгрузки (дата в локальной зоне). */
function csvFileName(): string {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  return `command-audit-${stamp}.csv`
}

/** Фильтры журнала (применённые — по ним загружается список). */
interface CommandAuditFilters {
  decision: CommandAuditDecision | ''
  limit: number
  sessionId: string
}

const INITIAL_FILTERS: CommandAuditFilters = { decision: '', limit: 100, sessionId: '' }

/**
 * PROP-136 (слайс 136a): панель «Команды shell» — журнал исполнений команд
 * (`GET /api/v2/audit/commands`): фильтры (решение/лимит/сессия), таблица
 * записей, клиентский экспорт CSV и retention-очистка (только ADMIN).
 *
 * Чтение журнала — ADMIN/AUDITOR, `DELETE` — ADMIN (guard сервера); UI лишь
 * прячет недоступное (роль — из auth-стора).
 */
export function CommandAuditPanel() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const roles = useAuthStore((s) => s.user?.roles) ?? []
  const isAdmin = roles.includes('ADMIN')

  const [filters, setFilters] = useState<CommandAuditFilters>(INITIAL_FILTERS)
  const [sessionInput, setSessionInput] = useState('')
  const [entries, setEntries] = useState<CommandAuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pruneDays, setPruneDays] = useState('30')
  const [pruning, setPruning] = useState(false)

  /** Понятный текст ошибки: 403/503 — отдельно, остальное — с текстом сервера. */
  const describeError = useCallback(
    (err: unknown): string => {
      const status = statusOf(err)
      if (status === 403) return t('maintenance.commandAudit.forbidden')
      if (status === 503) return t('maintenance.commandAudit.unavailable')
      return t('maintenance.commandAudit.loadError', {
        error: err instanceof Error ? err.message : t('common.error'),
      })
    },
    [t],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await synthApi.getCommandAudit({
        decision: filters.decision || undefined,
        limit: filters.limit,
        sessionId: filters.sessionId || undefined,
      })
      setEntries(data.entries ?? [])
      setLoaded(true)
    } catch (err) {
      setEntries([])
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [describeError, filters])

  // Первая загрузка и перезагрузка при смене фильтров.
  useEffect(() => {
    void load()
  }, [load])

  /** Применить фильтры (новая ссылка → перезагрузка списка). */
  const applyFilters = useCallback((next: Partial<CommandAuditFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }))
  }, [])

  const handleExport = useCallback(() => {
    if (entries.length === 0) {
      notify({
        text: t('maintenance.commandAudit.exportEmpty'),
        type: 'warning',
        category: 'system',
      })
      return
    }
    const csv = buildCommandAuditCsv(entries)
    const ok = downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), csvFileName())
    notify({
      text: ok
        ? t('maintenance.commandAudit.exportDone', { count: entries.length })
        : t('maintenance.commandAudit.exportError'),
      type: ok ? 'success' : 'error',
      category: ok ? 'system' : 'error',
    })
  }, [entries, notify, t])

  const handlePrune = useCallback(async () => {
    const days = Number(pruneDays)
    if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
      notify({
        text: t('maintenance.commandAudit.prune.invalid'),
        type: 'error',
        category: 'error',
      })
      return
    }
    const ok = await confirm({
      title: t('maintenance.commandAudit.prune.title'),
      message: t('maintenance.commandAudit.prune.confirm', { days }),
      confirmLabel: t('maintenance.commandAudit.prune.button'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setPruning(true)
    try {
      const result = await synthApi.pruneCommandAudit(days)
      notify({
        text: t('maintenance.commandAudit.prune.done', { count: result.removed }),
        type: 'success',
        category: 'system',
      })
      await load()
    } catch (err) {
      notify({
        text: t('maintenance.commandAudit.prune.error', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPruning(false)
    }
  }, [load, notify, pruneDays, t])

  return (
    <div className="space-y-3 min-w-0" data-testid="command-audit-panel">
      {/* Фильтры */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 min-w-0">
        <SelectField
          label={t('maintenance.commandAudit.decision')}
          value={filters.decision}
          onValueChange={(value) => applyFilters({ decision: value as CommandAuditDecision | '' })}
          triggerTestId="command-audit-decision"
          items={[
            { label: t('maintenance.commandAudit.decision.all'), value: '' },
            ...DECISIONS.map((decision) => ({
              label: t(`maintenance.commandAudit.decision.${decision}`),
              value: decision,
            })),
          ]}
        >
          <SelectContent>
            <SelectItem value="">{t('maintenance.commandAudit.decision.all')}</SelectItem>
            {DECISIONS.map((decision) => (
              <SelectItem key={decision} value={decision}>
                {t(`maintenance.commandAudit.decision.${decision}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectField>

        <SelectField
          label={t('maintenance.commandAudit.limit')}
          value={String(filters.limit)}
          onValueChange={(value) => applyFilters({ limit: Number(value) })}
          triggerTestId="command-audit-limit"
          items={LIMIT_OPTIONS.map((n) => ({ label: String(n), value: String(n) }))}
        >
          <SelectContent>
            {LIMIT_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectField>

        <TextField
          label={t('maintenance.commandAudit.session')}
          placeholder={t('maintenance.commandAudit.sessionPlaceholder')}
          value={sessionInput}
          mono
          onChange={(e) => setSessionInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyFilters({ sessionId: sessionInput.trim() })
          }}
          data-testid="command-audit-session"
        />
      </div>

      {/* Состояние загрузки/ошибки */}
      {error && (
        <div
          role="alert"
          data-testid="command-audit-error"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {loading && !loaded && (
        <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
      )}

      {loaded && entries.length === 0 && !error ? (
        <div
          className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
          data-testid="command-audit-empty"
        >
          <Icon name="terminal-box" className="size-6 opacity-40" />
          <p className="text-xs">{t('maintenance.commandAudit.empty')}</p>
        </div>
      ) : (
        entries.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border/60 min-w-0">
            <table className="w-full text-left text-xs" data-testid="command-audit-table">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colTime')}
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colTool')}
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colDecision')}
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colSession')}
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colCommand')}
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colDuration')}
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    {t('maintenance.commandAudit.colExit')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={`${entry.id}:${entry.phase}`}
                    data-testid={`command-audit-row-${entry.id}-${entry.phase}`}
                    className="border-t border-border align-top"
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatDateTime(entry.ts, locale)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-mono">{entry.tool}</span>
                      <span className="ml-1 text-[0.625rem] text-muted-foreground">
                        {t(`maintenance.commandAudit.phase.${entry.phase}`)}
                      </span>
                      {entry.background && (
                        <span
                          className="ml-1 rounded bg-muted px-1 py-0.5 text-[0.625rem] text-muted-foreground"
                          data-testid={`command-audit-background-${entry.id}-${entry.phase}`}
                        >
                          {t('maintenance.commandAudit.background')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={cn(
                          'inline-block rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                          DECISION_CLASS[entry.decision] ?? 'bg-muted text-muted-foreground',
                        )}
                        data-testid={`command-audit-decision-${entry.id}-${entry.phase}`}
                      >
                        {t(`maintenance.commandAudit.decision.${entry.decision}`)}
                      </span>
                    </td>
                    <td
                      className="px-3 py-2 whitespace-nowrap font-mono"
                      title={entry.sessionId}
                      data-testid={`command-audit-session-${entry.id}-${entry.phase}`}
                    >
                      {shortAuditId(entry.sessionId)}
                    </td>
                    <td className="px-3 py-2 min-w-[16rem] max-w-[28rem]">
                      <span
                        className="block truncate font-mono"
                        title={entry.command}
                        data-testid={`command-audit-command-${entry.id}-${entry.phase}`}
                      >
                        {entry.command}
                      </span>
                      {(entry.reason || entry.provider) && (
                        <span className="block truncate text-[0.625rem] text-muted-foreground">
                          {entry.provider && (
                            <span data-testid={`command-audit-provider-${entry.id}-${entry.phase}`}>
                              {t('maintenance.commandAudit.provider')}: {entry.provider.kind}:
                              {entry.provider.action}
                              {entry.provider.ruleId ? ` (${entry.provider.ruleId})` : ''}
                            </span>
                          )}
                          {entry.reason && (
                            <span
                              className={cn(entry.provider && 'ml-1')}
                              data-testid={`command-audit-reason-${entry.id}-${entry.phase}`}
                            >
                              {t('maintenance.commandAudit.reason')}: {entry.reason}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums text-muted-foreground">
                      {entry.durationMs !== undefined ? `${entry.durationMs} ms` : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums text-muted-foreground">
                      {entry.exitCode !== undefined ? String(entry.exitCode) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Счётчик */}
      <div className="text-xs text-muted-foreground" data-testid="command-audit-count">
        {t('maintenance.commandAudit.count', { count: entries.length })}
      </div>

      {/* Действия: обновление, экспорт CSV, retention-очистка */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => applyFilters({ sessionId: sessionInput.trim() })}
          disabled={loading}
          data-testid="command-audit-refresh"
        >
          <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
          {loading ? t('maintenance.commandAudit.refreshing') : t('maintenance.commandAudit.refresh')}
        </Button>

        <Button
          variant="outline-muted"
          onClick={handleExport}
          data-testid="command-audit-export"
        >
          <Icon name="download" className="size-3.5" />
          {t('maintenance.commandAudit.exportCsv')}
        </Button>

        {isAdmin && (
          <div className="flex flex-wrap items-end gap-2 min-w-0" data-testid="command-audit-prune">
            <NumberField
              label={t('maintenance.commandAudit.prune.days')}
              value={pruneDays}
              min={1}
              onChange={(e) => setPruneDays(e.target.value)}
              containerClassName="w-40"
              data-testid="command-audit-prune-days"
            />
            <Button
              variant="danger"
              onClick={() => void handlePrune()}
              disabled={pruning}
              data-testid="command-audit-prune-button"
            >
              <Icon name="delete-bin" className="size-3.5" />
              {t('maintenance.commandAudit.prune.button')}
            </Button>
          </div>
        )}

        {!isAdmin && (
          <p className="text-xs text-muted-foreground" data-testid="command-audit-prune-admin-only">
            {t('maintenance.commandAudit.prune.adminOnly')}
          </p>
        )}
      </div>
    </div>
  )
}
