import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'
import type { PipelineRunEvent, PipelineRunRecord } from '@/lib/api/synthApi'
import type { CenterTab } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { usePipelinesStore, isRunActive } from '@/stores/pipelinesStore'
import { canEditProjectContent } from '@/lib/projectAccess'
import { useNotification } from '@/hooks/useNotification'
import { formatRelativeTime } from '@/lib/formatDate'

/**
 * Страница прогона пайплайна (ADR-101, Э7): статус, текущий шаг, версия,
 * тайминги, журнал событий и HITL-действия.
 *
 * Live-обновление — по событиям `pipeline.run.*` инстансного канала шины
 * (ADR-101 §2.12.3): диспетчер транспорта обновляет `pipelinesStore`
 * (`runDetail`/`runSignal`), страница реагирует на сигнал и перечитывает
 * журнал с сервера (журнал append-only, сервер — источник истины).
 */
export function PipelineRunTab({ tab }: { tab: CenterTab }) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const runId = tab.data.runId ?? ''
  const projectId = tab.data.projectId ?? ''

  const projects = useProjectsStore((s) => s.projects)
  const user = useAuthStore((s) => s.user)
  const runDetail = usePipelinesStore((s) => s.runDetail)
  const runSignal = usePipelinesStore((s) => s.runSignal)
  const loadRun = usePipelinesStore((s) => s.loadRun)

  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  )
  const canEdit = canEditProjectContent(project, user)

  const detail = runDetail[runId]
  const run: PipelineRunRecord | undefined = detail?.run
  const events: PipelineRunEvent[] = detail?.events ?? []

  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')

  const reload = useCallback(async () => {
    if (!runId) return
    await loadRun(runId)
  }, [runId, loadRun])

  useEffect(() => { void reload() }, [reload])

  // Live-событие прогона → перечитываем журнал (с сервера).
  const signal = runSignal[runId] ?? 0
  useEffect(() => {
    if (signal === 0) return
    void reload()
  }, [signal, reload])

  const resume = async (approved: boolean) => {
    setBusy(true)
    try {
      await synthApi.resumePipelineRun(runId, {
        approved,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      })
      setComment('')
      await reload()
      notify({
        text: approved ? t('pipelines.approved') : t('pipelines.rejected'),
        type: 'success',
        category: 'system',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    try {
      await synthApi.cancelPipelineRun(runId)
      await reload()
      notify({ text: t('pipelines.cancelled'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (!run) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Icon name="loader-2" className="mr-2 h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  const awaitingHuman = run.status === 'awaiting_human'
  const active = isRunActive(run.status)
  const durationMs = run.startedAt && run.finishedAt
    ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
    : undefined

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="time" className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold text-foreground">{run.id}</h1>
          <span
            data-run-status={run.status}
            className={`rounded px-1.5 py-0.5 text-[0.65rem] ${
              run.status === 'done'
                ? 'bg-status-success/15 text-status-success'
                : run.status === 'failed' || run.status === 'cancelled'
                  ? 'bg-destructive/15 text-destructive'
                  : run.status === 'awaiting_human'
                    ? 'bg-status-warning/15 text-status-warning'
                    : 'bg-interactive text-muted-foreground'
            }`}
          >
            {run.status}
          </span>
          <span className="rounded bg-interactive px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
            {t('pipelines.version')} {run.version}
          </span>
          {run.currentNode && (
            <span className="rounded bg-interactive px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
              {t('pipelines.currentNode')}: {run.currentNode}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          {run.startedAt && <span>{t('pipelines.startedAt')}: {formatRelativeTime(run.startedAt)}</span>}
          {run.finishedAt && <span>{t('pipelines.finishedAt')}: {formatRelativeTime(run.finishedAt)}</span>}
          {durationMs !== undefined && (
            <span>{t('pipelines.duration')}: {Math.round(durationMs / 1000)} с</span>
          )}
          {run.trigger?.kind && <span>{t('pipelines.trigger')}: {run.trigger.kind}</span>}
        </div>
        {run.error && <p className="text-xs text-destructive">{run.error}</p>}

        {canEdit && awaitingHuman && (
          <div className="flex flex-col gap-2 rounded border border-status-warning/40 bg-status-warning/5 p-2">
            <span className="text-xs text-status-warning">{t('pipelines.awaitingHuman')}</span>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('pipelines.commentPlaceholder')}
              className="w-full rounded bg-interactive px-2 py-1 text-xs text-foreground outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void resume(true)}
                disabled={busy}
                data-action="approve"
                className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors disabled:opacity-50"
              >
                {t('pipelines.approve')}
              </button>
              <button
                onClick={() => void resume(false)}
                disabled={busy}
                data-action="reject"
                className="rounded border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                {t('pipelines.reject')}
              </button>
            </div>
          </div>
        )}

        {canEdit && active && (
          <div>
            <button
              onClick={() => void cancel()}
              disabled={busy}
              data-action="cancel-run"
              className="rounded border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              {t('pipelines.cancelRun')}
            </button>
          </div>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('pipelines.journal')}
        </h2>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('pipelines.emptyJournal')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((event, index) => (
              <li
                key={`${event.ts}-${index}`}
                className="flex flex-col gap-0.5 rounded border border-border bg-card px-2 py-1"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium text-foreground">{event.type}</span>
                  {typeof event.payload?.node === 'string' && (
                    <span className="text-muted-foreground">{event.payload.node}</span>
                  )}
                  <span className="ml-auto text-muted-foreground">{formatRelativeTime(event.ts)}</span>
                </div>
                {event.payload && Object.keys(event.payload).length > 0 && (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[0.65rem] text-muted-foreground">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
