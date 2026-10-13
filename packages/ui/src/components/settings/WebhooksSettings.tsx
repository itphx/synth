import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  WebhookDelivery,
  WebhookSubscription,
  WebhookSubscriptionCreated,
} from '@itphx/synth-shared'
import { DEFAULT_WEBHOOK_EVENT_PATTERNS, isWebhookEventPattern } from '@itphx/synth-shared/types'

import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { Toggle } from '../ui/Toggle'
import {
  MultiSelectField,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
} from '../ui/settings'

/**
 * AD-052 (этап II): проверка целевого URL — абсолютный `https`-адрес.
 * SSRF-политика (приватные/loopback-адреса) enforce'ится на сервере
 * (`evaluateWebhookTarget`), здесь — только базовая валидация формы.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * AD-052 (этап II): пример проверки подписи доставки (read-only подсказка).
 * Схема — `X-Synth-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`,
 * окно анти-replay — 300 c.
 */
export function buildWebhookSignatureExample(secret: string): string {
  const value = secret || '<secret>'
  return [
    '// X-Synth-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>',
    "import { createHmac, timingSafeEqual } from 'node:crypto'",
    '',
    '// rawBody — сырое тело запроса (до JSON.parse); header — значение X-Synth-Signature.',
    'export function verifySynthWebhook(secret, rawBody, header) {',
    "  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))",
    "  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex')",
    '  const a = Buffer.from(expected)',
    "  const b = Buffer.from(parts.v1 ?? '')",
    '  return a.length === b.length && timingSafeEqual(a, b)',
    '}',
    '',
    `// secret = '${value}'`,
  ].join('\n')
}

type ApiErrorLike = { status?: number; code?: string }

interface WebhookEventsFieldProps {
  values: string[]
  onChange: (next: string[]) => void
  /** Дополнительные паттерны (не из дефолтного набора), напр. из существующей подписки. */
  extraPatterns?: string[]
  error?: string
  testIdPrefix: string
}

/**
 * AD-052 (этап II): мульти-селект событий из дефолтного набора + добавление
 * собственного паттерна (`prefix.*`). Выбранный список нормализуется по порядку опций.
 */
function WebhookEventsField({
  values,
  onChange,
  extraPatterns = [],
  error,
  testIdPrefix,
}: WebhookEventsFieldProps) {
  const { t } = useI18n()
  const [extra, setExtra] = useState<string[]>(extraPatterns)
  const [input, setInput] = useState('')
  const [patternError, setPatternError] = useState<string | null>(null)

  const options = useMemo(() => {
    const merged = new Set<string>([...DEFAULT_WEBHOOK_EVENT_PATTERNS, ...extra])
    return [...merged].map((value) => ({ value, label: value }))
  }, [extra])

  const addPattern = () => {
    const pattern = input.trim()
    if (!pattern) return
    if (!isWebhookEventPattern(pattern)) {
      setPatternError(t('webhooks.form.patternInvalid'))
      return
    }
    if (options.some((option) => option.value === pattern)) {
      setPatternError(t('webhooks.form.patternDuplicate'))
      return
    }
    setExtra((prev) => [...prev, pattern])
    onChange([...values, pattern])
    setInput('')
    setPatternError(null)
  }

  return (
    <div className="space-y-3 min-w-0">
      <MultiSelectField
        label={t('webhooks.form.events')}
        tooltip={t('webhooks.form.eventsTooltip')}
        values={values}
        options={options}
        onChange={onChange}
        emptyText={t('webhooks.form.eventsEmpty')}
        error={error}
        testIdPrefix={testIdPrefix}
      />

      <div className="flex items-end gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <TextField
            label={t('webhooks.form.customPattern')}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              if (patternError) setPatternError(null)
            }}
            placeholder={t('webhooks.form.customPatternPlaceholder')}
            error={patternError ?? undefined}
            mono
            data-testid={`${testIdPrefix}-pattern-input`}
          />
        </div>
        <Button
          variant="outline"
          className="min-h-10 shrink-0"
          onClick={addPattern}
          data-testid={`${testIdPrefix}-pattern-add`}
        >
          <Icon name="add" className="size-3.5" />
          {t('webhooks.form.addPattern')}
        </Button>
      </div>
    </div>
  )
}

