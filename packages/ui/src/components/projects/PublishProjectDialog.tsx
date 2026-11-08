import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { notifyMessage } from '@/hooks/useNotification'
import { useProjectsStore } from '@/stores/projectsStore'
import { synthApi, type ProjectData, type PublishProgress } from '@/lib/api/synthApi'

/**
 * Период опроса `GET /projects/:id/publish/progress`, пока идёт публикация.
 * Публикация может идти минутами — прогресс тянем часто, но одним запросом за раз.
 */
export const PUBLISH_PROGRESS_POLL_MS = 600

/**
 * Человекочитаемый размер (1024-основание). Локальный хелпер: общая утилита байт
 * живёт в настройках обслуживания (`MaintenanceSettings`), тянуть тот модуль в
 * диалог публикации незачем.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/**
 * Диалог «Опубликовать на сервер» (гибрид): локальный проект → удалённый backend.
 * Два режима: создать новый проект на сервере (имя сохраняется) или обновить
 * существующий удалённый проект. Сессии и файлы переносятся всегда.
 *
 * Пока идёт публикация, диалог опрашивает прогресс (процент, фаза, счётчики
 * сессий/файлов). Старое ядро без маршрута (`404`) — молча остаётся спиннер.
 */
interface PublishProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Локальный проект, который публикуем. */
  project: ProjectData
  /** Удалённые проекты — кандидаты на «обновить существующий». */
  remoteProjects: ProjectData[]
}

export function PublishProjectDialog({ open, onOpenChange, project, remoteProjects }: PublishProjectDialogProps) {
  const { t } = useI18n()
  const publishProject = useProjectsStore((s) => s.publishProject)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<PublishProgress | null>(null)

  // Опрос прогресса: одна цепочка `setTimeout`, один запрос в полёте за раз.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  const pollingRef = useRef(false)
  const mountedRef = useRef(true)

  const stopPolling = useCallback(() => {
    pollingRef.current = false
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const pollOnce = useCallback(async function poll(projectId: string): Promise<void> {
    if (!pollingRef.current || inFlightRef.current) return
    inFlightRef.current = true
    try {
      const next = await synthApi.getPublishProgress(projectId)
      if (mountedRef.current && pollingRef.current) setProgress(next)
    } catch (e) {
      // Бар не показываем (старое ядро без маршрута, сбой опроса) и не шумим
      // тостами: ошибку самой публикации покажет POST.
      if (mountedRef.current) setProgress(null)
      if ((e as { status?: number } | null)?.status === 404) pollingRef.current = false
    } finally {
      inFlightRef.current = false
      if (mountedRef.current && pollingRef.current) {
        pollTimerRef.current = setTimeout(() => { void poll(projectId) }, PUBLISH_PROGRESS_POLL_MS)
      }
    }
  }, [])

  const startPolling = useCallback((projectId: string) => {
    stopPolling()
    pollingRef.current = true
    void pollOnce(projectId)
  }, [pollOnce, stopPolling])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopPolling()
    }
  }, [stopPolling])

  useEffect(() => {
    if (open) {
      setMode('new')
      setSelectedId('')
      setBusy(false)
      setError(null)
      setProgress(null)
    } else {
      stopPolling()
    }
  }, [open, project.id, stopPolling])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      const remoteProjectId = mode === 'existing' && selectedId ? selectedId : undefined
      const publishPromise = publishProject(
        project.id,
        remoteProjectId ? { remote_project_id: remoteProjectId } : undefined,
      )
      // Первый опрос — сразу после старта POST, не дожидаясь его ответа.
      startPolling(project.id)
      await publishPromise
      notifyMessage({
        text: t('hybrid.publishDialog.success', { name: project.name }),
        type: 'success',
        category: 'system',
      })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      stopPolling()
      setProgress(null)
      setBusy(false)
    }
  }

  const overwriteExisting = mode === 'existing' && !!selectedId
  const showProgress = progress !== null && progress.phase !== 'error'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5 gap-3">
        <h3 className="text-sm font-semibold">{t('hybrid.publishDialog.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('hybrid.publishDialog.subtitle')}
          <span className="block truncate mt-0.5 text-foreground">{project.name}</span>
        </p>

        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => setMode('new')}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
              mode === 'new'
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-sidebar-border text-muted-foreground hover:bg-interactive-hover',
            )}
          >
            <Icon name={mode === 'new' ? 'checkbox' : 'checkbox-blank'} className="size-3.5 shrink-0 mt-0.5" />
            <span>
              {t('hybrid.publishDialog.new')}
              <span className="block text-muted-foreground mt-0.5 truncate">{project.name}</span>
            </span>
          </button>

          <button
            onClick={() => {
              setMode('existing')
              if (!selectedId && remoteProjects.length > 0) setSelectedId(remoteProjects[0]!.id)
            }}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
              mode === 'existing'
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-sidebar-border text-muted-foreground hover:bg-interactive-hover',
            )}
          >
            <Icon name={mode === 'existing' ? 'checkbox' : 'checkbox-blank'} className="size-3.5 shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0">
              {t('hybrid.publishDialog.existing')}
              <span className="block text-muted-foreground mt-1">
                {remoteProjects.length === 0 ? (
                  t('hybrid.publishDialog.noRemoteProjects')
                ) : (
                  <Select value={selectedId} onValueChange={(v) => setSelectedId(v || '')}>
                    <SelectTrigger size="sm" className="w-full text-xs border-0 bg-interactive rounded">
                      <span className="truncate flex-1 text-left">
                        {selectedId ? (remoteProjects.find((p) => p.id === selectedId)?.name ?? selectedId) : ''}
                      </span>
                      <Icon name="arrow-down-s" className="size-3.5 opacity-50 shrink-0" />
                    </SelectTrigger>
                    <SelectContent>
                      {remoteProjects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </span>
              {overwriteExisting && (
                <span className="block text-status-warning mt-1">{t('hybrid.publishDialog.overwriteHint')}</span>
              )}
            </span>
          </button>
        </div>

        {showProgress && progress && (
          <div className="flex flex-col gap-1.5">
            <div
              data-testid="publish-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              className="h-1 w-full overflow-hidden rounded-full bg-interactive"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('hybrid.publishDialog.progress.percent', { percent: progress.percent })}
              {' · '}
              {t(`hybrid.publishDialog.progress.phase.${progress.phase}`)}
            </p>
            {progress.sessions.total > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('hybrid.publishDialog.progress.phase.sessions')}{' '}
                {t('hybrid.publishDialog.progress.sessions', {
                  done: progress.sessions.done,
                  total: progress.sessions.total,
                })}
              </p>
            )}
            {progress.files.total > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('hybrid.publishDialog.progress.phase.files')}{' '}
                {t('hybrid.publishDialog.progress.files', {
                  done: progress.files.done,
                  total: progress.files.total,
                  doneBytes: formatBytes(progress.files.bytesDone),
                  totalBytes: formatBytes(progress.files.bytesTotal),
                })}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded bg-interactive px-4 py-2 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={busy || (mode === 'existing' && remoteProjects.length === 0)}
            className="flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Icon name={busy ? 'loader-2' : 'upload'} className={cn('size-3.5', busy && 'animate-spin')} />
            {busy ? t('hybrid.publishDialog.publishing') : t('hybrid.publishDialog.publish')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
