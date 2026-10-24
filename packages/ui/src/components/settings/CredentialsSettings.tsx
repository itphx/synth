import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ExternalCredentialMeta } from '@itphx/synth-shared'

import { synthApi } from '@/lib/api/synthApi'
import type {
  OAuthAuthorizationStart,
  OAuthCredentialCreateInput,
  OAuthFlowKind,
} from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { useMcpStore } from '@/stores/mcpStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { SegmentedControl, SettingsPanel, SettingsSection, TextField } from '../ui/settings'

/**
 * ADR-105 Ф4: раздел «Доступы» — внешние доступы к OAuth-коннекторам.
 *
 * Секрет наружу не отдаётся **никогда**: в списке показывается только маска
 * (`secretMask`) — необратимая сводка. Значение токена живёт только на сервере
 * (`engine/mcp/credential-auth.ts`).
 *
 * Раздел личный (группа `personal`): пользователь видит свои доступы, доступы
 * проекта, участником которого он является, а `ADMIN`/`LEAD` — все. Право на
 * мутации проверяет сервер (инвариант 16), UI лишь прячет недоступное.
 */

/** Статусы доступа (ADR-105 Ф0). */
const CREDENTIAL_STATUSES = ['active', 'expired', 'revoked', 'error'] as const
type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number]

/** Статусы, для которых переавторизация осмысленна. */
const REFRESHABLE_STATUSES: readonly CredentialStatus[] = ['active', 'expired', 'error']

interface ApiErrorLike {
  status?: number
  code?: string
}

/**
 * Понятное сообщение об ошибке по статусу/коду ответа (ADR-105 Ф4).
 * Текст сервера — запасной вариант: клиентские формулировки стабильнее.
 */
function describeError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const status = (err as ApiErrorLike)?.status
  const code = (err as ApiErrorLike)?.code
  if (code === 'OAUTH_PROVIDER_UNKNOWN') return t('credentials.errors.providerUnknown')
  if (status === 401) return t('credentials.errors.unauthorized')
  if (status === 403) return t('credentials.errors.forbidden')
  if (status === 404) return t('credentials.errors.notFound')
  if (status === 409) return t('credentials.errors.conflict')
  return err instanceof Error && err.message ? err.message : t('credentials.errors.generic')
}

/** Разбор списка scope'ов из свободного текста (через запятую/пробел). */
export function parseScopesInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
}

