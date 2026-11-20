// BlockingLogTab: экран live-лога **блокирующего** прогона (ADR-111 §detach).
//
// Блокирующий прогон идёт внутри хода: записи в реестре фоновых прогонов у
// него ещё нет, поэтому лог читается своим эндпоинтом
// (`GET /api/v2/processes/blocking/:id/logs`) и догружается по байтовому
// смещению, пока вкладка открыта. Механика та же, что у `ProcessLogTab`:
// отрезок + `offset`/`nextOffset`, автоскролл вниз, если пользователь внизу.
//
// Вкладка живёт, пока её не закрыли: закрытие размонтирует компонент и
// останавливает опрос (интервал снимается в cleanup эффекта).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/formatStats'
import { useNotification } from '@/hooks/useNotification'
import { Icon } from '@/components/icon/Icon'
import { AnsiText } from '@/components/ansi/AnsiText'
import { Button } from '@/components/ui/button'
import { useProcessesStore } from '@/stores/processesStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import type { CenterTab } from '@/stores/useUIStore'

/** Период авто-догрузки live-лога, мс. */
const LOG_POLL_MS = 1500
/** Тикер «идёт уже N» — раз в секунду. */
const ELAPSED_TICK_MS = 1000
/** Порог «пользователь внизу» для автоскролла, px. */
const STICK_TO_BOTTOM_PX = 40

