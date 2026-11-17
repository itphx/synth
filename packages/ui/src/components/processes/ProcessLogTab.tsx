import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { synthApi } from '@/lib/api/synthApi'
import type { ProcessLogStream } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/formatStats'
import { useNotification } from '@/hooks/useNotification'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useProcessesStore, processLogKey } from '@/stores/processesStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import type { CenterTab } from '@/stores/useUIStore'

/**
 * Экран «Вывод процесса» (per-run) — центральная вкладка с логом фонового
 * прогона.
 *
 * Источник данных — серверный реестр (`GET /api/v2/processes/:id`) и отрезки
 * лога (`GET /api/v2/processes/:id/logs?stream=…`): три потока вывода
 * (`combined`/`stdout`/`stderr`). Накопленный текст живёт в
 * `stores/processesStore` под ключом `runId:stream` (`processLogKey`), поэтому
 * потоки не смешиваются.
 *
 * Live-обновление статуса — события `process.*` (стор `processesStore`); пока
 * прогон выполняется, лог догружается раз в 2 с с текущего смещения.
 */

/** Период авто-догрузки лога, мс (пока прогон выполняется). */
const LOG_POLL_MS = 2000
/** Тикер «идёт уже N» — раз в секунду. */
const ELAPSED_TICK_MS = 1000
/** Порог «пользователь внизу» для автоскролла, px. */
const STICK_TO_BOTTOM_PX = 40

/** Общий стиль бейджа (как в «Процессы»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа статуса фонового прогона. */
const STATUS_CLASS: Record<string, string> = {
  running: 'bg-primary/15 text-primary',
  completed: 'bg-status-success/15 text-status-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
  orphaned: 'bg-status-warning/15 text-status-warning',
}

/** Потоки вывода в переключателе (значение → ключ словаря). */
const STREAMS: { value: ProcessLogStream; labelKey: string }[] = [
  { value: 'combined', labelKey: 'processes.log.stream.all' },
  { value: 'stdout', labelKey: 'processes.log.stream.stdout' },
  { value: 'stderr', labelKey: 'processes.log.stream.stderr' },
]

/** Иконка вида фоновой работы. */
function kindIcon(kind: string): 'terminal-box' | 'robot-2' {
  return kind === 'subagent' ? 'robot-2' : 'terminal-box'
}

