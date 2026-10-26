import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { synthApi } from '@/lib/api/synthApi'
import type { BackgroundRunRecord } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { formatDuration } from '@/lib/formatStats'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProcessesStore, bySession, runningCount } from '@/stores/processesStore'
import { PanelTab } from './PanelTab'

/**
 * PROP-096/097: вкладка «Процессы» правой панели — единый реестр фоновой
 * работы: шелл-процессов (`kind: 'process'`) и фоновых дочерних сессий
 * саб-агентов (`kind: 'subagent'`).
 *
 * Источник истины — серверный реестр (`GET /api/v2/processes`), live-обновление
 * — события `process.*`/`child.*` (диспетчер `stores/transportStore.ts`).
 * Периодическое перечитывание списка (5 с) — только пока вкладка активна:
 * компонент смонтирован ровно тогда, когда вкладка открыта.
 */

/** Период перечитывания списка прогонов, мс (вкладка активна). */
const LIST_REFRESH_MS = 5000
/** Период авто-подгрузки лога, мс (пока процесс выполняется). */
const LOG_POLL_MS = 2000
/** Тикер «идёт уже N» — раз в секунду. */
const ELAPSED_TICK_MS = 1000

/** Фильтр вида фоновой работы. */
type KindFilter = 'all' | 'process' | 'subagent'

/** Фильтры вида (для кнопок-переключателей). */
const KIND_FILTERS: KindFilter[] = ['all', 'process', 'subagent']

/** Общий стиль бейджа (как в «Памяти»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа статуса фонового прогона. */
const STATUS_CLASS: Record<string, string> = {
  running: 'bg-primary/15 text-primary',
  completed: 'bg-status-success/15 text-status-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
  orphaned: 'bg-status-warning/15 text-status-warning',
}

/** Иконка вида фоновой работы. */
function kindIcon(kind: BackgroundRunRecord['kind']): 'terminal-box' | 'robot-2' {
  return kind === 'subagent' ? 'robot-2' : 'terminal-box'
}

/** Человеческое имя прогона: команда, описание или id. */
function runTitle(run: BackgroundRunRecord): string {
  return run.command ?? run.description ?? run.id
}

