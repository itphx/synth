import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'

import {
  synthApi,
  type ProxyStatusInfo,
  type TlsGetResponse,
  type TlsStatus,
  type TlsStatusMapping,
  type TlsValidateResult,
} from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import {
  ListField,
  SettingsRow,
  SettingsSection,
  TextArea,
  TextField,
  ToggleField,
} from '../ui/settings'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'
const FILE_INPUT =
  'block w-full min-w-0 text-xs text-muted-foreground file:mr-2 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-interactive-hover file:px-2 file:py-1 file:text-xs file:text-foreground'

type ProxyTlsMeta = NonNullable<ProxyStatusInfo['tls']>

/** Чтение PEM-файла как текста (File.text → FileReader fallback для jsdom). */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read error'))
    reader.readAsText(file)
  })
}

/** Несколько `.pem`-файлов → один бандл (пустые отбрасываются). */
async function readPemFiles(files: FileList | null): Promise<string> {
  if (!files || files.length === 0) return ''
  const parts = await Promise.all([...files].map(readFileText))
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
}

const isConflict = (err: unknown): boolean =>
  typeof (err as { status?: unknown })?.status === 'number' &&
  (err as { status: number }).status === 409

function SourceBadge({ source }: { source: TlsStatus['ca']['source'] }) {
  const { t } = useI18n()
  return (
    <span className={cn(BADGE, 'bg-interactive-hover text-muted-foreground')}>
      {t(`network.tls.source.${source}`)}
    </span>
  )
}

