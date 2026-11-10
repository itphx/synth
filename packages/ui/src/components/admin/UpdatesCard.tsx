import { useCallback, useEffect, useRef, useState } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared/version'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { Icon } from '../icon/Icon'
import { SelectContent, SelectItem } from '../ui/select'
import { SelectField, SettingsSection } from '../ui/settings'
import { synthApi, type RestartStatus } from '@/lib/api/synthApi'
import {
  isUpdateUnsupported,
  updateErrorMessage,
  updateErrorStatus,
  updatesApi,
  type ResolvedUpdateChannel,
  type UpdateApplyEvent,
  type UpdateChannel,
  type UpdateCheckResult,
  type UpdateDoneEvent,
  type UpdatesSettings,
} from '@/lib/api/updates'

/** Интервал опроса `/health` после перезапуска (мс). */
export const UPDATE_RESTART_POLL_INTERVAL_MS = 1000
/** Таймаут ожидания нового `(startedAt, version)` (мс). */
export const UPDATE_RESTART_TIMEOUT_MS = 90_000
/** Сколько строк прогресса установки хранится в памяти. */
export const UPDATE_PROGRESS_MAX_LINES = 200
/** Сколько последних строк прогресса видно (остальное — скроллом). */
export const UPDATE_PROGRESS_VISIBLE_LINES = 12

const CHANNELS: readonly UpdateChannel[] = ['auto', 'stable', 'beta']

/** Канал установленной версии — выводится из `SYNTH_VERSION` (ADR-133 §1). */
export function installedChannel(version: string): ResolvedUpdateChannel {
  return version.includes('-beta.') ? 'beta' : 'stable'
}

const asChannel = (value: string): UpdateChannel =>
  (CHANNELS as readonly string[]).includes(value) ? (value as UpdateChannel) : 'auto'

/** Пропсы компонента (тестовые точки подмены перезагрузки и опроса). */
export interface UpdatesCardProps {
  /** Перезагрузка страницы после рестарта; по умолчанию `window.location.reload()`. */
  onReload?: () => void
  /** Интервал опроса `/health` (мс). */
  pollIntervalMs?: number
  /** Таймаут ожидания нового `(startedAt, version)` (мс). */
  restartTimeoutMs?: number
}

/**
 * ADR-133 §8 / ADR-072: блок «Обновления» раздела «Панель управления» —
 * текущая версия и канал, выбор канала проверки, автопроверка
 * (`GET/PUT /settings/updates`), явная проверка (`GET /updates/check?force=1`) и
 * установка (`POST /updates/apply`, SSE) с опциональным перезапуском инстанса.
 *
 * После установки с рестартом UI ждёт смену пары `(startedAt, version)` в
 * `/health` и перезагружает страницу; без рестарта — предлагает перезапустить
 * инстанс вручную (ADR-092, инвариант 24). Самообновление вне standalone
 * (Docker/Helm/managed) сервер отклоняет `409 UPDATE_UNSUPPORTED`.
 */
