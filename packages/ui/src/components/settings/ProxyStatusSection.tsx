import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  synthApi,
  type ProxyCheckResult,
  type ProxyConfigInput,
  type ProxyPasswordStatus,
  type ProxySettingsResponse,
  type ProxyStatusInfo,
  type ProxyTlsConfig,
} from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import {
  ListField,
  NumberField,
  SelectField,
  SettingsActions,
  SettingsRow,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'
import { SelectContent, SelectItem } from '../ui/select'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Поля формы (строки для текстовых, чтобы не терять ввод). */
interface ProxyDraft {
  enabled: boolean
  url: string
  httpProxy: string
  httpsProxy: string
  allProxy: string
  noProxy: string[]
  fromEnv: boolean
  fallbackDirect: boolean
  connectTimeoutMs: number
  authUsername: string
  tlsCaFile: string
  tlsCertFile: string
  tlsKeyFile: string
  rejectUnauthorized: boolean
}

type StatusExtras = {
  fromEnv?: boolean
  auth?: { type: 'basic'; username: string }
  tls?: ProxyTlsConfig
}

/**
 * Экранная форма из `GET /settings/proxy`: плоские поля — `saved`, доп. поля
 * (`fromEnv`/`auth`/`tls`) читаются опционально (старый сервер их не отдаёт).
 */
function draftFromStatus(status: ProxyStatusInfo, extras: StatusExtras): ProxyDraft {
  const flat = status as ProxyStatusInfo & StatusExtras
  const resolved: StatusExtras = {
    fromEnv: extras.fromEnv ?? flat.fromEnv,
    auth: extras.auth ?? flat.auth,
    tls: extras.tls ?? flat.tls,
  }
  return {
    enabled: flat.enabled,
    url: flat.url ?? '',
    httpProxy: flat.httpProxy ?? '',
    httpsProxy: flat.httpsProxy ?? '',
    allProxy: flat.allProxy ?? '',
    noProxy: [...(flat.noProxy ?? [])],
    fromEnv: resolved.fromEnv ?? true,
    fallbackDirect: flat.fallbackDirect,
    connectTimeoutMs: flat.connectTimeoutMs,
    authUsername: resolved.auth?.username ?? '',
    tlsCaFile: resolved.tls?.caFile ?? '',
    tlsCertFile: resolved.tls?.certFile ?? '',
    tlsKeyFile: resolved.tls?.keyFile ?? '',
    rejectUnauthorized: resolved.tls?.rejectUnauthorized ?? true,
  }
}

function draftFromInfo(info: ProxySettingsResponse): ProxyDraft {
  return draftFromStatus(info.saved, {
    fromEnv: info.fromEnv,
    auth: info.auth,
    tls: info.tls,
  })
}

function draftFromDefaults(info: ProxySettingsResponse): ProxyDraft {
  return draftFromStatus(info.defaults, {})
}

/** Черновик → тело `PUT /settings/proxy` (пустые поля не отправляются). */
export function proxyDraftToInput(draft: ProxyDraft): ProxyConfigInput {
  const input: ProxyConfigInput = {
    enabled: draft.enabled,
    noProxy: draft.noProxy.map((item) => item.trim()).filter(Boolean),
    fromEnv: draft.fromEnv,
    fallbackDirect: draft.fallbackDirect,
    connectTimeoutMs: draft.connectTimeoutMs,
  }
  const url = draft.url.trim()
  if (url) input.url = url
  const httpProxy = draft.httpProxy.trim()
  if (httpProxy) input.httpProxy = httpProxy
  const httpsProxy = draft.httpsProxy.trim()
  if (httpsProxy) input.httpsProxy = httpsProxy
  const allProxy = draft.allProxy.trim()
  if (allProxy) input.allProxy = allProxy
  const username = draft.authUsername.trim()
  if (username) input.auth = { type: 'basic', username }

  const tls: ProxyTlsConfig = {}
  const caFile = draft.tlsCaFile.trim()
  if (caFile) tls.caFile = caFile
  const certFile = draft.tlsCertFile.trim()
  if (certFile) tls.certFile = certFile
  const keyFile = draft.tlsKeyFile.trim()
  if (keyFile) tls.keyFile = keyFile
  // `true` — дефолт резолвера; храним только явный opt-out.
  if (!draft.rejectUnauthorized) tls.rejectUnauthorized = false
  if (Object.keys(tls).length > 0) input.tls = tls

  return input
}

const httpStatus = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

const errorText = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback

function StatusSummary({ status, testId }: { status: ProxyStatusInfo; testId: string }) {
  const { t } = useI18n()
  return (
    <div className="space-y-2 min-w-0" data-testid={testId}>
      <SettingsRow
        label={t('proxy.enabled')}
        control={
          <span
            data-testid={`${testId}-enabled`}
            className={cn(
              BADGE,
              status.enabled
                ? 'bg-status-success/15 text-status-success'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {status.enabled ? t('proxy.enabled') : t('proxy.disabled')}
          </span>
        }
      />
      <SettingsRow
        label={t('proxy.source')}
        control={
          <span data-testid={`${testId}-source`} className="text-sm text-foreground">
            {t(`proxy.source.${status.source}`)}
          </span>
        }
      />
      <SettingsRow
        label={t('proxy.url')}
        control={
          <span
            data-testid={`${testId}-url`}
            className="max-w-full break-all font-mono text-xs text-foreground"
          >
            {status.url ?? '—'}
          </span>
        }
      />
    </div>
  )
}

/**
 * ADR-099 / ADR-072: редактор egress-прокси (админ-категория «Встроенные
 * инструменты»).
 *
 * - Статус: `running` vs `saved` (enabled/source/redacted URL), `isOverridden`,
 *   `restartRequired` (настройка применяется при старте процесса).
 * - Форма: runtime-override (`PUT`/`DELETE`), auth — только `basic`, TLS/mTLS
 *   к прокси; пароль — write-only отдельным endpoint'ом (значение не хранится
 *   в config и никогда не показывается).
 * - Проверка соединения — к прокси, а не к цели (`usingSaved` без явного URL).
 */
export function ProxyStatusSection() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<ProxySettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [password, setPassword] = useState('')
  const [passwordPending, setPasswordPending] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<ProxyCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setInfo(await synthApi.getProxy())
    } catch (e) {
      const message = errorText(e, 'HTTP')
      setLoadError(t('proxy.error', { error: message }))
      notify({
        text: t('proxy.error', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setLoading(false)
    }
  }, [notify, t])

  useEffect(() => {
    void load()
  }, [load])

  // Мемоизируем: `useSettingsDraft` сравнивает value по идентичности в эффекте.
  const savedDraft = useMemo(() => (info ? draftFromInfo(info) : null), [info])
  const defaultsDraft = useMemo(() => (info ? draftFromDefaults(info) : null), [info])

  const draft = useSettingsDraft<ProxyDraft>({
    value: savedDraft,
    defaultValue: defaultsDraft,
  })
  const current = draft.draft
  const timeoutValid = (current?.connectTimeoutMs ?? 0) >= 1

  const handleSave = async () => {
    if (!current) return
    setSaving(true)
    try {
      const input = proxyDraftToInput(current)
      const resp = await synthApi.saveProxy(input)
      draft.setDraft(
        draftFromStatus(resp.saved, {
          fromEnv: input.fromEnv,
          auth: input.auth,
          tls: input.tls,
        }),
      )
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              ...resp,
              saved: resp.saved,
              running: resp.running,
              restartRequired: resp.restartRequired,
              isOverridden: true,
              // Синхронизируем редактируемые «extra»-поля с отправленным.
              fromEnv: input.fromEnv,
              auth: input.auth,
              tls: input.tls,
            }
          : prev,
      )
      notify({ text: t('proxy.savedToast'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: t('proxy.saveError', { error: errorText(e, 'HTTP') }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    try {
      const resp = await synthApi.resetProxy()
      draft.setDraft(draftFromStatus(resp.saved, {}))
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              ...resp,
              saved: resp.saved,
              defaults: resp.defaults,
              running: resp.running,
              restartRequired: resp.restartRequired,
              isOverridden: false,
              // Сброс к config: extra-поля неизвестны (как их отдаёт сервер).
              fromEnv: undefined,
              auth: undefined,
              tls: undefined,
            }
          : prev,
      )
      notify({ text: t('proxy.resetToast'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: t('proxy.resetError', { error: errorText(e, 'HTTP') }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const applyPasswordStatus = (next: ProxyPasswordStatus) => {
    setInfo((prev) => (prev ? { ...prev, password: next } : prev))
  }

  const passwordFromEnv = info?.password.source === 'env'

  const handleSetPassword = async () => {
    if (!password.trim()) {
      setPasswordError(t('proxy.password.required'))
      return
    }
    setPasswordPending(true)
    setPasswordError(null)
    try {
      applyPasswordStatus(await synthApi.setProxyPassword(password))
      setPassword('')
      notify({ text: t('proxy.password.setSuccess'), type: 'success', category: 'system' })
    } catch (e) {
      const conflict = httpStatus(e) === 409
      const message = conflict ? t('proxy.password.envConflict') : errorText(e, 'HTTP')
      setPasswordError(message)
      notify({
        text: conflict ? message : t('proxy.password.setError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPasswordPending(false)
    }
  }

  const handleClearPassword = async () => {
    if (passwordFromEnv) return
    const confirmed = await confirm({
      title: t('proxy.password.clearConfirmTitle'),
      message: t('proxy.password.clearConfirmMessage'),
      variant: 'warning',
    })
    if (!confirmed) return
    setPasswordPending(true)
    setPasswordError(null)
    try {
      applyPasswordStatus(await synthApi.clearProxyPassword())
      setPassword('')
      notify({ text: t('proxy.password.clearSuccess'), type: 'success', category: 'system' })
    } catch (e) {
      const conflict = httpStatus(e) === 409
      const message = conflict ? t('proxy.password.envConflict') : errorText(e, 'HTTP')
      setPasswordError(message)
      notify({
        text: conflict ? message : t('proxy.password.clearError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPasswordPending(false)
    }
  }

  const handleCheck = async () => {
    setChecking(true)
    setCheckResult(null)
    setCheckError(null)
    try {
      setCheckResult(await synthApi.checkProxy())
    } catch (e) {
      const message = errorText(e, 'HTTP')
      setCheckError(message)
      notify({
        text: t('proxy.checkError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingsSection title={t('proxy.title')} description={t('proxy.description')}>
      <div className="space-y-3 min-w-0" data-testid="proxy-status-section">
        {loading && !info && (
          <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
        )}

        {loadError && (
          <div
            role="alert"
            data-testid="proxy-status-error"
            className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm"
          >
            {loadError}
          </div>
        )}

        {info && (
          <>
            {/* Статус: running vs saved */}
            <div className="space-y-2 min-w-0 rounded-lg border border-border/60 bg-surface-inset p-3">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('proxy.status.running')}
                </span>
              </div>
              <StatusSummary status={info.running} testId="proxy-status-running" />

              <div className="flex items-center justify-between gap-2 min-w-0 border-t border-border/60 pt-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('proxy.status.saved')}
                </span>
                <span
                  data-testid="proxy-status-overridden"
                  className={cn(
                    BADGE,
                    info.isOverridden
                      ? 'bg-status-info/15 text-status-info'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {info.isOverridden ? t('proxy.status.overridden') : t('proxy.status.default')}
                </span>
              </div>
              <StatusSummary status={info.saved} testId="proxy-status-saved" />
            </div>

            {info.restartRequired && (
              <div
                data-testid="proxy-status-restart"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
              >
                <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('proxy.restartRequired')}</span>
              </div>
            )}

            {/* Форма runtime-override */}
            {current && (
              <>
                <div className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="text-sm font-medium text-foreground">{t('proxy.form.title')}</div>
                    {draft.dirty && (
                      <span className="text-xs text-status-warning">{t('proxy.form.unsaved')}</span>
                    )}
                  </div>

                  <ToggleField
                    label={t('proxy.form.enabled')}
                    description={t('proxy.form.enabledHint')}
                    enabled={current.enabled}
                    onToggle={() =>
                      draft.setDraft((prev) => (prev ? { ...prev, enabled: !prev.enabled } : prev))
                    }
                  />

                  <TextField
                    label={t('proxy.form.url')}
                    description={t('proxy.form.urlHelp')}
                    value={current.url}
                    onChange={(e) =>
                      draft.setDraft((prev) => (prev ? { ...prev, url: e.target.value } : prev))
                    }
                    placeholder="http://proxy.corp:3128"
                    mono
                    data-testid="proxy-form-url"
                  />

                  <TextField
                    label={t('proxy.form.httpProxy')}
                    description={t('proxy.form.schemeHelp')}
                    value={current.httpProxy}
                    onChange={(e) =>
                      draft.setDraft((prev) => (prev ? { ...prev, httpProxy: e.target.value } : prev))
                    }
                    placeholder="http://proxy.corp:3128"
                    mono
                    data-testid="proxy-form-http-proxy"
                  />

                  <TextField
                    label={t('proxy.form.httpsProxy')}
                    description={t('proxy.form.schemeHelp')}
                    value={current.httpsProxy}
                    onChange={(e) =>
                      draft.setDraft((prev) => (prev ? { ...prev, httpsProxy: e.target.value } : prev))
                    }
                    placeholder="http://proxy.corp:3128"
                    mono
                    data-testid="proxy-form-https-proxy"
                  />

                  <TextField
                    label={t('proxy.form.allProxy')}
                    description={t('proxy.form.schemeHelp')}
                    value={current.allProxy}
                    onChange={(e) =>
                      draft.setDraft((prev) => (prev ? { ...prev, allProxy: e.target.value } : prev))
                    }
                    placeholder="socks5://proxy.corp:1080"
                    mono
                    data-testid="proxy-form-all-proxy"
                  />

                  <ListField
                    label={t('proxy.form.noProxy')}
                    description={t('proxy.form.noProxyHelp')}
                    values={current.noProxy}
                    onChange={(noProxy) =>
                      draft.setDraft((prev) => (prev ? { ...prev, noProxy } : prev))
                    }
                    placeholder="10.0.0.0/8"
                    variant="chips"
                  />

                  <ToggleField
                    label={t('proxy.form.fromEnv')}
                    description={t('proxy.form.fromEnvHelp')}
                    enabled={current.fromEnv}
                    onToggle={() =>
                      draft.setDraft((prev) => (prev ? { ...prev, fromEnv: !prev.fromEnv } : prev))
                    }
                  />

                  <ToggleField
                    label={t('proxy.fallbackDirect')}
                    description={t('proxy.fallbackDirectHint')}
                    enabled={current.fallbackDirect}
                    onToggle={() =>
                      draft.setDraft((prev) =>
                        prev ? { ...prev, fallbackDirect: !prev.fallbackDirect } : prev,
                      )
                    }
                  />

                  {current.fallbackDirect && (
                    <div
                      role="alert"
                      data-testid="proxy-form-fallback-warning"
                      className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
                    >
                      <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 break-words">{t('proxy.fallbackDirectHint')}</span>
                    </div>
                  )}

                  <NumberField
                    label={t('proxy.form.connectTimeout')}
                    value={Number.isFinite(current.connectTimeoutMs) ? current.connectTimeoutMs : 0}
                    min={1}
                    suffix="ms"
                    error={timeoutValid ? undefined : t('proxy.form.connectTimeoutInvalid')}
                    onChange={(e) =>
                      draft.setDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              connectTimeoutMs: Number.isFinite(e.target.valueAsNumber)
                                ? e.target.valueAsNumber
                                : 0,
                            }
                          : prev,
                      )
                    }
                    data-testid="proxy-form-timeout"
                  />

                  <SelectField
                    label={t('proxy.form.authType')}
                    value="basic"
                    onValueChange={() => undefined}
                    disabled
                    triggerTestId="proxy-form-auth-type"
                  >
                    <SelectContent>
                      <SelectItem value="basic">{t('proxy.form.authBasic')}</SelectItem>
                    </SelectContent>
                  </SelectField>

                  <TextField
                    label={t('proxy.form.authUsername')}
                    description={t('proxy.form.authHelp')}
                    value={current.authUsername}
                    onChange={(e) =>
                      draft.setDraft((prev) =>
                        prev ? { ...prev, authUsername: e.target.value } : prev,
                      )
                    }
                    autoComplete="off"
                    data-testid="proxy-form-auth-username"
                  />

                  <div className="space-y-3 min-w-0 border-t border-border/60 pt-3">
                    <div className="text-sm font-medium text-foreground">{t('proxy.form.tls')}</div>
                    <p className="text-xs text-muted-foreground">{t('proxy.form.tlsHelp')}</p>

                    <TextField
                      label={t('proxy.form.tlsCaFile')}
                      value={current.tlsCaFile}
                      onChange={(e) =>
                        draft.setDraft((prev) =>
                          prev ? { ...prev, tlsCaFile: e.target.value } : prev,
                        )
                      }
                      placeholder="/etc/synth/proxy-ca.pem"
                      mono
                      data-testid="proxy-form-tls-ca-file"
                    />
                    <TextField
                      label={t('proxy.form.tlsCertFile')}
                      value={current.tlsCertFile}
                      onChange={(e) =>
                        draft.setDraft((prev) =>
                          prev ? { ...prev, tlsCertFile: e.target.value } : prev,
                        )
                      }
                      placeholder="/etc/synth/proxy-client.crt"
                      mono
                      data-testid="proxy-form-tls-cert-file"
                    />
                    <TextField
                      label={t('proxy.form.tlsKeyFile')}
                      value={current.tlsKeyFile}
                      onChange={(e) =>
                        draft.setDraft((prev) =>
                          prev ? { ...prev, tlsKeyFile: e.target.value } : prev,
                        )
                      }
                      placeholder="/etc/synth/proxy-client.key"
                      mono
                      data-testid="proxy-form-tls-key-file"
                    />
                    <ToggleField
                      label={t('proxy.form.tlsRejectUnauthorized')}
                      enabled={current.rejectUnauthorized}
                      onToggle={() =>
                        draft.setDraft((prev) =>
                          prev ? { ...prev, rejectUnauthorized: !prev.rejectUnauthorized } : prev,
                        )
                      }
                    />
                  </div>

                  <SettingsActions
                    onSave={() => void handleSave()}
                    onCancel={() => draft.revert()}
                    onReset={() => void handleReset()}
                    saveDisabled={loading || !draft.dirty || !timeoutValid}
                    cancelDisabled={!draft.dirty}
                    resetDisabled={loading}
                    isDefault={draft.isDefault}
                    saving={saving}
                    saveTestId="proxy-save"
                    cancelTestId="proxy-cancel"
                    resetTestId="proxy-reset"
                  />
                </div>
              </>
            )}

            {/* Пароль Basic: write-only, значение никогда не отображается */}
            <div className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3">
              <div>
                <div className="text-sm font-medium text-foreground">{t('proxy.password.title')}</div>
                <p className="text-xs text-muted-foreground">{t('proxy.password.description')}</p>
              </div>

              <SettingsRow
                label={t('proxy.password.source')}
                control={
                  <span data-testid="proxy-password-status" className="text-sm text-foreground">
                    {t(`proxy.password.source.${info.password.source}`)}
                  </span>
                }
              />

              {passwordFromEnv && (
                <div
                  data-testid="proxy-password-env-hint"
                  className="flex items-start gap-2 rounded-lg bg-interactive-hover p-2 text-xs text-muted-foreground"
                >
                  <Icon name="information" className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{t('proxy.password.envDisabled')}</span>
                </div>
              )}

              <div className="flex flex-wrap items-end gap-2 min-w-0">
                <TextField
                  label={t('proxy.password.placeholder')}
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (passwordError) setPasswordError(null)
                  }}
                  disabled={passwordFromEnv || passwordPending}
                  autoComplete="new-password"
                  containerClassName="flex-1 min-w-48"
                  data-testid="proxy-password-input"
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void handleSetPassword()}
                  disabled={passwordFromEnv || passwordPending || !password.trim()}
                  data-testid="proxy-password-set"
                >
                  {t('proxy.password.set')}
                </Button>
                <Button
                  variant="outline-muted"
                  className="shrink-0"
                  onClick={() => void handleClearPassword()}
                  disabled={passwordFromEnv || passwordPending || !info.password.set}
                  data-testid="proxy-password-clear"
                >
                  {t('proxy.password.clear')}
                </Button>
              </div>

              {passwordError && (
                <div
                  role="alert"
                  data-testid="proxy-password-error"
                  className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {passwordError}
                </div>
              )}
            </div>

            {/* Проверка соединения с прокси (saved-конфигурация) */}
            <div className="space-y-2 min-w-0 border-t border-border/60 pt-3">
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void handleCheck()}
                disabled={checking}
                data-testid="proxy-check-button"
              >
                <Icon name="link" className="size-3.5" />
                {checking ? t('proxy.checking') : t('proxy.check')}
              </Button>

              {checkError && (
                <div
                  role="alert"
                  data-testid="proxy-check-error"
                  className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {t('proxy.checkError', { error: checkError })}
                </div>
              )}

              {checkResult && (
                <div
                  role="status"
                  data-testid="proxy-check-result"
                  className={cn(
                    'space-y-1 rounded-lg p-2 text-xs',
                    checkResult.reachable
                      ? 'bg-status-success/10 text-status-success'
                      : 'bg-destructive/10 text-destructive',
                  )}
                >
                  <div className="font-medium">
                    {checkResult.reachable ? t('proxy.reachable') : t('proxy.unreachable')}
                  </div>
                  <div className="text-muted-foreground">
                    {t('proxy.check.target')}:{' '}
                    {checkResult.usingSaved ? t('proxy.check.usingSaved') : t('proxy.check.usingUrl')}
                  </div>
                  {checkResult.reachable && checkResult.latencyMs !== undefined && (
                    <div className="tabular-nums">
                      {t('proxy.latency', {
                        latency: Math.max(0, Math.round(checkResult.latencyMs)),
                      })}
                    </div>
                  )}
                  {checkResult.authChallenge && (
                    <div>
                      {t('proxy.authChallenge', { challenge: checkResult.authChallenge })}
                    </div>
                  )}
                  {checkResult.error && (
                    <div className="min-w-0 break-words">{checkResult.error}</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  )
}