/** HTTP-статус ошибки API (`fetchJSON` пробрасывает `status`). */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function ProcessLogTab({ tab }: { tab: CenterTab }) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const runId = tab.data.processRunId ?? ''

  // Выбранный поток вывода (`combined` по умолчанию).
  const [stream, setStream] = useState<ProcessLogStream>('combined')
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamUnavailable, setStreamUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const run = useProcessesStore((s) => (runId ? s.byId[runId] : undefined))
  const logState = useProcessesStore((s) =>
    runId ? s.logs[processLogKey(runId, stream)] : undefined,
  )
  const upsert = useProcessesStore((s) => s.upsert)
  const mergeLog = useProcessesStore((s) => s.mergeLog)
  const sessions = useSessionsStore((s) => s.sessions)

  /**
   * Прогон мог не попасть в стор (перезагрузка страницы с сохранённой
   * вкладкой) — тогда читаем его деталь у сервера один раз.
   */
  const requestedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!runId || run || requestedRef.current === runId) return
    requestedRef.current = runId
    let disposed = false
    void (async () => {
      try {
        const record = await synthApi.getProcess(runId)
        if (!disposed) upsert(record)
      } catch {
        if (!disposed) setMissing(true)
      }
    })()
    return () => {
      disposed = true
    }
  }, [runId, run, upsert])

  /** Чтение отрезка лога и слияние его с накопленным текстом потока. */
  const fetchLog = useCallback(
    async (offset: number) => {
      if (!runId) return
      try {
        const chunk = await synthApi.getProcessLogs(runId, { offset, stream })
        mergeLog(runId, stream, {
          content: chunk.content,
          offset: chunk.offset,
          nextOffset: chunk.nextOffset,
          totalBytes: chunk.totalBytes,
          truncated: chunk.truncated,
        })
        setError(null)
        setStreamUnavailable(false)
      } catch (err) {
        // У прогона до разделения потоков файла потока нет → сервер отвечает
        // 404. Это не ошибка экрана: подсказка, «Весь вывод» при этом работает.
        if (errorStatus(err) === 404 && stream !== 'combined') {
          setStreamUnavailable(true)
          setError(null)
        } else {
          setStreamUnavailable(false)
          setError(err instanceof Error ? err.message : t('common.error'))
        }
      }
    },
    [runId, stream, mergeLog, t],
  )

  // Первое чтение лога и перечитывание с нуля при смене потока.
  useEffect(() => {
    setError(null)
    setStreamUnavailable(false)
    void fetchLog(0)
  }, [fetchLog])

  const isRunning = run?.status === 'running'

  // Авто-догрузка лога, пока прогон выполняется (только выбранный поток).
  useEffect(() => {
    if (!runId || !isRunning || streamUnavailable) return
    const timer = setInterval(() => {
      const current = useProcessesStore.getState().logs[processLogKey(runId, stream)]
      void fetchLog(current?.offset ?? 0)
    }, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [runId, isRunning, stream, streamUnavailable, fetchLog])

  // Тикер «идёт уже N» для выполняющегося прогона.
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [isRunning])

  // Автоскролл вниз — только если пользователь уже внизу (иначе не дёргаем).
  const bodyRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX
  }, [])

  // Новый поток — начинаем с хвоста.
  useEffect(() => {
    stickRef.current = true
  }, [stream])

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [logState?.content, logState?.offset, stream])

  /** Время работы прогона. */
  const elapsedMs = useMemo(() => {
    if (!run) return undefined
    const started = Date.parse(run.startedAt ?? '')
    if (!Number.isFinite(started)) return undefined
    if (run.status === 'running') return Math.max(0, now - started)
    const finished = Date.parse(run.finishedAt ?? '')
    if (!Number.isFinite(finished)) return undefined
    return Math.max(0, finished - started)
  }, [run, now])

  const title = run ? run.command || run.description || run.id : tab.title || runId

  /**
   * Имя сессии-владельца прогона (fallback — её id).
   *
   * Сырой id в шапке вывода читается плохо, поэтому показываем имя сессии
   * из списка сессий.
   */
  const sessionName = useMemo(() => {
    const id = run?.sessionId
    if (!id) return ''
    return sessions.find((session) => session.id === id)?.name || id
  }, [run?.sessionId, sessions])

  /** Остановка прогона (сервер останавливает асинхронно). */
  const handleStop = useCallback(async () => {
    const ok = await confirm({
      title: t('processes.confirm.stopTitle'),
      message: t('processes.confirm.stopMessage', { name: title }),
      confirmLabel: t('processes.action.terminate'),
      variant: 'danger',
      icon: 'stop',
    })
    if (!ok) return
    setBusy(true)
    try {
      await synthApi.stopProcess(runId)
      notify({ text: t('processes.stopped'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('processes.failed', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setBusy(false)
    }
  }, [runId, title, notify, t])

  if (!run) {
    if (!runId || missing) {
      return (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          data-testid="process-log-not-found"
        >
          <Icon name="terminal-box" className="size-8 opacity-40" />
          <p>{t('processes.log.notFound')}</p>
        </div>
      )
    }
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        data-testid="process-log-loading"
      >
        <Icon name="loader-2" className="mr-2 size-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name={kindIcon(run.kind)} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </span>
          <span
            className={cn(BADGE, STATUS_CLASS[run.status] ?? 'bg-muted text-muted-foreground')}
            data-testid="process-log-status"
          >
            {isRunning && <Icon name="loader-2" className="mr-1 inline size-3 animate-spin" />}
            {t(`processes.status.${run.status}`)}
          </span>
          {elapsedMs !== undefined && (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              data-testid="process-log-elapsed"
            >
              {t('processes.row.uptime')}: {formatDuration(elapsedMs)}
            </span>
          )}
        </div>

        {/* Контекст прогона: каталог и сессия-владелец. */}
        {(run.cwd || run.sessionId) && (
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {run.cwd && (
              <span className="min-w-0 truncate" title={run.cwd}>
                {t('processes.row.cwd')}: <span className="font-mono">{run.cwd}</span>
              </span>
            )}
            {run.sessionId && (
              <span
                className="min-w-0 truncate"
                title={sessionName}
                data-testid="process-log-session"
              >
                {t('processes.row.session')}: <span>{sessionName}</span>
              </span>
            )}
          </div>
        )}

        {/* Переключатель потока и действия. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={t('processes.log.stream.title')}
            data-testid="process-log-streams"
          >
            {STREAMS.map((item) => (
              <Button
                key={item.value}
                variant={stream === item.value ? 'primary' : 'outline-muted'}
                size="sm"
                aria-pressed={stream === item.value}
                onClick={() => setStream(item.value)}
                data-testid={`process-log-stream-${item.value}`}
              >
                {t(item.labelKey)}
              </Button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {isRunning && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleStop()}
                disabled={busy}
                data-testid="process-log-stop"
              >
                <Icon name="stop" className="size-3.5" />
                {t('processes.action.terminate')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void fetchLog(0)}
              title={t('processes.action.refreshLog')}
              aria-label={t('processes.action.refreshLog')}
              data-testid="process-log-refresh"
            >
              <Icon name="refresh" className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Тело: лог прогона (свой скролл). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {logState?.truncated && (
          <p
            className="shrink-0 px-4 py-1 text-xs text-status-warning"
            data-testid="process-log-truncated"
          >
            {t('processes.log.truncated')}
          </p>
        )}
        {streamUnavailable && (
          <p
            className="shrink-0 px-4 py-1 text-xs text-muted-foreground"
            data-testid="process-log-stream-unavailable"
          >
            {t('processes.log.streamUnavailable')}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="shrink-0 break-words px-4 py-1 text-xs text-destructive"
            data-testid="process-log-error"
          >
            {t('processes.log.error', { error })}
          </p>
        )}
        <pre
          ref={bodyRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-xs text-foreground"
          data-testid="process-log-content"
        >
          {logState?.content || t('processes.log.empty')}
        </pre>
      </div>
    </div>
  )
}