/**
 * AD-052 (этап II) / AD-072: админ-секция «Webhooks» — CRUD подписок на
 * исходящие события (`/webhooks`) + журнал доставок и тестовая доставка.
 * Список (label/url/события/статус), создание (однократный показ signing-секрета
 * + пример HMAC-подписи), инлайн-редактор, тумблер включения, ротация секрета,
 * тест доставки и удаление. Мутации — ADMIN (guard сервера); для остальных
 * ролей — read-only режим с пояснением.
 */
export function WebhooksSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const userRoles = useAuthStore((s) => s.user?.roles) ?? []
  const canManage = userRoles.includes('ADMIN')

  const [subs, setSubs] = useState<WebhookSubscription[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [enabled, setEnabled] = useState(true)
  const [labelError, setLabelError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [created, setCreated] = useState<WebhookSubscriptionCreated | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editEvents, setEditEvents] = useState<string[]>([])
  const [editEnabled, setEditEnabled] = useState(true)
  const [editLabelError, setEditLabelError] = useState<string | null>(null)
  const [editUrlError, setEditUrlError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)

  const [deliveriesFor, setDeliveriesFor] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [deliveriesLoading, setDeliveriesLoading] = useState(false)
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null)

  const loadSubscriptions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { subscriptions } = await synthApi.getWebhookSubscriptions()
      setSubs(subscriptions)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('webhooks.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadSubscriptions()
  }, [loadSubscriptions])

  const isConflict = (err: unknown): boolean => (err as ApiErrorLike)?.code === 'CONFLICT'

  const resetCreateForm = () => {
    setLabel('')
    setDescription('')
    setUrl('')
    setEvents([])
    setEnabled(true)
    setLabelError(null)
    setUrlError(null)
    setFormError(null)
  }

  const closeCreateForm = () => {
    setFormOpen(false)
    resetCreateForm()
  }

  const handleCreate = async () => {
    const trimmedLabel = label.trim()
    const trimmedUrl = url.trim()
    let invalid = false
    if (!trimmedLabel) {
      setLabelError(t('webhooks.labelRequired'))
      invalid = true
    }
    if (!trimmedUrl) {
      setUrlError(t('webhooks.urlRequired'))
      invalid = true
    } else if (!isHttpsUrl(trimmedUrl)) {
      setUrlError(t('webhooks.urlInvalid'))
      invalid = true
    }
    if (invalid) return
    setLabelError(null)
    setUrlError(null)
    setFormError(null)
    setCreating(true)
    try {
      const result = await synthApi.createWebhookSubscription({
        label: trimmedLabel,
        description: description.trim() || undefined,
        url: trimmedUrl,
        events: events.length > 0 ? events : undefined,
        enabled,
      })
      setCreated(result)
      closeCreateForm()
      await loadSubscriptions()
      notify({ text: t('webhooks.created'), type: 'success', category: 'system' })
    } catch (err) {
      if (isConflict(err)) {
        setLabelError(t('errors.conflict.webhookLabel'))
      } else {
        setFormError(err instanceof Error ? err.message : t('common.error'))
      }
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (sub: WebhookSubscription) => {
    setEditingId(sub.id)
    setEditLabel(sub.label)
    setEditDescription(sub.description ?? '')
    setEditUrl(sub.url)
    setEditEvents(sub.events ?? [])
    setEditEnabled(sub.enabled)
    setEditLabelError(null)
    setEditUrlError(null)
    setEditError(null)
  }

  const closeEdit = () => {
    setEditingId(null)
    setEditLabelError(null)
    setEditUrlError(null)
    setEditError(null)
  }

  const handleEditSave = async (sub: WebhookSubscription) => {
    const trimmedLabel = editLabel.trim()
    const trimmedUrl = editUrl.trim()
    let invalid = false
    if (!trimmedLabel) {
      setEditLabelError(t('webhooks.labelRequired'))
      invalid = true
    }
    if (!trimmedUrl) {
      setEditUrlError(t('webhooks.urlRequired'))
      invalid = true
    } else if (!isHttpsUrl(trimmedUrl)) {
      setEditUrlError(t('webhooks.urlInvalid'))
      invalid = true
    }
    if (invalid) return
    setEditLabelError(null)
    setEditUrlError(null)
    setEditError(null)
    setEditSaving(true)
    try {
      await synthApi.updateWebhookSubscription(sub.id, {
        label: trimmedLabel,
        description: editDescription.trim() || null,
        url: trimmedUrl,
        events: editEvents,
        enabled: editEnabled,
      })
      closeEdit()
      await loadSubscriptions()
      notify({ text: t('webhooks.updated'), type: 'success', category: 'system' })
    } catch (err) {
      if (isConflict(err)) {
        setEditLabelError(t('errors.conflict.webhookLabel'))
      } else {
        setEditError(err instanceof Error ? err.message : t('common.error'))
      }
    } finally {
      setEditSaving(false)
    }
  }

  const handleToggleEnabled = async (sub: WebhookSubscription) => {
    setPendingId(sub.id)
    try {
      await synthApi.updateWebhookSubscription(sub.id, { enabled: !sub.enabled })
      await loadSubscriptions()
      notify({ text: t('webhooks.updated'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('webhooks.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const handleRegenerate = async (sub: WebhookSubscription) => {
    const ok = await confirm({
      title: t('webhooks.regenerateTitle'),
      message: t('webhooks.regenerateConfirm', { label: sub.label }),
      confirmLabel: t('webhooks.regenerate'),
      variant: 'warning',
      icon: 'refresh',
    })
    if (!ok) return
    setPendingId(sub.id)
    try {
      const rotated = await synthApi.regenerateWebhookSecret(sub.id)
      setCreated(rotated)
      await loadSubscriptions()
      notify({ text: t('webhooks.regenerated'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('webhooks.regenerateError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const handleTest = async (sub: WebhookSubscription) => {
    setPendingId(sub.id)
    try {
      const delivery = await synthApi.testWebhookSubscription(sub.id)
      await loadSubscriptions()
      if (deliveriesFor === sub.id) await loadDeliveries(sub.id)
      notify({
        text: t('webhooks.testOk', { status: t(`webhooks.status.${delivery.status === 'ok' ? 'ok' : 'failed'}`) }),
        type: delivery.status === 'ok' ? 'success' : 'error',
        category: delivery.status === 'ok' ? 'system' : 'error',
      })
    } catch (err) {
      notify({
        text: t('webhooks.testError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const handleDelete = async (sub: WebhookSubscription) => {
    const ok = await confirm({
      title: t('webhooks.deleteTitle'),
      message: t('webhooks.deleteConfirm', { label: sub.label }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setPendingId(sub.id)
    try {
      await synthApi.deleteWebhookSubscription(sub.id)
      if (created?.id === sub.id) setCreated(null)
      if (deliveriesFor === sub.id) {
        setDeliveriesFor(null)
        setDeliveries(null)
      }
      await loadSubscriptions()
      notify({ text: t('webhooks.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('webhooks.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const loadDeliveries = async (id: string) => {
    setDeliveriesLoading(true)
    setDeliveriesError(null)
    try {
      const { deliveries: list } = await synthApi.getWebhookDeliveries(id)
      setDeliveries(list)
    } catch (err) {
      setDeliveriesError(err instanceof Error ? err.message : t('webhooks.deliveries.loadError'))
    } finally {
      setDeliveriesLoading(false)
    }
  }

  const toggleDeliveries = async (sub: WebhookSubscription) => {
    if (deliveriesFor === sub.id) {
      setDeliveriesFor(null)
      setDeliveries(null)
      setDeliveriesError(null)
      return
    }
    setDeliveriesFor(sub.id)
    setDeliveries(null)
    await loadDeliveries(sub.id)
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      notify({ text: t('webhooks.copied'), type: 'success', category: 'system' })
    })
  }

  const signatureExample = buildWebhookSignatureExample(created?.secret ?? '<secret>')
  const count = subs?.length ?? 0

  const statusBadge = (status: 'ok' | 'failed') => (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
        status === 'ok' ? 'bg-status-success/15 text-status-success' : 'bg-destructive/15 text-destructive',
      )}
    >
      {t(`webhooks.status.${status}`)}
    </span>
  )

  return (
    <SettingsPanel
      title={t('webhooks.title')}
      description={t('webhooks.description')}
      meta={t('webhooks.count', { count })}
    >
      {!canManage && (
        <SettingsSection>
          <div
            role="alert"
            data-testid="webhooks-readonly"
            className="rounded-lg bg-status-warning/10 p-3 text-sm text-status-warning"
          >
            {t('webhooks.readOnly')}
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title={t('webhooks.listTitle')}
        description={t('webhooks.listDescription')}
        actions={
          canManage ? (
            <Button
              variant="outline"
              className="min-h-10 shrink-0"
              onClick={() => {
                if (formOpen) {
                  closeCreateForm()
                } else {
                  resetCreateForm()
                  setFormOpen(true)
                }
              }}
              data-testid="webhooks-add"
            >
              <Icon name={formOpen ? 'close' : 'add'} className="size-3.5" />
              {formOpen ? t('common.cancel') : t('webhooks.add')}
            </Button>
          ) : undefined
        }
      >
        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {formOpen && canManage && (
          <div
            className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="webhooks-form"
          >
            <p className="text-sm font-medium text-foreground">{t('webhooks.form.title')}</p>

            {formError && (
              <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
                {formError}
              </div>
            )}

            <TextField
              label={t('webhooks.form.label')}
              tooltip={t('webhooks.form.labelTooltip')}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value)
                if (labelError) setLabelError(null)
              }}
              error={labelError ?? undefined}
              required
              id="webhooks-label"
              data-testid="webhooks-label"
            />

            <TextField
              label={t('webhooks.form.description')}
              tooltip={t('webhooks.form.descriptionTooltip')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              id="webhooks-description"
              data-testid="webhooks-description"
            />

            <TextField
              label={t('webhooks.form.url')}
              tooltip={t('webhooks.form.urlTooltip')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (urlError) setUrlError(null)
              }}
              error={urlError ?? undefined}
              placeholder="https://example.com/hooks/synth"
              mono
              required
              id="webhooks-url"
              data-testid="webhooks-url"
            />

            <WebhookEventsField
              values={events}
              onChange={setEvents}
              testIdPrefix="webhooks-event"
            />

            <ToggleField
              label={t('webhooks.form.enabled')}
              tooltip={t('webhooks.form.enabledTooltip')}
              enabled={enabled}
              onToggle={() => setEnabled((prev) => !prev)}
            />

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline-muted"
                onClick={closeCreateForm}
                disabled={creating}
                data-testid="webhooks-create-cancel"
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleCreate()}
                disabled={creating}
                data-testid="webhooks-create-save"
              >
                {creating ? t('common.saving') : t('common.create')}
              </Button>
            </div>
          </div>
        )}

        {created && (
          <div
            className="space-y-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 min-w-0"
            data-testid="webhooks-secret"
          >
            <div className="flex items-start justify-between gap-2 min-w-0">
              <p className="break-words text-xs font-medium text-status-warning">
                {t('webhooks.secretWarning')}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 min-h-8 min-w-8"
                onClick={() => setCreated(null)}
                title={t('common.close')}
                aria-label={t('common.close')}
                data-testid="webhooks-secret-close"
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
                {created.secret}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 min-h-10"
                onClick={() => copy(created.secret)}
                title={t('common.copy')}
                aria-label={t('common.copy')}
                data-testid="webhooks-secret-copy"
              >
                <Icon name="file-copy" className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-1 min-w-0">
              <p className="break-words text-[0.6875rem] text-muted-foreground">
                {t('webhooks.signatureHint')}
              </p>
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {t('webhooks.signatureTitle')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 min-h-8 px-2"
                  onClick={() => copy(signatureExample)}
                  title={t('common.copy')}
                  aria-label={t('common.copy')}
                  data-testid="webhooks-signature-copy"
                >
                  <Icon name="file-copy" className="size-3.5" />
                </Button>
              </div>
              <pre
                data-testid="webhooks-signature"
                className="max-h-52 overflow-auto break-all whitespace-pre-wrap rounded-lg border border-border/60 bg-surface-inset p-2 text-[0.6875rem]"
              >
                {signatureExample}
              </pre>
            </div>
          </div>
        )}

        {loading && subs === null && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {subs && subs.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="webhooks-empty"
          >
            <Icon name="send-plane" className="size-6 opacity-40" />
            <p className="text-xs">{t('webhooks.empty')}</p>
          </div>
        )}

        {subs && subs.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="webhooks-list">
            {subs.map((sub) => {
              const editing = editingId === sub.id
              const extraPatterns = sub.events.filter(
                (pattern) => !(DEFAULT_WEBHOOK_EVENT_PATTERNS as readonly string[]).includes(pattern),
              )
              return (
                <li
                  key={sub.id}
                  data-testid={`webhooks-item-${sub.id}`}
                  className={cn(
                    'space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0',
                    editing && 'border-primary/40',
                  )}
                >
                  {editing && canManage ? (
                    <div className="space-y-3 min-w-0">
                      {editError && (
                        <div
                          role="alert"
                          className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                        >
                          {editError}
                        </div>
                      )}
                      <TextField
                        label={t('webhooks.form.label')}
                        tooltip={t('webhooks.form.labelTooltip')}
                        value={editLabel}
                        onChange={(e) => {
                          setEditLabel(e.target.value)
                          if (editLabelError) setEditLabelError(null)
                        }}
                        error={editLabelError ?? undefined}
                        required
                        id={`webhooks-edit-label-${sub.id}`}
                        data-testid={`webhooks-edit-label-${sub.id}`}
                      />
                      <TextField
                        label={t('webhooks.form.description')}
                        tooltip={t('webhooks.form.descriptionTooltip')}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        id={`webhooks-edit-description-${sub.id}`}
                        data-testid={`webhooks-edit-description-${sub.id}`}
                      />
                      <TextField
                        label={t('webhooks.form.url')}
                        tooltip={t('webhooks.form.urlTooltip')}
                        value={editUrl}
                        onChange={(e) => {
                          setEditUrl(e.target.value)
                          if (editUrlError) setEditUrlError(null)
                        }}
                        error={editUrlError ?? undefined}
                        mono
                        required
                        id={`webhooks-edit-url-${sub.id}`}
                        data-testid={`webhooks-edit-url-${sub.id}`}
                      />
                      <WebhookEventsField
                        values={editEvents}
                        onChange={setEditEvents}
                        extraPatterns={extraPatterns}
                        testIdPrefix={`webhooks-edit-event-${sub.id}`}
                      />
                      <ToggleField
                        label={t('webhooks.form.enabled')}
                        tooltip={t('webhooks.form.enabledTooltip')}
                        enabled={editEnabled}
                        onToggle={() => setEditEnabled((prev) => !prev)}
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="outline-muted"
                          onClick={closeEdit}
                          disabled={editSaving}
                          data-testid={`webhooks-edit-cancel-${sub.id}`}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => void handleEditSave(sub)}
                          disabled={editSaving}
                          data-testid={`webhooks-edit-save-${sub.id}`}
                        >
                          {editSaving ? t('common.saving') : t('common.save')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                            {sub.label}
                          </span>
                          {sub.lastStatus && statusBadge(sub.lastStatus)}
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                            {sub.enabled ? t('webhooks.enabled.on') : t('webhooks.enabled.off')}
                          </span>
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 items-center gap-1">
                            <span data-testid={`webhooks-toggle-${sub.id}`} className="px-1">
                              <Toggle
                                enabled={sub.enabled}
                                onToggle={() => void handleToggleEnabled(sub)}
                                pending={pendingId === sub.id}
                                ariaLabel={t('webhooks.form.enabled')}
                              />
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-10 min-w-10"
                              onClick={() => openEdit(sub)}
                              title={t('common.edit')}
                              aria-label={t('common.edit')}
                              data-testid={`webhooks-edit-${sub.id}`}
                            >
                              <Icon name="edit-2" className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-10 min-w-10"
                              onClick={() => void handleRegenerate(sub)}
                              disabled={pendingId === sub.id}
                              title={t('webhooks.regenerate')}
                              aria-label={t('webhooks.regenerate')}
                              data-testid={`webhooks-regenerate-${sub.id}`}
                            >
                              <Icon name="refresh" className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-10 min-w-10"
                              onClick={() => void handleTest(sub)}
                              disabled={pendingId === sub.id}
                              title={t('webhooks.test')}
                              aria-label={t('webhooks.test')}
                              data-testid={`webhooks-test-${sub.id}`}
                            >
                              <Icon name="test-tube" className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-10 min-w-10"
                              onClick={() => void toggleDeliveries(sub)}
                              title={
                                deliveriesFor === sub.id
                                  ? t('webhooks.deliveries.hide')
                                  : t('webhooks.deliveries.show')
                              }
                              aria-label={t('webhooks.deliveries.show')}
                              data-testid={`webhooks-deliveries-toggle-${sub.id}`}
                            >
                              <Icon name="file-list" className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-10 min-w-10 hover:text-destructive"
                              onClick={() => void handleDelete(sub)}
                              disabled={pendingId === sub.id}
                              title={t('common.delete')}
                              aria-label={t('common.delete')}
                              data-testid={`webhooks-delete-${sub.id}`}
                            >
                              <Icon name="delete-bin" className="size-4" />
                            </Button>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1 min-w-0">
                        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                          {t('webhooks.meta.url')}:
                        </span>
                        <span className="min-w-0 break-all font-mono text-[0.6875rem] text-foreground">
                          {sub.url}
                        </span>
                      </div>

                      {sub.description && (
                        <p className="break-words text-xs text-muted-foreground">{sub.description}</p>
                      )}

                      <div className="flex flex-wrap items-center gap-1 min-w-0">
                        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                          {t('webhooks.meta.events')}:
                        </span>
                        {sub.events.length > 0 ? (
                          <span className="flex min-w-0 flex-wrap gap-1">
                            {sub.events.map((pattern) => (
                              <span
                                key={pattern}
                                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
                              >
                                {pattern}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-[0.6875rem] text-muted-foreground">
                            {t('webhooks.meta.eventsDefault')}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                        <span className="min-w-0 break-words">
                          {t('webhooks.meta.createdBy')}: {sub.createdBy}
                        </span>
                        <span className="min-w-0 break-words">
                          {t('webhooks.meta.created')}: {formatDateTime(sub.createdAt, locale)}
                        </span>
                        <span className="min-w-0 break-words">
                          {t('webhooks.meta.secretPrefix')}: {sub.secretPrefix}
                        </span>
                        <span className="min-w-0 break-words">
                          {t('webhooks.lastDelivery')}:{' '}
                          {sub.lastDeliveryAt
                            ? formatDateTime(sub.lastDeliveryAt, locale)
                            : t('webhooks.lastDeliveryNever')}
                        </span>
                      </div>

                      {deliveriesFor === sub.id && (
                        <div
                          className="space-y-2 rounded-lg border border-border/60 bg-background p-2 min-w-0"
                          data-testid={`webhooks-deliveries-${sub.id}`}
                        >
                          <p className="text-xs font-medium text-foreground">
                            {t('webhooks.deliveries.title')}
                          </p>
                          {deliveriesError && (
                            <div role="alert" className="text-xs text-destructive">
                              {deliveriesError}
                            </div>
                          )}
                          {deliveriesLoading && deliveries === null && (
                            <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
                          )}
                          {deliveries && deliveries.length === 0 && (
                            <div className="text-xs text-muted-foreground">
                              {t('webhooks.deliveries.empty')}
                            </div>
                          )}
                          {deliveries && deliveries.length > 0 && (
                            <ul className="space-y-1.5 min-w-0">
                              {deliveries.map((delivery) => (
                                <li
                                  key={delivery.id}
                                  data-testid={`webhooks-delivery-${delivery.id}`}
                                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] min-w-0"
                                >
                                  {delivery.status === 'ok'
                                    ? statusBadge('ok')
                                    : statusBadge('failed')}
                                  <span className="font-mono text-foreground">{delivery.eventType}</span>
                                  <span className="text-muted-foreground">
                                    {t('webhooks.deliveries.attempts', { count: delivery.attempts })}
                                  </span>
                                  {delivery.responseStatus != null && (
                                    <span className="text-muted-foreground">
                                      {t('webhooks.deliveries.response')}: {delivery.responseStatus}
                                    </span>
                                  )}
                                  <span className="text-muted-foreground">
                                    {formatDateTime(delivery.createdAt, locale)}
                                  </span>
                                  {delivery.error && (
                                    <span className="min-w-0 break-words text-destructive">
                                      {t('webhooks.deliveries.error')}: {delivery.error}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