export const ProcessesTab: React.FC = () => {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  // Фильтры: вид фоновой работы и «только текущая сессия».
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [onlyCurrent, setOnlyCurrent] = useState(false)

  // Активная сессия — из активной центральной вкладки.
  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const currentSessionId = activeTab?.data?.sessionId

  const sessions = useSessionsStore((s) => s.sessions)
  const sessionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name || session.id)
    return map
  }, [sessions])

  const byId = useProcessesStore((s) => s.byId)
  const order = useProcessesStore((s) => s.order)
  const logs = useProcessesStore((s) => s.logs)
  const loadError = useProcessesStore((s) => s.error)
  const load = useProcessesStore((s) => s.load)
  const mergeLog = useProcessesStore((s) => s.mergeLog)
  const removeRun = useProcessesStore((s) => s.remove)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [logId, setLogId] = useState<string | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const logRef = useRef<HTMLPreElement>(null)

  // Список: первичная загрузка + перечитывание раз в 5 с, пока вкладка активна.
  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      await load()
      if (!disposed) setLoading(false)
    }
    void refresh()
    const timer = setInterval(() => {
      void load()
    }, LIST_REFRESH_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [load])

  // Тикер «идёт уже N» для выполняющихся прогонов.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  /** Чтение отрезка лога и слияние его с накопленным текстом. */
  const fetchLog = useCallback(
    async (id: string, offset: number) => {
      try {
        const chunk = await synthApi.getProcessLogs(id, offset > 0 ? { offset } : undefined)
        mergeLog(id, {
          content: chunk.content,
          offset: chunk.offset,
          nextOffset: chunk.nextOffset,
          totalBytes: chunk.totalBytes,
          truncated: chunk.truncated,
        })
        setLogError(null)
      } catch (err) {
        setLogError(err instanceof Error ? err.message : t('common.error'))
      }
    },
    [mergeLog, t],
  )

  const logRun = logId ? byId[logId] : undefined
  const logIsRunning = logRun?.status === 'running'

  // Первое чтение лога при открытии.
  useEffect(() => {
    if (!logId) return
    setLogError(null)
    void fetchLog(logId, 0)
  }, [logId, fetchLog])

  // Авто-подгрузка лога, пока процесс выполняется и лог открыт.
  useEffect(() => {
    if (!logId || !logIsRunning) return
    const id = logId
    const timer = setInterval(() => {
      const current = useProcessesStore.getState().logs[id]
      void fetchLog(id, current?.offset ?? 0)
    }, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [logId, logIsRunning, fetchLog])

  // Автоскролл лога вниз (новый хвост).
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logId, logs])

  /** Открытие дочерней сессии саб-агента в центральной вкладке. */
  const handleOpenSession = (run: BackgroundRunRecord) => {
    const childId = run.childSessionId
    if (!childId) return
    useUIStore.getState().openTab({
      id: `chat-${childId}`,
      type: 'chat',
      title: sessionNames.get(childId) ?? run.description ?? childId,
      data: { sessionId: childId },
    })
  }

  /** Остановка фонового прогона (сервер останавливает асинхронно). */
  const handleStop = async (run: BackgroundRunRecord) => {
    const ok = await confirm({
      title: t('processes.confirm.stopTitle'),
      message: t('processes.confirm.stopMessage', { name: runTitle(run) }),
      confirmLabel: t('processes.action.stop'),
      variant: 'danger',
      icon: 'stop',
    })
    if (!ok) return
    setBusy(run.id)
    try {
      await synthApi.stopProcess(run.id)
      notify({ text: t('processes.stopped'), type: 'success', category: 'system' })
      await load()
    } catch (err) {
      notify({
        text: t('processes.failed', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setBusy(null)
    }
  }

  /** Удаление терминальной записи реестра. */
  const handleRemove = async (run: BackgroundRunRecord) => {
    const ok = await confirm({
      title: t('processes.confirm.removeTitle'),
      message: t('processes.confirm.removeMessage', { name: runTitle(run) }),
      confirmLabel: t('processes.action.remove'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setBusy(run.id)
    try {
      await synthApi.removeProcess(run.id)
      removeRun(run.id)
      if (logId === run.id) setLogId(null)
      notify({ text: t('processes.removed'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('processes.failed', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setBusy(null)
    }
  }

  /** Отфильтрованные прогоны (вид + «только текущая сессия»). */
  const runs = useMemo(() => {
    const base =
      onlyCurrent && currentSessionId
        ? bySession({ byId, order }, currentSessionId)
        : order.map((id) => byId[id]).filter((run): run is BackgroundRunRecord => !!run)
    return base.filter((run) => kindFilter === 'all' || run.kind === kindFilter)
  }, [byId, order, kindFilter, onlyCurrent, currentSessionId])

  const runningTotal = useMemo(() => runningCount({ byId }), [byId])

  const logState = logId ? logs[logId] : undefined

  return (
    <PanelTab>
      {/* Сводка и фильтры. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('processes.title')}
          </h3>
          <span className="text-xs text-muted-foreground" data-testid="processes-count">
            {t('processes.count', { count: runs.length })}
          </span>
        </div>

        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t('processes.filter.title')}
          data-testid="processes-kind-filter"
        >
          {KIND_FILTERS.map((filter) => (
            <Button
              key={filter}
              variant={kindFilter === filter ? 'primary' : 'outline-muted'}
              size="sm"
              aria-pressed={kindFilter === filter}
              onClick={() => setKindFilter(filter)}
              data-testid={`processes-filter-${filter}`}
            >
              {t(`processes.filter.${filter}`)}
            </Button>
          ))}

          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="processes-running-count">
              {t('processes.runningCount', { count: runningTotal })}
            </span>
            {t('processes.filter.onlyCurrent')}
            <Toggle
              enabled={onlyCurrent}
              onToggle={() => setOnlyCurrent((value) => !value)}
              ariaLabel={t('processes.filter.onlyCurrent')}
              disabled={!currentSessionId}
            />
          </span>
        </div>
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          data-testid="processes-error"
        >
          {t('processes.loadError', { error: loadError })}
        </div>
      )}

      {loading && runs.length === 0 && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
          data-testid="processes-loading"
        >
          <Icon name="loader-2" className="size-3.5 animate-spin" />
          {t('common.loading')}
        </div>
      )}

      {!loading && runs.length === 0 && (
        <div
          className="py-6 text-center text-muted-foreground"
          data-testid="processes-empty"
        >
          <Icon name="terminal-box" className="mx-auto mb-2 size-8 opacity-40" />
          <p className="text-sm">{t('processes.empty')}</p>
          <p className="mt-1 text-xs opacity-80">{t('processes.emptyHint')}</p>
        </div>
      )}

      {runs.length > 0 && (
        <ul className="space-y-2 min-w-0" data-testid="processes-list">
          {runs.map((run) => {
            const isRunning = run.status === 'running'
            const started = Date.parse(run.startedAt ?? '')
            const finished = Date.parse(run.finishedAt ?? '')
            const elapsedMs = isRunning
              ? Math.max(0, now - (Number.isFinite(started) ? started : now))
              : Number.isFinite(started) && Number.isFinite(finished)
                ? finished - started
                : undefined
            return (
              <li
                key={run.id}
                data-testid={`processes-item-${run.id}`}
                data-kind={run.kind}
                data-status={run.status}
                className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon
                    name={kindIcon(run.kind)}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={runTitle(run)}>
                    {runTitle(run)}
                  </span>
                  <span
                    className={cn(BADGE, STATUS_CLASS[run.status] ?? 'bg-muted text-muted-foreground')}
                    data-testid={`processes-status-${run.id}`}
                  >
                    {isRunning && <Icon name="loader-2" className="mr-1 inline size-3 animate-spin" />}
                    {t(`processes.status.${run.status}`)}
                  </span>
                </div>

                <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-muted-foreground min-w-0">
                  {run.cwd && (
                    <Row label={t('processes.row.cwd')} value={run.cwd} mono />
                  )}
                  <Row
                    label={t('processes.row.session')}
                    value={sessionNames.get(run.sessionId) ?? run.sessionId}
                    mono
                  />
                  {run.agentRole && (
                    <Row label={t('processes.row.agent')} value={run.agentRole} />
                  )}
                  {isRunning && elapsedMs !== undefined && (
                    <Row
                      label={t('processes.row.elapsed')}
                      value={formatDuration(elapsedMs)}
                    />
                  )}
                  {!isRunning && run.finishedAt && (
                    <Row
                      label={t('processes.row.finished')}
                      value={formatDateTime(run.finishedAt, locale)}
                    />
                  )}
                  {!isRunning && run.exitCode !== undefined && (
                    <Row label={t('processes.row.exitCode')} value={String(run.exitCode)} mono />
                  )}
                  {!isRunning && run.signal && (
                    <Row label={t('processes.row.signal')} value={run.signal} mono />
                  )}
                </dl>

                {run.summary && (
                  <p className="break-words text-xs text-muted-foreground" data-testid={`processes-summary-${run.id}`}>
                    {run.summary}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-1">
                  {isRunning && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void handleStop(run)}
                      disabled={busy === run.id}
                      title={t('processes.action.stop')}
                      aria-label={t('processes.action.stop')}
                      data-testid={`processes-stop-${run.id}`}
                    >
                      <Icon name="stop" className="size-4" />
                    </Button>
                  )}
                  {run.kind === 'subagent' && run.childSessionId && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleOpenSession(run)}
                      title={t('processes.action.openSession')}
                      aria-label={t('processes.action.openSession')}
                      data-testid={`processes-open-${run.id}`}
                    >
                      <Icon name="external-link" className="size-4" />
                    </Button>
                  )}
                  {run.kind === 'process' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setLogId((current) => (current === run.id ? null : run.id))}
                      title={logId === run.id ? t('processes.action.hideLog') : t('processes.action.showLog')}
                      aria-label={logId === run.id ? t('processes.action.hideLog') : t('processes.action.showLog')}
                      data-testid={`processes-log-toggle-${run.id}`}
                    >
                      <Icon name={logId === run.id ? 'eye-off' : 'eye'} className="size-4" />
                    </Button>
                  )}
                  {!isRunning && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:text-destructive"
                      onClick={() => void handleRemove(run)}
                      disabled={busy === run.id}
                      title={t('processes.action.remove')}
                      aria-label={t('processes.action.remove')}
                      data-testid={`processes-remove-${run.id}`}
                    >
                      <Icon name="delete-bin" className="size-4" />
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Лог фонового процесса — под списком. */}
      {logId && logRun && (
        <div
          className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-3"
          data-testid="processes-log"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={runTitle(logRun)}>
              {runTitle(logRun)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void fetchLog(logId, 0)}
              title={t('processes.action.refreshLog')}
              aria-label={t('processes.action.refreshLog')}
              data-testid="processes-log-refresh"
            >
              <Icon name="refresh" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLogId(null)}
              title={t('processes.action.hideLog')}
              aria-label={t('processes.action.hideLog')}
              data-testid="processes-log-hide"
            >
              <Icon name="close" className="size-4" />
            </Button>
          </div>

          {logState?.truncated && (
            <p className="text-xs text-status-warning" data-testid="processes-log-truncated">
              {t('processes.log.truncated')}
            </p>
          )}

          {logError && (
            <p role="alert" className="break-words text-xs text-destructive" data-testid="processes-log-error">
              {t('processes.log.error', { error: logError })}
            </p>
          )}

          <pre
            ref={logRef}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[0.6875rem] text-foreground"
            data-testid="processes-log-content"
          >
            {logState?.content || t('processes.log.empty')}
          </pre>
        </div>
      )}
    </PanelTab>
  )
}

/** Строка «лейбл — значение» в карточке прогона. */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2 min-w-0">
      <dt className="shrink-0 font-medium">{label}:</dt>
      <dd
        className={cn(
          'min-w-0 break-words text-right',
          mono && 'font-mono text-[0.6875rem]',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