const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** HTTP-статус ошибки API (`fetchJSON` пробрасывает `status`). */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function BlockingLogTab({ tab }: { tab: CenterTab }) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const runId = tab.data.blockingRunId ?? ''
  const fallbackTitle = tab.data.blockingRunTitle || tab.title || runId

  const run = useProcessesStore((s) => (runId ? s.blocking.find((item) => item.id === runId) : undefined))
  const refreshBlocking = useProcessesStore((s) => s.refreshBlocking)
  const sessions = useSessionsStore((s) => s.sessions)
  // Сессия-владелец прогона: с ней сервер проверяет доступ только к ней одной,
  // а не перечисляет все сессии инстанса. После перезагрузки записи в сторе
  // может не быть — тогда берём id из данных вкладки.
  const sessionId = run?.sessionId || tab.data.sessionId

  const [content, setContent] = useState('')
  const [offset, setOffset] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Прогон завершился (лог больше не отдаётся) — опрос остановлен. */
  const [finished, setFinished] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Раскраска ANSI-цветов: по умолчанию включена (как в `ProcessLogTab`).
  const [colors, setColors] = useState(true)

  /** Чтение отрезка с указанного смещения и дозапись в накопленный текст. */
  const fetchLog = useCallback(
    async (from: number) => {
      if (!runId) return
      try {
        const chunk = await synthApi.getBlockingLogs(runId, {
          ...(sessionId ? { sessionId } : {}),
          offset: from,
        })
        setContent((prev) => (chunk.offset === 0 ? chunk.content : prev + chunk.content))
        setOffset(chunk.nextOffset)
        setTruncated(chunk.truncated)
        setError(null)
        setFinished(false)
      } catch (err) {
        // 404 — прогон уже завершился и хэндла в памяти нет: это не ошибка
        // экрана, просто новых данных не будет.
        if (errorStatus(err) === 404) {
          setFinished(true)
          setError(null)
          return
        }
        setError(err instanceof Error ? err.message : t('common.error'))
      }
    },
    [runId, sessionId, t],
  )

  // Первое чтение лога при открытии вкладки.
  useEffect(() => {
    setContent('')
    setOffset(0)
    setTruncated(false)
    setError(null)
    setFinished(false)
    void fetchLog(0)
  }, [fetchLog])

  // Авто-догрузка, пока вкладка открыта и прогон ещё отдаёт лог.
  useEffect(() => {
    if (!runId || finished) return
    const timer = setInterval(() => {
      void fetchLog(offset)
    }, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [fetchLog, finished, offset, runId])

  // Тикер времени работы (пока прогон идёт).
  useEffect(() => {
    if (!run) return
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [run])

  // Автоскролл вниз — только если пользователь уже внизу.
  const bodyRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX
  }, [])

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [content])

  const title = run?.title || fallbackTitle

  /** Время работы прогона от старта до «сейчас». */
  const elapsedMs = useMemo(() => {
    if (!run?.startedAt) return undefined
    const started = Date.parse(run.startedAt)
    if (!Number.isFinite(started)) return undefined
    return Math.max(0, now - started)
  }, [run?.startedAt, now])

  const sessionName = useMemo(() => {
    const id = run?.sessionId
    if (!id) return ''
    return sessions.find((session) => session.id === id)?.name || id
  }, [run?.sessionId, sessions])

  /** Остановка блокирующего прогона (сервер отвечает 409, если уже нельзя). */
  const handleStop = useCallback(async () => {
    const ok = await confirm({
      title: t('processes.confirm.stopTitle'),
      message: t('processes.confirm.stopMessage', { name: title }),
      confirmLabel: t('processes.action.stop'),
      variant: 'danger',
      icon: 'stop',
    })
    if (!ok) return
    setBusy(true)
    try {
      await synthApi.stopBlockingRun(runId)
      notify({ text: t('processes.stopped'), type: 'success', category: 'system' })
      await refreshBlocking()
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
  }, [notify, refreshBlocking, runId, t, title])

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="blocking-log-tab">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            name={run?.kind === 'subagent' ? 'robot-2' : 'terminal-box'}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </span>
          <span
            className={cn(
              BADGE,
              finished || !run
                ? 'bg-muted text-muted-foreground'
                : 'bg-primary/15 text-primary',
            )}
            data-testid="blocking-log-status"
          >
            {!finished && run && <Icon name="loader-2" className="mr-1 inline size-3 animate-spin" />}
            {t(`processes.status.${finished || !run ? 'completed' : 'running'}`)}
          </span>
          {elapsedMs !== undefined && !finished && (
            <span className="shrink-0 text-xs text-muted-foreground" data-testid="blocking-log-elapsed">
              {t('processes.row.uptime')}: {formatDuration(elapsedMs)}
            </span>
          )}
        </div>

        {run?.sessionId && (
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate" title={sessionName} data-testid="blocking-log-session">
              {t('processes.row.session')}: <span>{sessionName}</span>
            </span>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="blocking-log-hint">
            {t('processes.blocking.liveHint')}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {run && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleStop()}
                disabled={busy}
                data-testid="blocking-log-stop"
              >
                <Icon name="stop" className="size-3.5" />
                {t('processes.action.stop')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void fetchLog(0)}
              title={t('processes.action.refreshLog')}
              aria-label={t('processes.action.refreshLog')}
              data-testid="blocking-log-refresh"
            >
              <Icon name="refresh" className="size-4" />
            </Button>
            <Button
              variant={colors ? 'outline-primary' : 'ghost'}
              size="icon"
              aria-pressed={colors}
              onClick={() => setColors((value) => !value)}
              title={t('processes.log.colorsHint')}
              aria-label={t('processes.log.colors')}
              data-testid="blocking-log-colors"
            >
              <Icon name="palette" className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {truncated && (
          <p className="shrink-0 px-4 py-1 text-xs text-status-warning" data-testid="blocking-log-truncated">
            {t('processes.log.truncated')}
          </p>
        )}
        {finished && (
          <p className="shrink-0 px-4 py-1 text-xs text-muted-foreground" data-testid="blocking-log-finished">
            {t('processes.blocking.finished')}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="shrink-0 break-words px-4 py-1 text-xs text-destructive"
            data-testid="blocking-log-error"
          >
            {t('processes.log.error', { error })}
          </p>
        )}
        <pre
          ref={bodyRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-xs text-foreground"
          data-testid="blocking-log-content"
        >
          {content ? <AnsiText text={content} colors={colors} /> : t('processes.log.empty')}
        </pre>
      </div>
    </div>
  )
}
