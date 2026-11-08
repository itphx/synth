import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import {
  NumberField,
  SettingsActions,
  SettingsSection,
} from '@/components/ui/settings'
import {
  requestLimitsApi,
  type RequestLimitsSettings as RequestLimitsView,
  type RequestLimitsSource,
} from '@/lib/api/requestLimits'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const SOURCE_BADGE_CLASS: Record<RequestLimitsSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/**
 * «Лимиты запросов» — лимит тяжёлых операций с сессиями (импорт/экспорт/форк/
 * merge) на креденту, запросов в минуту (`0` — без лимита).
 *
 * `GET/PUT/DELETE /api/v2/settings/limits`; применяется сразу, без рестарта.
 * При env-фиксации сервер отвечает `409`, контрол блокируется. Мутации — ADMIN
 * (guard сервера). Секция встраивается в раздел «Безопасность».
 */
export function RequestLimitsSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<RequestLimitsView | null>(null)
  const [draft, setDraft] = useState('0')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [envConflict, setEnvConflict] = useState(false)

  const apply = useCallback((next: RequestLimitsView) => {
    setInfo(next)
    setDraft(String(next.sessionOpsPerMinute))
    setEnvConflict(next.envLocked === true || next.source === 'env')
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      apply(await requestLimitsApi.getRequestLimits())
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.security.requestLimits.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [apply, t])

  useEffect(() => {
    void load()
  }, [load])

  const value = info?.sessionOpsPerMinute ?? 0
  const source: RequestLimitsSource = info?.source ?? 'default'
  const locked = envConflict || info?.envLocked === true || source === 'env'
  const canReset = source === 'runtime' && !locked

  const parsed = Number(draft.trim())
  const valid = draft.trim() !== '' && Number.isInteger(parsed) && parsed >= 0
  const dirty = valid && parsed !== value

  const handleSave = useCallback(async () => {
    if (!info || saving || locked || !valid || !dirty) return
    setSaving(true)
    setActionError(null)
    try {
      apply(await requestLimitsApi.setRequestLimits(parsed))
      notify({ text: t('settings.security.requestLimits.saved'), type: 'success', category: 'system' })
    } catch (err) {
      if (statusOf(err) === 409) {
        setEnvConflict(true)
        setActionError(t('settings.security.requestLimits.conflict'))
      } else {
        setActionError(
          t('settings.security.requestLimits.saveError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        )
      }
    } finally {
      setSaving(false)
    }
  }, [apply, dirty, info, locked, notify, parsed, saving, t, valid])

  const handleReset = useCallback(async () => {
    if (saving || locked) return
    setSaving(true)
    setActionError(null)
    try {
      apply(await requestLimitsApi.resetRequestLimits())
      notify({ text: t('settings.security.requestLimits.resetDone'), type: 'success', category: 'system' })
    } catch (err) {
      setActionError(
        t('settings.security.requestLimits.resetError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
    } finally {
      setSaving(false)
    }
  }, [apply, locked, notify, saving, t])

  return (
    <SettingsSection
      id="request-limits"
      title={t('settings.security.requestLimits.title')}
      description={t('settings.security.requestLimits.description')}
      tooltip={t('settings.help.security.requestLimits')}
    >
      {loadError && (
        <div
          role="alert"
          data-testid="request-limits-load-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.security.requestLimits.retry')}
          </Button>
        </div>
      )}

      {loading && !info && (
        <div className="py-3 text-center text-xs text-muted-foreground" data-testid="request-limits-loading">
          {t('common.loading')}
        </div>
      )}

      {info && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="request-limits-badges">
            <span
              data-testid="request-limits-source-badge"
              className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
            >
              {t(`settings.security.requestLimits.source.${source}`)}
            </span>
          </div>

          {locked && (
            <div
              role="status"
              data-testid="request-limits-env-banner"
              className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
            >
              <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{t('settings.security.requestLimits.envBanner')}</span>
            </div>
          )}

          <NumberField
            id="request-limits-input"
            data-testid="request-limits-input"
            label={t('settings.security.requestLimits.field')}
            description={t('settings.security.requestLimits.fieldHint')}
            value={draft}
            min={0}
            step={1}
            disabled={locked || saving}
            error={!valid ? t('settings.security.requestLimits.fieldInvalid') : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />

          <p className="text-xs text-muted-foreground min-w-0">
            {t('settings.security.requestLimits.defaults', { value: String(info.defaults) })}
          </p>

          {actionError && (
            <div
              role="alert"
              data-testid="request-limits-action-error"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0 break-words"
            >
              {actionError}
            </div>
          )}

          <SettingsActions
            onSave={() => void handleSave()}
            onReset={canReset ? () => void handleReset() : undefined}
            saveDisabled={!dirty || locked || saving}
            resetDisabled={saving}
            saving={saving}
            resetLabel={t('settings.security.requestLimits.reset')}
          />
        </>
      )}
    </SettingsSection>
  )
}
