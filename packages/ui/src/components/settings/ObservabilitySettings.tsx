import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '../icon/Icon'
import {
  InfoField,
  SettingsActions,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'
import {
  synthApi,
  type MetricsSettingsInfo,
  type MetricsStatus,
  type MetricsTokenSource,
} from '@/lib/api/synthApi'
import { formatBytes } from './MaintenanceSettings'

/** Период фонового обновления статуса: состояние читается без перезагрузки. */
export const STATUS_POLL_INTERVAL_MS = 15_000

/**
 * Пример `scrape_config` для Prometheus: job `synth`, exposition на
 * `/metrics`, интервал 15 c. Цели — сервис backend внутри сети инстанса.
 */
export const SCRAPE_CONFIG = `scrape_configs:
  - job_name: synth
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ['synth-backend:5000']`

/**
 * Человекочитаемый uptime процесса: дни/часы/минуты/секунды.
 * Две старшие единицы — достаточно для админ-панели.
 */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secs = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

/** Статус HTTP-ошибки (для 409 «токен задан через env»). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа источника настройки. */
const SOURCE_BADGE_CLASS: Record<MetricsSettingsInfo['source'], string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

const TOKEN_SOURCE: Record<MetricsTokenSource, string> = {
  env: 'observability.token.source.env',
  file: 'observability.token.source.file',
  none: 'observability.token.source.none',
}

/**
 * ADR-072: админ-раздел «Метрики» — состояние экспорта Prometheus,
 * runtime-настройка `enabled` (`GET/PUT/DELETE /settings/metrics`), write-only
 * bearer-токен и эндпоинты `/metrics`, `/ready`. Мутации — ADMIN (guard сервера).
 *
 * `GET /metrics` выключен по умолчанию, токен задаётся только через env/файл
 * (значение в UI не показывается). Изменения экспорта применяются при старте
 * процесса, поэтому `restartRequired` → кнопка перезапуска (ADR-092).
 */
export function ObservabilitySettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<MetricsSettingsInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(true)
  const [infoError, setInfoError] = useState<string | null>(null)

  const [status, setStatus] = useState<MetricsStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const [tokenInput, setTokenInput] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenDeleting, setTokenDeleting] = useState(false)

  const draft = useSettingsDraft<{ enabled: boolean }>({
    value: info?.metrics ?? null,
    defaultValue: info?.defaults ?? null,
  })

  const loadInfo = useCallback(async () => {
    setInfoLoading(true)
    setInfoError(null)
    try {
      setInfo(await synthApi.get())
    } catch (err) {
      setInfoError(err instanceof Error ? err.message : t('observability.loadError'))
    } finally {
      setInfoLoading(false)
    }
  }, [t])

  /** `silent` — фоновый опрос: без индикатора загрузки и без мигания ошибки. */
  const loadStatus = useCallback(
    async (silent = false) => {
      if (!silent) setStatusLoading(true)
      setStatusError(null)
      try {
        setStatus(await synthApi.status())
      } catch (err) {
        if (!silent) {
          setStatusError(err instanceof Error ? err.message : t('observability.statusError'))
        }
      } finally {
        if (!silent) setStatusLoading(false)
      }
    },
    [t],
  )

  useEffect(() => {
    void loadInfo()
    void loadStatus()
  }, [loadInfo, loadStatus])

  // Статус обновляется раз в 15 c; таймер снимается на unmount.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadStatus(true)
    }, STATUS_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  const source = info?.source ?? status?.source
  const envLocked = source === 'env'
  const restartRequired = info?.restartRequired ?? status?.restartRequired ?? false

  const tokenSource: MetricsTokenSource = status?.token.source ?? info?.token.source ?? 'none'
  const tokenConfigured = status?.token.configured ?? info?.token.configured ?? false
  const tokenEnvLocked = tokenSource === 'env'

  /** Понятная ошибка токена: 409 — значение задано через env и в UI не меняется. */
  const describeTokenError = useCallback(
    (err: unknown, fallback: string): string =>
      statusOf(err) === 409 ? t('observability.token.conflict') : fallback,
    [t],
  )

  const handleSave = useCallback(async () => {
    if (!draft.draft || envLocked) return
    setSaving(true)
    try {
      await synthApi.setEnabled(draft.draft.enabled)
      await Promise.all([loadInfo(), loadStatus(true)])
      notify({ text: t('observability.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('observability.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [draft.draft, envLocked, loadInfo, loadStatus, notify, t])

  const handleReset = useCallback(async () => {
    if (envLocked) return
    setSaving(true)
    try {
      await synthApi.reset()
      await Promise.all([loadInfo(), loadStatus(true)])
      notify({ text: t('observability.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('observability.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [envLocked, loadInfo, loadStatus, notify, t])

  /** «Перезапустить инстанс» (ADR-092): graceful shutdown, применяет настройки. */
  const handleRestart = useCallback(async () => {
    if (restarting) return
    const ok = await confirm({
      title: t('observability.restart.confirmTitle'),
      message: t('observability.restart.confirm'),
      confirmLabel: t('observability.restart.button'),
      variant: 'danger',
      icon: 'refresh',
    })
    if (!ok) return
    setRestarting(true)
    try {
      await synthApi.restartInstance()
      notify({ text: t('observability.restart.started'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('observability.restart.error', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setRestarting(false)
    }
  }, [notify, restarting, t])

  const handleSetToken = useCallback(async () => {
    if (tokenEnvLocked) return
    const value = tokenInput.trim()
    if (!value) {
      setTokenError(t('observability.token.required'))
      return
    }
    setTokenSaving(true)
    setTokenError(null)
    try {
      await synthApi.setToken(value)
      setTokenInput('')
      setTokenVisible(false)
      await Promise.all([loadInfo(), loadStatus(true)])
      notify({ text: t('observability.token.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = describeTokenError(
        err,
        t('observability.token.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
      setTokenError(message)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setTokenSaving(false)
    }
  }, [describeTokenError, loadInfo, loadStatus, notify, t, tokenEnvLocked, tokenInput])

  const handleDeleteToken = useCallback(async () => {
    if (tokenEnvLocked || tokenDeleting) return
    const ok = await confirm({
      title: t('observability.token.deleteTitle'),
      message: t('observability.token.deleteConfirm'),
      confirmLabel: t('observability.token.delete'),
      variant: 'danger',
      icon: 'key',
    })
    if (!ok) return
    setTokenDeleting(true)
    setTokenError(null)
    try {
      await synthApi.deleteToken()
      setTokenVisible(false)
      await Promise.all([loadInfo(), loadStatus(true)])
      notify({ text: t('observability.token.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      const message = describeTokenError(
        err,
        t('observability.token.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
      setTokenError(message)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setTokenDeleting(false)
    }
  }, [describeTokenError, loadInfo, loadStatus, notify, t, tokenDeleting, tokenEnvLocked])

  /** Копирование в буфер обмена; `false` — clipboard недоступен или запись не удалась. */
  const copy = useCallback(
    (text: string, successText?: string): Promise<boolean> => {
      const clipboard = navigator.clipboard
      if (!clipboard?.writeText) return Promise.resolve(false)
      return clipboard.writeText(text).then(
        () => {
          notify({
            text: successText ?? t('observability.copied'),
            type: 'success',
            category: 'system',
          })
          return true
        },
        () => false,
      )
    },
    [notify, t],
  )

  /** Криптостойкий bearer-токен: 32 байта → base64url без padding (43 символа). */
  const handleGenerateToken = useCallback(async () => {
    if (tokenEnvLocked) return
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const value = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    setTokenInput(value)
    setTokenVisible(true)
    setTokenError(null)
    const copied = await copy(value, t('observability.token.generatedCopied'))
    if (!copied) {
      notify({
        text: t('observability.token.generatedManual'),
        type: 'success',
        category: 'system',
      })
    }
  }, [copy, notify, t, tokenEnvLocked])

  const currentEnabled = draft.draft?.enabled ?? false

  return (
    <SettingsPanel title={t('observability.title')} description={t('observability.description')}>
      {/* 1. Состояние: источник, экспорт, readiness, хранилище, exposition */}
      <SettingsSection
        title={t('observability.status.title')}
        description={t('observability.status.description')}
      >
        {statusError && (
          <div
            role="alert"
            data-testid="observability-status-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {statusError}
          </div>
        )}

        {statusLoading && !status && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {status && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="observability-badges">
              <span
                data-testid="observability-source-badge"
                className={cn(BADGE, SOURCE_BADGE_CLASS[status.source])}
              >
                {t(`observability.source.${status.source}`)}
              </span>
              <span
                data-testid="observability-enabled-badge"
                className={cn(
                  BADGE,
                  status.enabled
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {status.enabled
                  ? t('observability.state.enabled')
                  : t('observability.state.disabled')}
              </span>
              <span
                data-testid="observability-running-badge"
                className={cn(
                  BADGE,
                  status.running
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-status-warning/15 text-status-warning',
                )}
              >
                {status.running
                  ? t('observability.state.running')
                  : t('observability.state.notRunning')}
              </span>
            </div>

            <div className="space-y-1.5 min-w-0" data-testid="observability-status">
              <InfoField
                label={t('observability.field.ready')}
                value={
                  status.ready ? t('observability.ready.ok') : t('observability.ready.fail')
                }
                mono
              />
              <InfoField
                label={t('observability.field.storage')}
                value={t(`observability.storage.${status.storage}`)}
                mono
              />
              <InfoField
                label={t('observability.field.storageBackend')}
                value={status.storageBackend}
                mono
              />
              <InfoField
                label={t('observability.field.version')}
                value={status.version}
                mono
              />
              <InfoField
                label={t('observability.field.uptime')}
                value={formatUptime(status.uptimeSec)}
                mono
              />
              <InfoField
                label={t('observability.field.series')}
                value={String(status.exposition.series)}
                mono
              />
              <InfoField
                label={t('observability.field.expositionSize')}
                value={formatBytes(status.exposition.bytes)}
                mono
              />
              <InfoField
                label={t('observability.field.droppedSeries')}
                value={String(status.exposition.droppedSeries)}
                mono
              />
            </div>
          </>
        )}
      </SettingsSection>

      {/* 2. Экспорт: черновик enabled + Save/Reset + restartRequired */}
      <SettingsSection
        title={t('observability.export.title')}
        description={t('observability.export.description')}
      >
        {infoError && (
          <div
            role="alert"
            data-testid="observability-info-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {infoError}
          </div>
        )}

        {infoLoading && !info && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {restartRequired && (
          <div
            data-testid="observability-restart"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
          >
            <span className="flex min-w-0 items-start gap-2">
              <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{t('observability.restartRequired')}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void handleRestart()}
              disabled={restarting}
              data-testid="observability-restart-button"
            >
              <Icon name="refresh" className={cn('size-3.5', restarting && 'animate-spin')} />
              {t('observability.restart.button')}
            </Button>
          </div>
        )}

        {info && (
          <>
            <ToggleField
              label={t('observability.export.enabled')}
              description={t('observability.export.enabledHint')}
              enabled={currentEnabled}
              disabled={envLocked}
              onToggle={() => draft.update({ enabled: !currentEnabled })}
              ariaLabel={t('observability.export.enabled')}
            />

            {envLocked && (
              <p
                data-testid="observability-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('observability.export.envLocked')}
              </p>
            )}

            <SettingsActions
              onSave={() => void handleSave()}
              onCancel={() => draft.revert()}
              onReset={() => void handleReset()}
              saving={saving}
              saveDisabled={envLocked || !draft.dirty}
              cancelDisabled={!draft.dirty}
              resetDisabled={envLocked}
              isDefault={draft.isDefault}
              saveTestId="observability-save"
              cancelTestId="observability-cancel"
              resetTestId="observability-reset"
            />
          </>
        )}
      </SettingsSection>

      {/* 3. Токен: write-only, env/файл, 409 — понятной ошибкой */}
      <SettingsSection
        title={t('observability.token.title')}
        description={t('observability.token.description')}
      >
        <div className="space-y-1.5 min-w-0" data-testid="observability-token-status">
          <InfoField
            label={t('observability.token.state')}
            value={
              tokenConfigured
                ? t('observability.token.configured')
                : t('observability.token.notConfigured')
            }
          />
          <InfoField
            label={t('observability.field.source')}
            value={t(TOKEN_SOURCE[tokenSource])}
          />
        </div>

        <p className="text-xs text-muted-foreground break-words">
          {t('observability.token.writeOnly')}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end min-w-0">
          <TextField
            type={tokenVisible ? 'text' : 'password'}
            label={t('observability.token.field')}
            placeholder={t('observability.token.placeholder')}
            value={tokenInput}
            onChange={(e) => {
              setTokenInput(e.target.value)
              setTokenVisible(false)
              setTokenError(null)
            }}
            disabled={tokenEnvLocked}
            autoComplete={tokenVisible ? 'off' : 'new-password'}
            mono
            containerClassName="flex-1 min-w-0"
            id="observability-token"
            data-testid="observability-token-input"
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9 p-0"
              onClick={() => void handleGenerateToken()}
              disabled={tokenEnvLocked || tokenSaving || tokenDeleting}
              aria-label={t('observability.token.generate')}
              title={t('observability.token.generate')}
              data-testid="observability-token-generate"
            >
              <Icon name="refresh" className="size-3.5" />
            </Button>
            <Button
              variant="primary"
              className="h-9"
              onClick={() => void handleSetToken()}
              disabled={tokenEnvLocked || tokenSaving}
              data-testid="observability-token-set"
            >
              <Icon name="check" className="size-3.5" />
              {t('observability.token.set')}
            </Button>
            <Button
              variant="danger"
              className="h-9"
              onClick={() => void handleDeleteToken()}
              disabled={tokenEnvLocked || !tokenConfigured || tokenDeleting}
              data-testid="observability-token-delete"
            >
              <Icon name="delete-bin" className="size-3.5" />
              {t('observability.token.delete')}
            </Button>
          </div>
        </div>

        {tokenEnvLocked && (
          <p data-testid="observability-token-env" className="text-xs text-status-warning break-words">
            {t('observability.token.envLocked')}
          </p>
        )}

        {tokenError && (
          <p
            role="alert"
            data-testid="observability-token-error"
            className="text-xs text-destructive break-words"
          >
            {tokenError}
          </p>
        )}
      </SettingsSection>

      {/* 4. Эндпоинты: /metrics (копирование), /ready, обновление статуса */}
      <SettingsSection
        title={t('observability.endpoints.title')}
        description={t('observability.endpoints.description')}
      >
        <SettingsRow
          label="/metrics"
          description={t('observability.endpoints.metrics')}
          control={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy(status?.endpoints.metrics ?? '/metrics')}
              aria-label={t('observability.copy')}
              data-testid="observability-copy-metrics"
            >
              <Icon name="file-copy" className="size-3.5" />
              {t('observability.copy')}
            </Button>
          }
        />

        <SettingsRow
          label="/ready"
          description={t('observability.endpoints.ready')}
          control={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy(status?.endpoints.ready ?? '/ready')}
              aria-label={t('observability.copy')}
              data-testid="observability-copy-ready"
            >
              <Icon name="file-copy" className="size-3.5" />
              {t('observability.copy')}
            </Button>
          }
        />

        <Button
          variant="outline"
          onClick={() => void loadStatus()}
          disabled={statusLoading}
          data-testid="observability-refresh"
        >
          <Icon name="refresh" className={cn('size-3.5', statusLoading && 'animate-spin')} />
          {statusLoading ? t('observability.refreshing') : t('observability.refresh')}
        </Button>
      </SettingsSection>

      {/* 5. Подсказки: scrape_config */}
      <SettingsSection
        title={t('observability.hints.title')}
        description={t('observability.hints.description')}
      >
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <span className="text-xs text-muted-foreground break-words">
              {t('observability.hints.scrape')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => void copy(SCRAPE_CONFIG)}
              data-testid="observability-copy-scrape"
            >
              <Icon name="file-copy" className="size-3.5" />
              {t('observability.hints.copy')}
            </Button>
          </div>
          <pre
            className="overflow-x-auto rounded-lg bg-surface-inset p-3 font-mono text-[0.6875rem] text-foreground"
            data-testid="observability-scrape-config"
          >
            {SCRAPE_CONFIG}
          </pre>
        </div>
      </SettingsSection>
    </SettingsPanel>
  )
}