function ValidateResult({ result, testId }: { result: TlsValidateResult; testId: string }) {
  const { t } = useI18n()
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'space-y-1 rounded-lg p-2 text-xs',
        result.ok
          ? 'bg-status-success/10 text-status-success'
          : 'bg-destructive/10 text-destructive',
      )}
    >
      <div className="font-medium">
        {result.ok ? t('network.tls.validate.ok') : t('network.tls.validate.failed')}
      </div>
      {result.caCount !== undefined && (
        <div>{t('network.tls.validate.caResult', { count: result.caCount })}</div>
      )}
      {result.caSubjects && result.caSubjects.length > 0 && (
        <div className="min-w-0 break-words">
          {t('network.tls.validate.caSubjects', { subjects: result.caSubjects.join(', ') })}
        </div>
      )}
      {result.certSubject && <div className="min-w-0 break-words font-mono">{result.certSubject}</div>}
      {result.keyMatches && <div>{t('network.tls.validate.keyMatches')}</div>}
      {result.errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {result.errors.map((error) => (
            <li key={error} className="min-w-0 break-words">
              {error}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * ADR-099 / ADR-072: секция «Доверенные CA (TLS)» раздела «Сеть».
 *
 * Trust-бандл CA, default-клиентский сертификат (mTLS) и per-host маппинги.
 * Все изменения — bootstrap (`restartRequired`). PEM/ключи никогда не
 * отображаются: upload/validate только передают их на сервер; в DOM и state
 * после операции ничего не остаётся. Read-only слой env/config показывается
 * отдельным блоком «Из параметров».
 */
export function TrustedCaSection() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<TlsGetResponse | null>(null)
  const [proxyTls, setProxyTls] = useState<ProxyTlsMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [rejectPending, setRejectPending] = useState(false)

  // CA
  const [caPem, setCaPem] = useState('')
  const [caValidating, setCaValidating] = useState(false)
  const [caValidate, setCaValidate] = useState<TlsValidateResult | null>(null)
  const [caError, setCaError] = useState<string | null>(null)
  const [caPending, setCaPending] = useState(false)

  // Default client
  const [clientCertPem, setClientCertPem] = useState('')
  const [clientKeyPem, setClientKeyPem] = useState('')
  const [clientValidating, setClientValidating] = useState(false)
  const [clientValidate, setClientValidate] = useState<TlsValidateResult | null>(null)
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientPending, setClientPending] = useState(false)

  // Mappings form
  const [editing, setEditing] = useState<TlsStatusMapping | '__new__' | null>(null)
  const [mHosts, setMHosts] = useState<string[]>([])
  const [mLabel, setMLabel] = useState('')
  const [mCertPem, setMCertPem] = useState('')
  const [mKeyPem, setMKeyPem] = useState('')
  const [mValidating, setMValidating] = useState(false)
  const [mValidate, setMValidate] = useState<TlsValidateResult | null>(null)
  const [mError, setMError] = useState<string | null>(null)
  const [mSaving, setMSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [tls, proxy] = await Promise.all([
        synthApi.getTls(),
        synthApi.getProxy().catch(() => null),
      ])
      setInfo(tls)
      setProxyTls(proxy?.saved?.tls ?? null)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'HTTP'
      setLoadError(t('network.tls.saveError', { error: message }))
      notify({
        text: t('network.tls.saveError', { error: message }),
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

  const mutationError = (e: unknown): string =>
    isConflict(e) ? t('network.tls.conflict') : e instanceof Error ? e.message : 'HTTP'

  const notifyError = (
    e: unknown,
    key: 'network.tls.saveError' | 'network.tls.deleteError',
  ): void => {
    notify({
      text: t(key, { error: mutationError(e) }),
      type: 'error',
      category: 'error',
    })
  }

  const caEnvReadOnly = info?.ca.source === 'env' || info?.params.ca?.source === 'env'

  const runCaValidate = async (): Promise<TlsValidateResult | null> => {
    if (!caPem.trim()) {
      setCaError(t('network.tls.validate.required'))
      return null
    }
    setCaValidating(true)
    setCaError(null)
    setCaValidate(null)
    try {
      const result = await synthApi.validateTls({ caPem })
      setCaValidate(result)
      if (!result.ok) setCaError(result.errors.join('; ') || t('network.tls.validate.failed'))
      return result
    } catch (e) {
      setCaError(t('network.tls.validateError', { error: e instanceof Error ? e.message : 'HTTP' }))
      return null
    } finally {
      setCaValidating(false)
    }
  }

  const handleCaUpload = async () => {
    const result = await runCaValidate()
    if (!result?.ok) return
    setCaPending(true)
    setCaError(null)
    try {
      await synthApi.uploadCa(caPem)
      setCaPem('')
      setCaValidate(null)
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      setCaError(mutationError(e))
      notifyError(e, 'network.tls.saveError')
    } finally {
      setCaPending(false)
    }
  }

  const handleCaReset = async () => {
    const ok = await confirm({
      title: t('network.tls.ca.resetConfirmTitle'),
      message: t('network.tls.ca.resetConfirmMessage'),
      variant: 'warning',
    })
    if (!ok) return
    setCaPending(true)
    setCaError(null)
    try {
      await synthApi.removeCa()
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      setCaError(mutationError(e))
      notifyError(e, 'network.tls.deleteError')
    } finally {
      setCaPending(false)
    }
  }

  const handleToggleReject = async () => {
    if (!info) return
    setRejectPending(true)
    try {
      await synthApi.updateTls({ rejectUnauthorized: !info.rejectUnauthorized })
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notifyError(e, 'network.tls.saveError')
    } finally {
      setRejectPending(false)
    }
  }

  const clientReadOnly =
    info?.defaultClient?.readOnly === true ||
    info?.params.client?.readOnly === true ||
    info?.params.client?.source === 'env' ||
    info?.params.client?.source === 'config'

  const runClientValidate = async (): Promise<TlsValidateResult | null> => {
    if (!clientCertPem.trim() || !clientKeyPem.trim()) {
      setClientError(t('network.tls.validate.required'))
      return null
    }
    setClientValidating(true)
    setClientError(null)
    setClientValidate(null)
    try {
      const result = await synthApi.validateTls({
        certPem: clientCertPem,
        keyPem: clientKeyPem,
      })
      setClientValidate(result)
      if (!result.ok) setClientError(result.errors.join('; ') || t('network.tls.validate.failed'))
      return result
    } catch (e) {
      setClientError(
        t('network.tls.validateError', { error: e instanceof Error ? e.message : 'HTTP' }),
      )
      return null
    } finally {
      setClientValidating(false)
    }
  }

  const handleClientUpload = async () => {
    const result = await runClientValidate()
    if (!result?.ok) return
    setClientPending(true)
    setClientError(null)
    try {
      await synthApi.setDefaultClient(clientCertPem, clientKeyPem)
      setClientCertPem('')
      setClientKeyPem('')
      setClientValidate(null)
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      setClientError(mutationError(e))
      notifyError(e, 'network.tls.saveError')
    } finally {
      setClientPending(false)
    }
  }

  const handleClientDelete = async () => {
    const ok = await confirm({
      title: t('network.tls.client.deleteConfirmTitle'),
      message: t('network.tls.client.deleteConfirmMessage'),
      variant: 'danger',
    })
    if (!ok) return
    setClientPending(true)
    setClientError(null)
    try {
      await synthApi.removeDefaultClient()
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      setClientError(mutationError(e))
      notifyError(e, 'network.tls.deleteError')
    } finally {
      setClientPending(false)
    }
  }

  const openAddMapping = () => {
    setEditing('__new__')
    setMHosts([])
    setMLabel('')
    setMCertPem('')
    setMKeyPem('')
    setMValidate(null)
    setMError(null)
  }

  const openEditMapping = (mapping: TlsStatusMapping) => {
    setEditing(mapping)
    setMHosts([...mapping.hosts])
    setMLabel(mapping.label ?? '')
    setMCertPem('')
    setMKeyPem('')
    setMValidate(null)
    setMError(null)
  }

  const closeMappingForm = () => {
    setEditing(null)
    setMCertPem('')
    setMKeyPem('')
    setMValidate(null)
    setMError(null)
  }

  const runMappingValidate = async (): Promise<TlsValidateResult | null> => {
    if (mHosts.length === 0) {
      setMError(t('network.tls.validate.required'))
      return null
    }
    if ((mCertPem.trim() === '') !== (mKeyPem.trim() === '')) {
      setMError(t('network.tls.validate.required'))
      return null
    }
    setMValidating(true)
    setMError(null)
    setMValidate(null)
    try {
      const result = await synthApi.validateTls({
        hosts: mHosts,
        ...(mCertPem.trim() && mKeyPem.trim()
          ? { certPem: mCertPem, keyPem: mKeyPem }
          : {}),
      })
      setMValidate(result)
      if (!result.ok) setMError(result.errors.join('; ') || t('network.tls.validate.failed'))
      return result
    } catch (e) {
      setMError(t('network.tls.validateError', { error: e instanceof Error ? e.message : 'HTTP' }))
      return null
    } finally {
      setMValidating(false)
    }
  }

  const handleMappingSave = async () => {
    if (editing === null) return
    const isNew = editing === '__new__'
    if (isNew && (!mCertPem.trim() || !mKeyPem.trim())) {
      setMError(t('network.tls.validate.required'))
      return
    }
    const result = await runMappingValidate()
    if (!result?.ok) return
    setMSaving(true)
    setMError(null)
    try {
      if (isNew) {
        await synthApi.createTlsMapping({
          hosts: mHosts,
          ...(mLabel.trim() ? { label: mLabel.trim() } : {}),
          certPem: mCertPem,
          keyPem: mKeyPem,
        })
      } else {
        const mapping = editing as TlsStatusMapping
        await synthApi.updateTlsMapping(mapping.id, {
          hosts: mHosts,
          label: mLabel.trim() || null,
          ...(mCertPem.trim() && mKeyPem.trim()
            ? { certPem: mCertPem, keyPem: mKeyPem }
            : {}),
        })
      }
      closeMappingForm()
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      setMError(mutationError(e))
      notifyError(e, 'network.tls.saveError')
    } finally {
      setMSaving(false)
    }
  }

  const handleMappingDelete = async (mapping: TlsStatusMapping) => {
    const ok = await confirm({
      title: t('network.tls.mappings.deleteConfirmTitle'),
      message: t('network.tls.mappings.deleteConfirmMessage'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await synthApi.deleteTlsMapping(mapping.id)
      await load()
      notify({ text: t('network.tls.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notifyError(e, 'network.tls.deleteError')
    }
  }

  const handleFiles = async (
    event: ChangeEvent<HTMLInputElement>,
    apply: (pem: string) => void,
  ) => {
    try {
      const pem = await readPemFiles(event.target.files)
      if (pem) apply(pem)
    } catch (e) {
      notify({
        text: t('network.tls.validateError', {
          error: e instanceof Error ? e.message : String(e),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      event.target.value = ''
    }
  }

  return (
    <SettingsSection title={t('network.tls.title')} description={t('network.tls.description')}>
      <div className="space-y-3 min-w-0" data-testid="tls-section">
        {loading && !info && (
          <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
        )}

        {loadError && (
          <div
            role="alert"
            data-testid="tls-load-error"
            className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm"
          >
            {loadError}
          </div>
        )}

        {info && (
          <>
            {/* Статус */}
            <div className="space-y-2 min-w-0 rounded-lg border border-border/60 bg-surface-inset p-3">
              <SettingsRow
                label={t('network.tls.status.ca')}
                control={
                  <span className="flex flex-wrap items-center justify-end gap-1.5">
                    <SourceBadge source={info.ca.source} />
                    <span
                      data-testid="tls-status-ca-count"
                      className="text-sm text-foreground tabular-nums"
                    >
                      {t('network.tls.status.caCount', { count: info.ca.count })}
                    </span>
                  </span>
                }
              />
              {info.ca.subjects.length > 0 && (
                <div className="flex flex-wrap gap-1.5 min-w-0" data-testid="tls-status-ca-subjects">
                  {info.ca.subjects.map((subject) => (
                    <span
                      key={subject}
                      className="inline-flex max-w-full rounded-full bg-interactive-hover px-2 py-0.5 font-mono text-[0.6875rem] text-foreground"
                    >
                      <span className="min-w-0 truncate">{subject}</span>
                    </span>
                  ))}
                </div>
              )}

              <ToggleField
                label={t('network.tls.status.rejectUnauthorized')}
                enabled={info.rejectUnauthorized}
                onToggle={() => void handleToggleReject()}
                disabled={rejectPending}
              />

              {info.defaultClient && (
                <>
                  <SettingsRow
                    label={t('network.tls.status.client')}
                    control={
                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        <SourceBadge source={info.defaultClient.source} />
                        {info.defaultClient.readOnly && (
                          <span className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}>
                            {t('network.tls.readOnly.badge')}
                          </span>
                        )}
                      </span>
                    }
                  />
                  {info.defaultClient.certSubject && (
                    <div
                      data-testid="tls-status-client-subject"
                      className="min-w-0 break-words font-mono text-xs text-muted-foreground"
                    >
                      {t('network.tls.status.clientSubject')}: {info.defaultClient.certSubject}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {t('network.tls.status.clientKey')}:{' '}
                    {info.defaultClient.hasKey
                      ? t('network.tls.status.clientKeySet')
                      : t('network.tls.status.clientKeyMissing')}
                  </div>
                </>
              )}
            </div>

            {info.restartRequired && (
              <div
                data-testid="tls-restart"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
              >
                <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('network.tls.restartRequired')}</span>
              </div>
            )}

            {/* Read-only параметры env/config */}
            {(info.params.ca || info.params.client) && (
              <div
                data-testid="tls-params"
                className="space-y-2 min-w-0 rounded-lg border border-dashed border-border/70 p-3"
              >
                <div className="text-sm font-medium text-foreground">
                  {t('network.tls.params.title')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('network.tls.params.description')}
                </p>

                {info.params.ca && (
                  <div data-testid="tls-params-ca" className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-medium text-foreground">
                        {t('network.tls.params.ca')}
                      </span>
                      <SourceBadge source={info.params.ca.source} />
                      <span className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}>
                        {t('network.tls.readOnly.badge')}
                      </span>
                    </div>
                    <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {info.params.ca.caFile
                        ? `${t('network.tls.params.caFile')}: ${info.params.ca.caFile}`
                        : info.params.ca.hasPem
                          ? t('network.tls.params.caPem')
                          : '—'}
                    </div>
                  </div>
                )}

                {info.params.client && (
                  <div data-testid="tls-params-client" className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-medium text-foreground">
                        {t('network.tls.params.client')}
                      </span>
                      <SourceBadge source={info.params.client.source} />
                      {info.params.client.readOnly && (
                        <span className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}>
                          {t('network.tls.readOnly.badge')}
                        </span>
                      )}
                    </div>
                    {info.params.client.certFile && (
                      <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                        {t('network.tls.params.certFile')}: {info.params.client.certFile}
                      </div>
                    )}
                    {info.params.client.keyFile && (
                      <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                        {t('network.tls.params.keyFile')}: {info.params.client.keyFile}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* CA */}
            <div className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {t('network.tls.ca.title')}
                </div>
                {caEnvReadOnly && (
                  <span
                    data-testid="tls-ca-readonly"
                    className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}
                  >
                    {t('network.tls.readOnly.badge')}
                  </span>
                )}
              </div>

              {caEnvReadOnly ? (
                <p className="text-xs text-muted-foreground">{t('network.tls.ca.envReadOnly')}</p>
              ) : (
                <>
                  {info.ca.source === 'none' && (
                    <p className="text-xs text-muted-foreground">{t('network.tls.ca.empty')}</p>
                  )}
                  <TextArea
                    label={t('network.tls.ca.pem')}
                    description={t('network.tls.ca.pemHelp')}
                    value={caPem}
                    onChange={(e) => {
                      setCaPem(e.target.value)
                      if (caError) setCaError(null)
                      if (caValidate) setCaValidate(null)
                    }}
                    placeholder={t('network.tls.ca.placeholder')}
                    rows={5}
                    mono
                    disabled={caPending}
                    data-testid="tls-ca-input"
                  />
                  <input
                    type="file"
                    accept=".pem,.crt,.cer"
                    multiple
                    aria-label={t('network.tls.ca.file')}
                    className={FILE_INPUT}
                    disabled={caPending}
                    onChange={(e) => void handleFiles(e, setCaPem)}
                    data-testid="tls-ca-file"
                  />

                  {caValidate && <ValidateResult result={caValidate} testId="tls-ca-result" />}
                  {caError && (
                    <div
                      role="alert"
                      data-testid="tls-ca-error"
                      className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                    >
                      {caError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runCaValidate()}
                      disabled={caValidating || !caPem.trim() || caPending}
                      data-testid="tls-ca-validate"
                    >
                      {t('network.tls.ca.validate')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleCaUpload()}
                      disabled={caValidating || caPending || !caPem.trim()}
                      data-testid="tls-ca-upload"
                    >
                      {t('network.tls.ca.upload')}
                    </Button>
                    <Button
                      variant="outline-muted"
                      size="sm"
                      onClick={() => void handleCaReset()}
                      disabled={caPending || info.ca.source !== 'runtime'}
                      data-testid="tls-ca-reset"
                    >
                      {t('network.tls.ca.reset')}
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Default client */}
            <div className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {t('network.tls.client.title')}
                </div>
                {clientReadOnly && (
                  <span
                    data-testid="tls-client-readonly"
                    className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}
                  >
                    {t('network.tls.readOnly.badge')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('network.tls.client.description')}
              </p>

              {clientReadOnly ? (
                <p className="text-xs text-muted-foreground">{t('network.tls.client.readOnly')}</p>
              ) : (
                <>
                  <label className="block space-y-1 min-w-0">
                    <span className="text-sm font-medium text-foreground">
                      {t('network.tls.client.cert')}
                    </span>
                    <input
                      type="file"
                      accept=".pem,.crt,.cer"
                      className={FILE_INPUT}
                      disabled={clientPending}
                      onChange={(e) => void handleFiles(e, setClientCertPem)}
                      data-testid="tls-client-cert-file"
                    />
                  </label>
                  <label className="block space-y-1 min-w-0">
                    <span className="text-sm font-medium text-foreground">
                      {t('network.tls.client.key')}
                    </span>
                    <input
                      type="file"
                      accept=".pem,.key"
                      className={FILE_INPUT}
                      disabled={clientPending}
                      onChange={(e) => void handleFiles(e, setClientKeyPem)}
                      data-testid="tls-client-key-file"
                    />
                  </label>

                  {clientValidate && (
                    <ValidateResult result={clientValidate} testId="tls-client-result" />
                  )}
                  {clientError && (
                    <div
                      role="alert"
                      data-testid="tls-client-error"
                      className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                    >
                      {clientError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runClientValidate()}
                      disabled={clientValidating || clientPending}
                      data-testid="tls-client-validate"
                    >
                      {t('network.tls.client.validate')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleClientUpload()}
                      disabled={clientValidating || clientPending}
                      data-testid="tls-client-upload"
                    >
                      {t('network.tls.client.upload')}
                    </Button>
                    <Button
                      variant="outline-muted"
                      size="sm"
                      onClick={() => void handleClientDelete()}
                      disabled={clientPending || !info.defaultClient}
                      data-testid="tls-client-delete"
                    >
                      {t('network.tls.client.delete')}
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Mappings */}
            <div className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {t('network.tls.mappings.title')}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openAddMapping}
                  disabled={editing !== null}
                  data-testid="tls-mapping-add"
                >
                  <Icon name="add" className="size-3.5" />
                  {t('network.tls.mappings.add')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('network.tls.mappings.firstMatch')}
              </p>

              {info.mappings.length === 0 ? (
                <p data-testid="tls-mappings-empty" className="text-xs text-muted-foreground">
                  {t('network.tls.mappings.empty')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs" data-testid="tls-mappings">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">{t('network.tls.mappings.hosts')}</th>
                        <th className="px-2 py-1.5 font-medium">{t('network.tls.mappings.label')}</th>
                        <th className="px-2 py-1.5 font-medium">
                          {t('network.tls.mappings.certSubject')}
                        </th>
                        <th className="px-2 py-1.5 font-medium">
                          {t('network.tls.mappings.source')}
                        </th>
                        <th className="px-2 py-1.5 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {info.mappings.map((mapping) => (
                        <tr
                          key={mapping.id}
                          className="border-t border-border align-top"
                          data-testid={`tls-mapping-${mapping.id}`}
                        >
                          <td className="px-2 py-2">
                            <span className="flex flex-wrap gap-1">
                              {mapping.hosts.map((host) => (
                                <span
                                  key={host}
                                  className="rounded-full bg-interactive-hover px-1.5 py-0.5 font-mono"
                                >
                                  {host}
                                </span>
                              ))}
                            </span>
                          </td>
                          <td className="px-2 py-2 min-w-0 break-words">{mapping.label ?? '—'}</td>
                          <td className="px-2 py-2 min-w-0 break-words font-mono text-muted-foreground">
                            {mapping.certSubject ?? '—'}
                          </td>
                          <td className="px-2 py-2">
                            <SourceBadge source={mapping.source} />
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditMapping(mapping)}
                                disabled={editing !== null}
                                aria-label={t('network.tls.mappings.edit')}
                                data-testid={`tls-mapping-edit-${mapping.id}`}
                              >
                                <Icon name="edit-2" className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="hover:text-destructive"
                                onClick={() => void handleMappingDelete(mapping)}
                                aria-label={t('network.tls.mappings.delete')}
                                data-testid={`tls-mapping-delete-${mapping.id}`}
                              >
                                <Icon name="delete-bin" className="size-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {editing !== null && (
                <div
                  className="space-y-3 min-w-0 rounded-lg border border-border/60 bg-surface-inset p-3"
                  data-testid="tls-mapping-form"
                >
                  <div className="text-sm font-medium text-foreground">
                    {editing === '__new__'
                      ? t('network.tls.mappings.formAddTitle')
                      : t('network.tls.mappings.formEditTitle')}
                  </div>

                  <ListField
                    label={t('network.tls.mappings.formHosts')}
                    description={t('network.tls.mappings.formHostsHelp')}
                    values={mHosts}
                    onChange={setMHosts}
                    placeholder="api.corp.local"
                    variant="chips"
                  />

                  <TextField
                    label={t('network.tls.mappings.formLabel')}
                    placeholder={t('network.tls.mappings.formLabelPlaceholder')}
                    value={mLabel}
                    onChange={(e) => setMLabel(e.target.value)}
                    data-testid="tls-mapping-label"
                  />

                  {editing !== '__new__' && (
                    <p className="text-xs text-muted-foreground">
                      {t('network.tls.mappings.certOptional')}
                    </p>
                  )}

                  <label className="block space-y-1 min-w-0">
                    <span className="text-sm font-medium text-foreground">
                      {t('network.tls.mappings.formCert')}
                    </span>
                    <input
                      type="file"
                      accept=".pem,.crt,.cer"
                      className={FILE_INPUT}
                      onChange={(e) => void handleFiles(e, setMCertPem)}
                      data-testid="tls-mapping-cert-file"
                    />
                  </label>
                  <label className="block space-y-1 min-w-0">
                    <span className="text-sm font-medium text-foreground">
                      {t('network.tls.mappings.formKey')}
                    </span>
                    <input
                      type="file"
                      accept=".pem,.key"
                      className={FILE_INPUT}
                      onChange={(e) => void handleFiles(e, setMKeyPem)}
                      data-testid="tls-mapping-key-file"
                    />
                  </label>

                  {editing === '__new__' && (
                    <p className="text-xs text-muted-foreground">
                      {t('network.tls.mappings.validateFirst')}
                    </p>
                  )}

                  {mValidate && <ValidateResult result={mValidate} testId="tls-mapping-result" />}
                  {mError && (
                    <div
                      role="alert"
                      data-testid="tls-mapping-error"
                      className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                    >
                      {mError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runMappingValidate()}
                      disabled={mValidating || mSaving || mHosts.length === 0}
                      data-testid="tls-mapping-validate"
                    >
                      {t('network.tls.ca.validate')}
                    </Button>
                    <Button
                      variant="outline-muted"
                      size="sm"
                      onClick={closeMappingForm}
                      disabled={mSaving}
                      data-testid="tls-mapping-cancel"
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleMappingSave()}
                      disabled={mValidating || mSaving || mHosts.length === 0}
                      data-testid="tls-mapping-save"
                    >
                      {t('common.save')}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* TLS к прокси — справочно, редактируется в блоке «Прокси» */}
            <div className="space-y-1 min-w-0 rounded-lg border border-dashed border-border/70 p-3">
              <div className="text-sm font-medium text-foreground">{t('network.tls.proxy.title')}</div>
              <p className="text-xs text-muted-foreground">{t('network.tls.proxy.note')}</p>
              {proxyTls ? (
                <div
                  data-testid="tls-proxy-tls"
                  className="space-y-0.5 font-mono text-xs text-muted-foreground"
                >
                  {proxyTls.caFile && (
                    <div className="break-all">
                      {t('network.tls.proxy.caFile')}: {proxyTls.caFile}
                    </div>
                  )}
                  {proxyTls.certFile && (
                    <div className="break-all">
                      {t('network.tls.proxy.certFile')}: {proxyTls.certFile}
                    </div>
                  )}
                  {proxyTls.keyFile && (
                    <div className="break-all">
                      {t('network.tls.proxy.keyFile')}: {proxyTls.keyFile}
                    </div>
                  )}
                  {proxyTls.hasCaPem && <div>{t('network.tls.proxy.hasCaPem')}</div>}
                  <div>
                    {t('network.tls.proxy.rejectUnauthorized')}:{' '}
                    {proxyTls.rejectUnauthorized ? t('proxy.enabled') : t('proxy.disabled')}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">—</p>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  )
}