export function CredentialsSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const [credentials, setCredentials] = useState<ExternalCredentialMeta[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  // Форма выдачи доступа.
  const [formOpen, setFormOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [scopesInput, setScopesInput] = useState('')
  const [flowKind, setFlowKind] = useState<OAuthFlowKind>('authorize')
  const [providerError, setProviderError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Незавершённая выдача: PKCE (ссылка + код) либо device flow (код + адрес).
  const [pendingFlow, setPendingFlow] = useState<OAuthAuthorizationStart | null>(null)
  const [devicePending, setDevicePending] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)

  // Привязка к MCP-коннектору (ADR-105 Ф3).
  const registry = useMcpStore((s) => s.registry)
  const fetchRegistry = useMcpStore((s) => s.fetchRegistry)
  const [bindFor, setBindFor] = useState<string | null>(null)
  const [bindConnectorId, setBindConnectorId] = useState('')

  const connectors = useMemo(
    () => (registry ?? []).map((entry) => ({ id: entry.id, name: entry.name })),
    [registry],
  )

  const loadCredentials = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { credentials: list } = await synthApi.getOAuthCredentials()
      setCredentials(list)
    } catch (err) {
      setError(describeError(err, t))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadCredentials()
  }, [loadCredentials])

  useEffect(() => {
    // Реестр MCP нужен только для выбора коннектора; его отсутствие не
    // ломает раздел — кнопка привязки просто не показывается.
    void fetchRegistry()
  }, [fetchRegistry])

  const resetForm = () => {
    setProvider('')
    setScopesInput('')
    setFlowKind('authorize')
    setProviderError(null)
    setFormError(null)
    setPendingFlow(null)
    setDevicePending(false)
    setCode('')
    setCodeError(null)
  }

  const closeForm = () => {
    setFormOpen(false)
    resetForm()
  }

  /** Общая обработка ответа выдачи: старт / ожидание / завершение. */
  const handleFlowResponse = async (
    response: Awaited<ReturnType<typeof synthApi.createOAuthCredential>>,
    currentProvider: string,
  ): Promise<void> => {
    if (response.flow === 'completed') {
      setPendingFlow(null)
      setDevicePending(false)
      setCode('')
      closeForm()
      await loadCredentials()
      notify({ text: t('credentials.created'), type: 'success', category: 'system' })
      return
    }
    if (response.flow === 'pending') {
      setDevicePending(true)
      return
    }
    // Старт выдачи: PKCE (ссылка) либо device flow (код + адрес).
    setPendingFlow(response)
    setDevicePending(false)
    if (response.userCode || response.verificationUri) {
      notify({ text: t('credentials.deviceStarted'), type: 'info', category: 'system' })
      return
    }
    notify({
      text: t(response.authorizationUrl ? 'credentials.authorizeStarted' : 'credentials.deviceStarted'),
      type: 'info',
      category: 'system',
    })
    void currentProvider
  }

  const handleStart = async () => {
    const trimmedProvider = provider.trim()
    if (!trimmedProvider) {
      setProviderError(t('credentials.form.providerRequired'))
      return
    }
    setProviderError(null)
    setFormError(null)
    setCreating(true)
    try {
      const scopes = parseScopesInput(scopesInput)
      const input: OAuthCredentialCreateInput = {
        provider: trimmedProvider,
        flow: flowKind,
        ...(scopes.length > 0 ? { scopes } : {}),
      }
      const response = await synthApi.createOAuthCredential(input)
      await handleFlowResponse(response, trimmedProvider)
    } catch (err) {
      setFormError(describeError(err, t))
    } finally {
      setCreating(false)
    }
  }

  /** Завершение PKCE-выдачи: обмен кода авторизации на токены. */
  const handleSubmitCode = async () => {
    const trimmedCode = code.trim()
    if (!trimmedCode) {
      setCodeError(t('credentials.form.codeRequired'))
      return
    }
    if (!pendingFlow) return
    setCodeError(null)
    setFormError(null)
    setCreating(true)
    try {
      const response = await synthApi.createOAuthCredential({
        provider: provider.trim(),
        flow: 'authorize',
        code: trimmedCode,
        state: pendingFlow.state,
      })
      await handleFlowResponse(response, provider.trim())
    } catch (err) {
      setFormError(describeError(err, t))
    } finally {
      setCreating(false)
    }
  }

  /** Опрос device-flow: сервер отвечает `pending`, пока код не подтверждён. */
  const handlePollDevice = async () => {
    if (!pendingFlow) return
    setFormError(null)
    setCreating(true)
    try {
      const response = await synthApi.createOAuthCredential({
        provider: provider.trim(),
        flow: 'device',
        state: pendingFlow.state,
      })
      await handleFlowResponse(response, provider.trim())
    } catch (err) {
      setFormError(describeError(err, t))
    } finally {
      setCreating(false)
    }
  }

  /** Переавторизация: форсированный refresh токена. */
  const handleRefresh = async (credential: ExternalCredentialMeta) => {
    setPendingId(credential.id)
    try {
      await synthApi.refreshOAuthCredential(credential.id)
      await loadCredentials()
      notify({ text: t('credentials.refreshed'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('credentials.refreshError', { error: describeError(err, t) }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  /** Отзыв доступа — через ConfirmDialog (не `window.confirm`). */
  const handleRevoke = async (credential: ExternalCredentialMeta) => {
    const ok = await confirm({
      title: t('credentials.revokeTitle'),
      message: t('credentials.revokeConfirm', { provider: credential.provider }),
      confirmLabel: t('credentials.revoke'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setPendingId(credential.id)
    try {
      await synthApi.deleteOAuthCredential(credential.id)
      await loadCredentials()
      notify({ text: t('credentials.revoked'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('credentials.revokeError', { error: describeError(err, t) }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  /** Привязка доступа к MCP-коннектору. */
  const handleBind = async (credential: ExternalCredentialMeta) => {
    const connectorId = bindConnectorId.trim()
    if (!connectorId) return
    setPendingId(credential.id)
    try {
      await synthApi.bindOAuthCredential(credential.id, connectorId)
      setBindFor(null)
      setBindConnectorId('')
      await loadCredentials()
      notify({ text: t('credentials.bound'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('credentials.bindError', { error: describeError(err, t) }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      notify({ text: t('credentials.copied'), type: 'success', category: 'system' })
    })
  }

  const count = credentials?.length ?? 0
  const deviceFlow = Boolean(pendingFlow?.userCode || pendingFlow?.verificationUri)

  const statusBadge = (status: CredentialStatus) => (
    <span
      data-testid={`credentials-status-${status}`}
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
        status === 'active' && 'bg-status-success/15 text-status-success',
        status === 'expired' && 'bg-status-warning/15 text-status-warning',
        status === 'revoked' && 'bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground',
        status === 'error' && 'bg-destructive/15 text-destructive',
      )}
    >
      {t(`credentials.status.${status}`)}
    </span>
  )

  return (
    <SettingsPanel
      title={t('credentials.title')}
      description={t('credentials.description')}
      meta={t('credentials.count', { count })}
    >
      <SettingsSection
        id="credentials-list"
        className="credentials-panel"
        title={t('credentials.listTitle')}
        description={t('credentials.listDescription')}
        actions={
          <Button
            variant="outline"
            className="min-h-[var(--control-height)] shrink-0"
            onClick={() => {
              if (formOpen) {
                closeForm()
              } else {
                resetForm()
                setFormOpen(true)
              }
            }}
            data-testid="credentials-add"
          >
            <Icon name={formOpen ? 'close' : 'add'} className="size-3.5" />
            {formOpen ? t('common.cancel') : t('credentials.add')}
          </Button>
        }
      >
        {error && (
          <div
            role="alert"
            data-testid="credentials-load-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {formOpen && (
          <div
            className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="credentials-form"
          >
            <p className="text-sm font-medium text-foreground">{t('credentials.form.title')}</p>

            {formError && (
              <div
                role="alert"
                data-testid="credentials-form-error"
                className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
              >
                {formError}
              </div>
            )}

            <TextField
              label={t('credentials.form.provider')}
              tooltip={t('credentials.form.providerTooltip')}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
                if (providerError) setProviderError(null)
              }}
              error={providerError ?? undefined}
              placeholder="github"
              required
              id="credentials-provider"
              data-testid="credentials-provider"
            />

            <TextField
              label={t('credentials.form.scopes')}
              tooltip={t('credentials.form.scopesTooltip')}
              value={scopesInput}
              onChange={(e) => setScopesInput(e.target.value)}
              placeholder="repo, read:user"
              id="credentials-scopes"
              data-testid="credentials-scopes"
            />

            <div className="space-y-1.5 min-w-0">
              <span className="text-xs font-medium text-foreground">
                {t('credentials.form.flow')}
              </span>
              <SegmentedControl
                value={flowKind}
                onChange={(value) => {
                  setFlowKind(value)
                  setPendingFlow(null)
                  setDevicePending(false)
                }}
                ariaLabel={t('credentials.form.flow')}
                options={[
                  { value: 'authorize', label: t('credentials.form.flow.authorize') },
                  { value: 'device', label: t('credentials.form.flow.device') },
                ]}
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline-muted"
                onClick={closeForm}
                disabled={creating}
                data-testid="credentials-create-cancel"
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleStart()}
                disabled={creating}
                data-testid="credentials-create-save"
              >
                {creating ? t('common.saving') : t('credentials.form.start')}
              </Button>
            </div>

            {pendingFlow?.authorizationUrl && (
              <div
                className="space-y-2 rounded-lg border border-border/60 bg-background p-2.5 min-w-0"
                data-testid="credentials-authorize"
              >
                <p className="text-xs font-medium text-foreground">
                  {t('credentials.form.authorizationUrl')}
                </p>
                <p className="break-words text-[0.6875rem] text-muted-foreground">
                  {t('credentials.form.authorizationHint')}
                </p>
                <div className="flex items-center gap-2 min-w-0">
                  <a
                    href={pendingFlow.authorizationUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="min-w-0 flex-1 break-all font-mono text-[0.6875rem] text-primary underline"
                    data-testid="credentials-authorization-url"
                  >
                    {pendingFlow.authorizationUrl}
                  </a>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 min-h-[var(--control-height)]"
                    onClick={() => copy(pendingFlow.authorizationUrl as string)}
                    title={t('common.copy')}
                    aria-label={t('common.copy')}
                    data-testid="credentials-authorization-copy"
                  >
                    <Icon name="file-copy" className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}

            {deviceFlow && pendingFlow && (
              <div
                className="space-y-2 rounded-lg border border-border/60 bg-background p-2.5 min-w-0"
                data-testid="credentials-device"
              >
                <p className="text-xs font-medium text-foreground">
                  {t('credentials.form.deviceTitle')}
                </p>
                {pendingFlow.userCode && (
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                      {t('credentials.form.deviceCode')}:
                    </span>
                    <code
                      className="min-w-0 break-all rounded bg-background px-2 py-1 font-mono text-xs"
                      data-testid="credentials-device-code"
                    >
                      {pendingFlow.userCode}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 min-h-[var(--control-height)]"
                      onClick={() => copy(pendingFlow.userCode as string)}
                      title={t('common.copy')}
                      aria-label={t('common.copy')}
                      data-testid="credentials-device-copy"
                    >
                      <Icon name="file-copy" className="size-3.5" />
                    </Button>
                  </div>
                )}
                {(pendingFlow.verificationUriComplete || pendingFlow.verificationUri) && (
                  <a
                    href={pendingFlow.verificationUriComplete ?? pendingFlow.verificationUri}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block min-w-0 break-all font-mono text-[0.6875rem] text-primary underline"
                    data-testid="credentials-device-uri"
                  >
                    {pendingFlow.verificationUriComplete ?? pendingFlow.verificationUri}
                  </a>
                )}
                {devicePending && (
                  <p className="text-[0.6875rem] text-muted-foreground" data-testid="credentials-device-pending">
                    {t('credentials.form.devicePending')}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    onClick={() => void handlePollDevice()}
                    disabled={creating}
                    data-testid="credentials-device-poll"
                  >
                    {t('credentials.form.devicePoll')}
                  </Button>
                </div>
              </div>
            )}

            {pendingFlow && !deviceFlow && (
              <div className="space-y-2 min-w-0" data-testid="credentials-code-form">
                <TextField
                  label={t('credentials.form.code')}
                  tooltip={t('credentials.form.codeTooltip')}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    if (codeError) setCodeError(null)
                  }}
                  error={codeError ?? undefined}
                  required
                  id="credentials-code"
                  data-testid="credentials-code"
                />
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    onClick={() => void handleSubmitCode()}
                    disabled={creating}
                    data-testid="credentials-code-submit"
                  >
                    {creating ? t('common.saving') : t('credentials.form.codeSubmit')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {loading && credentials === null && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {credentials && credentials.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="credentials-empty"
          >
            <Icon name="key" className="size-6 opacity-40" />
            <p className="text-xs">{t('credentials.empty')}</p>
          </div>
        )}

        {credentials && credentials.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="credentials-list">
            {credentials.map((credential) => {
              const status = (CREDENTIAL_STATUSES as readonly string[]).includes(
                credential.status,
              )
                ? (credential.status as CredentialStatus)
                : 'active'
              const canRefresh = REFRESHABLE_STATUSES.includes(status)
              const binding = bindFor === credential.id
              return (
                <li
                  key={credential.id}
                  data-testid={`credentials-item-${credential.id}`}
                  className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                        {credential.provider}
                      </span>
                      {statusBadge(status)}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {canRefresh && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[var(--control-height)] min-w-[var(--control-height)]"
                          onClick={() => void handleRefresh(credential)}
                          disabled={pendingId === credential.id}
                          title={t('credentials.refresh')}
                          aria-label={t('credentials.refresh')}
                          data-testid={`credentials-refresh-${credential.id}`}
                        >
                          <Icon name="refresh" className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-[var(--control-height)] min-w-[var(--control-height)] hover:text-destructive"
                        onClick={() => void handleRevoke(credential)}
                        disabled={pendingId === credential.id}
                        title={t('credentials.revoke')}
                        aria-label={t('credentials.revoke')}
                        data-testid={`credentials-revoke-${credential.id}`}
                      >
                        <Icon name="delete-bin" className="size-4" />
                      </Button>
                      {connectors.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[var(--control-height)] min-w-[var(--control-height)]"
                          onClick={() => {
                            setBindConnectorId('')
                            setBindFor(binding ? null : credential.id)
                          }}
                          disabled={pendingId === credential.id}
                          title={t('credentials.bind')}
                          aria-label={t('credentials.bind')}
                          data-testid={`credentials-bind-${credential.id}`}
                        >
                          <Icon name="plug" className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {binding && (
                    <div
                      className="flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-background p-2 min-w-0"
                      data-testid={`credentials-bind-form-${credential.id}`}
                    >
                      <label className="min-w-0 flex-1 space-y-1">
                        <span className="block text-[0.6875rem] font-medium text-foreground">
                          {t('credentials.form.connector')}
                        </span>
                        <select
                          value={bindConnectorId}
                          onChange={(e) => setBindConnectorId(e.target.value)}
                          className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={t('credentials.form.connector')}
                          data-testid={`credentials-bind-select-${credential.id}`}
                        >
                          <option value="">{t('credentials.form.connectorPlaceholder')}</option>
                          {connectors.map((connector) => (
                            <option key={connector.id} value={connector.id}>
                              {connector.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        variant="primary"
                        className="shrink-0 min-h-[var(--control-height)]"
                        onClick={() => void handleBind(credential)}
                        disabled={!bindConnectorId || pendingId === credential.id}
                        data-testid={`credentials-bind-submit-${credential.id}`}
                      >
                        {t('credentials.form.connectorSubmit')}
                      </Button>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1 min-w-0">
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                      {t('credentials.meta.clientId')}:
                    </span>
                    <span className="min-w-0 break-all font-mono text-[0.6875rem] text-foreground">
                      {credential.clientId}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1 min-w-0">
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                      {t('credentials.meta.scopes')}:
                    </span>
                    {credential.scopes.length > 0 ? (
                      <span className="flex min-w-0 flex-wrap gap-1">
                        {credential.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
                          >
                            {scope}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-[0.6875rem] text-muted-foreground">
                        {t('credentials.meta.scopesEmpty')}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                    <span className="min-w-0 break-words" data-testid={`credentials-mask-${credential.id}`}>
                      {t('credentials.meta.secretMask')}: {credential.secretMask}
                    </span>
                    <span className="min-w-0 break-words">
                      {t('credentials.meta.expiresAt')}:{' '}
                      {credential.expiresAt
                        ? formatDateTime(credential.expiresAt, locale)
                        : t('credentials.meta.expiresNever')}
                    </span>
                    <span className="min-w-0 break-words">
                      {t('credentials.meta.lastUsedAt')}:{' '}
                      {credential.lastUsedAt
                        ? formatDateTime(credential.lastUsedAt, locale)
                        : t('credentials.meta.lastUsedNever')}
                    </span>
                    {credential.connectorId && (
                      <span className="min-w-0 break-words">
                        {t('credentials.meta.connector')}: {credential.connectorId}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