export function UpdatesCard({
  onReload,
  pollIntervalMs = UPDATE_RESTART_POLL_INTERVAL_MS,
  restartTimeoutMs = UPDATE_RESTART_TIMEOUT_MS,
}: UpdatesCardProps = {}) {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const reloadPage = useCallback(() => {
    if (onReload) onReload()
    else window.location.reload()
  }, [onReload])

  const [settings, setSettings] = useState<UpdatesSettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savePending, setSavePending] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [channel, setChannel] = useState<UpdateChannel>('auto')
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  const [restartStatus, setRestartStatus] = useState<RestartStatus | null>(null)

  const [restartAfter, setRestartAfter] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null)
  const [done, setDone] = useState<UpdateDoneEvent | null>(null)
  const [restartOverlay, setRestartOverlay] = useState(false)

  const applyAbortRef = useRef<AbortController | null>(null)
  const restartPollRef = useRef<{ cancelled: boolean } | null>(null)

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      const next = await updatesApi.getUpdatesSettings()
      setSettings(next)
      setChannel(next.channel)
    } catch (err) {
      setSettingsError(
        t('admin.updates.loadError', {
          error: updateErrorMessage(err, t('common.error')),
        }),
      )
    } finally {
      setSettingsLoading(false)
    }
  }, [t])

  const loadRestartStatus = useCallback(async () => {
    try {
      setRestartStatus(await synthApi.getRestartStatus())
    } catch {
      // Эндпоинт рестарта может отсутствовать (старый сервер) — просто недоступен.
      setRestartStatus(null)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    void loadRestartStatus()
  }, [loadRestartStatus])

  // Снять опрос при размонтировании (иначе таймеры живут после закрытия настроек).
  useEffect(
    () => () => {
      applyAbortRef.current?.abort()
      if (restartPollRef.current) restartPollRef.current.cancelled = true
    },
    [],
  )

  const notifyError = useCallback(
    (text: string) => {
      notify({ text, type: 'error', category: 'error' })
    },
    [notify],
  )

  /** Автопроверка: `PUT /settings/updates {check}`, без перезагрузки страницы. */
  const handleToggleAuto = useCallback(async () => {
    if (!settings || savePending || settings.envLocked) return
    setSavePending(true)
    setSaveError(null)
    try {
      const next = await updatesApi.putUpdatesSettings({ check: !settings.check })
      setSettings(next)
      notify({ text: t('admin.updates.saved'), type: 'success', category: 'system' })
    } catch (err) {
      if (updateErrorStatus(err) === 409) {
        setSettings((prev) => (prev ? { ...prev, envLocked: true, source: 'env' } : prev))
        setSaveError(t('admin.updates.error.conflict'))
      } else {
        setSaveError(
          t('admin.updates.saveError', {
            error: updateErrorMessage(err, t('common.error')),
          }),
        )
      }
    } finally {
      setSavePending(false)
    }
  }, [notify, savePending, settings, t])

  /** «Проверить»: всегда `force=1` — кэш сервера игнорируется (ADR-133 §3). */
  const handleCheck = useCallback(async () => {
    if (checking) return
    setChecking(true)
    setCheckError(null)
    setUnsupportedReason(null)
    try {
      const result = await updatesApi.checkUpdates({ channel, force: true })
      setCheckResult(result)
      if (result.error) {
        setCheckError(t('admin.updates.error.check', { error: result.error }))
      }
    } catch (err) {
      setCheckResult(null)
      setCheckError(
        t('admin.updates.error.check', {
          error: updateErrorMessage(err, t('common.error')),
        }),
      )
    } finally {
      setChecking(false)
    }
  }, [channel, checking, t])

  /**
   * Ожидание старта: опрос `/health` до смены пары `(startedAt, version)`.
   * Пока инстанс лежит, запросы падают — это нормально, продолжаем.
   */
  const waitForRestart = useCallback(
    async (baseline: { startedAt?: string; version?: string }) => {
      const poll = { cancelled: false }
      restartPollRef.current = poll
      const deadline = Date.now() + restartTimeoutMs
      while (!poll.cancelled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
        if (poll.cancelled) return
        try {
          const health = await synthApi.getHealth()
          const changed =
            (health.startedAt ?? '') !== (baseline.startedAt ?? '') ||
            (health.version ?? '') !== (baseline.version ?? '')
          if (changed) {
            reloadPage()
            return
          }
        } catch {
          // Инстанс ещё перезапускается.
        }
      }
      if (poll.cancelled) return
      restartPollRef.current = null
      setRestartOverlay(false)
      setUpdateError(t('admin.updates.restartTimeout'))
    },
    [pollIntervalMs, reloadPage, restartTimeoutMs, t],
  )

  /** «Перезапустить» — graceful restart инстанса (exit 75) и ожидание старта. */
  const handleRestartInstance = useCallback(
    async (baseline?: { startedAt?: string; version?: string }) => {
      if (restartStatus?.supported !== true) return
      setUpdateError(null)
      setRestartOverlay(true)
      try {
        const response = await synthApi.restartInstance()
        void waitForRestart(
          baseline ?? { startedAt: response.startedAt, version: done?.version ?? SYNTH_VERSION },
        )
      } catch (err) {
        setRestartOverlay(false)
        setUpdateError(
          t('admin.updates.restartError', {
            error: updateErrorMessage(err, t('common.error')),
          }),
        )
      }
    },
    [done?.version, restartStatus, t, waitForRestart],
  )

  const pushProgress = useCallback((text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
    if (lines.length === 0) return
    setProgress((prev) => [...prev, ...lines].slice(-UPDATE_PROGRESS_MAX_LINES))
  }, [])

  /** «Обновить»: подтверждение → SSE-поток установки → (опц.) рестарт. */
  const handleApply = useCallback(async () => {
    if (!checkResult?.hasUpdate || updating) return
    const version = checkResult.latestVersion
    const targetChannel = checkResult.channel
    const ok = await confirm({
      title: t('admin.updates.confirmTitle'),
      message: t('admin.updates.confirmMessage', {
        version,
        channel: t(`admin.updates.channel.${targetChannel}`),
      }),
      confirmLabel: t('admin.updates.confirmAction'),
      icon: 'rocket',
    })
    if (!ok) return

    const restart = restartAfter && restartStatus?.supported === true
    let baseline: { startedAt?: string; version?: string } = { version: SYNTH_VERSION }
    try {
      baseline = await synthApi.getHealth()
    } catch {
      // Без baseline перезагрузка произойдёт на первом же успешном ответе `/health`.
    }

    const outcome: { done?: UpdateDoneEvent; error?: Error } = {}
    const controller = new AbortController()
    applyAbortRef.current = controller
    setUpdateError(null)
    setUnsupportedReason(null)
    setDone(null)
    setProgress([])
    setUpdating(true)

    const onEvent = (event: UpdateApplyEvent) => {
      switch (event.type) {
        case 'start':
          if (event.message) pushProgress(event.message)
          break
        case 'progress':
          if (event.data) pushProgress(event.data)
          else if (event.message) pushProgress(event.message)
          break
        case 'stderr':
          if (event.data) pushProgress(event.data)
          else if (event.message) pushProgress(event.message)
          break
        case 'error':
          outcome.error = new Error(event.message ?? t('admin.updates.error.applyUnknown'))
          break
        case 'done':
          outcome.done = event
          break
      }
    }

    try {
      await updatesApi.applyUpdate({ version, channel: targetChannel, restart }, onEvent, controller.signal)
    } catch (err) {
      outcome.error = err instanceof Error ? err : new Error(String(err))
    } finally {
      applyAbortRef.current = null
      setUpdating(false)
    }

    if (controller.signal.aborted) {
      setUpdateError(t('admin.updates.cancelled'))
      return
    }

    if (outcome.error) {
      const err = outcome.error
      if (isUpdateUnsupported(err)) {
        setUnsupportedReason(updateErrorMessage(err, t('admin.updates.unsupportedUnknown')))
      } else {
        setUpdateError(
          t('admin.updates.error.apply', {
            error: updateErrorMessage(err, t('common.error')),
          }),
        )
        notifyError(
          t('admin.updates.error.apply', {
            error: updateErrorMessage(err, t('common.error')),
          }),
        )
      }
      return
    }

    const result = outcome.done
    if (!result) {
      setUpdateError(t('admin.updates.error.applyUnknown'))
      return
    }

    setDone(result)
    if (result.restartScheduled) {
      setRestartOverlay(true)
      void waitForRestart(baseline)
    } else {
      notify({ text: t('admin.updates.doneNeedRestart'), type: 'success', category: 'system' })
    }
  }, [
    checkResult,
    notify,
    notifyError,
    pushProgress,
    restartAfter,
    restartStatus,
    t,
    updating,
    waitForRestart,
  ])

  const handleCancel = useCallback(() => {
    applyAbortRef.current?.abort()
  }, [])

  const installed = installedChannel(SYNTH_VERSION)
  const autoCheck = settings?.check === true
  const envLocked = settings?.envLocked === true
  const restartSupported = restartStatus?.supported === true
  const canCheck = !checking
  const showUpdate = checkResult?.hasUpdate === true
  const restartHint = restartSupported
    ? t('admin.updates.restartAfterHint')
    : restartStatus?.reason
      ? t('admin.updates.restartUnsupported', { reason: restartStatus.reason })
      : t('admin.updates.restartUnavailable')

  const channelItems = CHANNELS.map((value) => ({
    value,
    label: t(`admin.updates.channel.${value}`),
  }))

  return (
    <SettingsSection
      id="dashboard-updates"
      title={t('admin.updates.title')}
      description={t('admin.updates.description')}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="min-h-[var(--control-height)] shrink-0"
            onClick={() => void handleCheck()}
            disabled={!canCheck}
            data-testid="updates-check"
          >
            <Icon
              name={checking ? 'loader-2' : 'refresh'}
              className={cn('size-3.5', checking && 'animate-spin')}
            />
            {checking ? t('admin.updates.checking') : t('admin.updates.check')}
          </Button>
          {showUpdate && (
            <Button
              variant="primary"
              className="min-h-[var(--control-height)] shrink-0"
              onClick={() => void handleApply()}
              disabled={updating || done !== null || unsupportedReason !== null}
              data-testid="updates-apply"
            >
              <Icon name="download" className="size-3.5" />
              {updating ? t('admin.updates.updating') : t('admin.updates.update')}
            </Button>
          )}
        </div>
      }
    >
      {settingsError && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {settingsError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 min-w-0" data-testid="updates-current">
        <span className="text-sm text-muted-foreground">{t('admin.updates.currentVersion')}</span>
        <span className="font-mono text-sm text-foreground">{SYNTH_VERSION}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
            installed === 'beta'
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
          data-testid="updates-channel-badge"
        >
          {t(`admin.updates.channel.${installed}`)}
        </span>
      </div>

      <SelectField
        label={t('admin.updates.channel')}
        description={t('admin.updates.channel.betaHint')}
        value={channel}
        onValueChange={(value) => {
          const next = asChannel(value)
          setChannel(next)
          setCheckResult(null)
          setCheckError(null)
          setUnsupportedReason(null)
          setUpdateError(null)
          setProgress([])
          setDone(null)
        }}
        triggerTestId="updates-channel"
        items={channelItems}
        disabled={settingsLoading}
      >
        <SelectContent>
          {channelItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectField>

      {channel === 'auto' && (
        <p className="text-xs text-muted-foreground break-words">
          {t('admin.updates.channel.autoHint')}
        </p>
      )}

      <div data-testid="updates-auto-check">
        <div className="flex items-start justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground break-words">
              {t('admin.updates.autoCheck')}
            </div>
            <p className="text-xs text-muted-foreground break-words">
              {t('admin.updates.autoCheckHint')}
            </p>
            {envLocked && (
              <p
                className="text-xs text-status-warning break-words"
                data-testid="updates-env-locked"
              >
                {t('admin.updates.envLocked')}
              </p>
            )}
          </div>
          <div className="shrink-0" data-testid="updates-auto-check-toggle">
            <Toggle
              enabled={autoCheck}
              onToggle={() => void handleToggleAuto()}
              ariaLabel={t('admin.updates.autoCheck')}
              disabled={!settings || envLocked}
              pending={savePending}
            />
          </div>
        </div>
        {saveError && (
          <div role="alert" className="mt-2 text-xs text-destructive break-words">
            {saveError}
          </div>
        )}
      </div>

      {checkError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="updates-check-error"
        >
          {checkError}
        </div>
      )}

      {checkResult && !checking && (
        <div
          className="space-y-1 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
          data-testid="updates-check-result"
        >
          <div
            className={cn(
              'text-sm font-medium break-words',
              checkResult.hasUpdate ? 'text-status-warning' : 'text-status-success',
            )}
            data-testid="updates-check-summary"
          >
            {checkResult.hasUpdate
              ? t('admin.updates.updateAvailable', { version: checkResult.latestVersion })
              : t('admin.updates.upToDate')}
          </div>
          <div className="text-xs text-muted-foreground break-words">
            {t('admin.updates.latestVersion')}:{' '}
            <span className="font-mono">{checkResult.latestVersion}</span>
            {checkResult.prerelease && ` · ${t('admin.updates.prerelease')}`}
          </div>
          {checkResult.registry && (
            <div className="text-xs text-muted-foreground break-words">
              {t('admin.updates.registry')}:{' '}
              <span className="font-mono">{checkResult.registry}</span>
            </div>
          )}
          <div className="text-xs text-muted-foreground break-words">
            {t('admin.updates.checkedAt', {
              date: formatDateTime(checkResult.checkedAt, locale),
            })}
          </div>
        </div>
      )}

      {unsupportedReason && (
        <div
          role="alert"
          className="space-y-1 rounded-lg bg-status-warning/10 p-3 text-sm text-status-warning"
          data-testid="updates-unsupported"
        >
          <div className="break-words">
            {t('admin.updates.unsupported', { reason: unsupportedReason })}
          </div>
          <div className="text-xs break-words">{t('admin.updates.unsupportedHint')}</div>
        </div>
      )}

      {showUpdate && (
        <div className="flex items-start gap-2 min-w-0" data-testid="updates-restart-option">
          <label
            className={cn(
              'flex flex-1 items-start gap-2 min-w-0',
              restartSupported ? 'cursor-pointer' : 'cursor-default opacity-60',
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={restartSupported && restartAfter}
              disabled={!restartSupported || updating}
              onChange={(e) => setRestartAfter(e.target.checked)}
              data-testid="updates-restart-after"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground break-words">
                {t('admin.updates.restartAfter')}
              </span>
              <span className="block text-xs text-muted-foreground break-words">
                {restartHint}
              </span>
            </span>
          </label>
        </div>
      )}

      {(updating || (progress.length > 0 && !done)) && (
        <div className="space-y-2 min-w-0" data-testid="updates-progress">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 text-sm font-medium text-foreground">
              <Icon name="loader-2" className="size-4 shrink-0 animate-spin" />
              <span className="min-w-0 break-words">{t('admin.updates.progressTitle')}</span>
            </div>
            {updating && (
              <Button
                variant="outline-muted"
                className="shrink-0"
                onClick={handleCancel}
                data-testid="updates-cancel"
              >
                {t('admin.updates.cancel')}
              </Button>
            )}
          </div>
          <pre
            className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-surface-inset p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
            data-testid="updates-log"
          >
            {progress.slice(-UPDATE_PROGRESS_VISIBLE_LINES).join('\n')}
          </pre>
        </div>
      )}

      {updateError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="updates-error"
        >
          {updateError}
        </div>
      )}

      {done && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-status-success/40 bg-status-success/10 p-3 min-w-0"
          data-testid="updates-done"
        >
          <div className="text-sm text-status-success break-words">
            {done.restartScheduled
              ? t('admin.updates.doneRestartScheduled')
              : t('admin.updates.doneNeedRestart')}
          </div>
          {done.version && (
            <div className="text-xs text-muted-foreground break-words">
              {t('admin.updates.doneVersion', { version: done.version })}
            </div>
          )}
          {done.message && (
            <div className="text-xs text-muted-foreground break-words">{done.message}</div>
          )}
          {restartSupported && !restartOverlay && (
            <Button
              variant="outline-primary"
              onClick={() => void handleRestartInstance()}
              data-testid="updates-restart-now"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('admin.updates.restartNow')}
            </Button>
          )}
        </div>
      )}

      {restartOverlay && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 p-4 backdrop-blur-sm"
          role="status"
          data-testid="updates-restart-overlay"
        >
          <Icon name="loader-2" className="size-6 animate-spin text-primary" />
          <div className="text-sm font-medium text-foreground">{t('admin.updates.restarting')}</div>
          <div className="text-xs text-muted-foreground text-center">
            {t('admin.updates.restartWaiting')}
          </div>
        </div>
      )}
    </SettingsSection>
  )
}
