import { useCallback, useEffect, useState } from 'react'

import type { EventBinding, EventBindingApiKey, EventBindingApiKeyCreated } from '@itphx/synth-shared'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { FieldTooltip, NumberField, TextField } from '../ui/settings'

/** Тестовый curl приёма события по ключу привязки (read-only подсказка). */
export function buildEventIngestCurl(key: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return [
    `curl -X POST '${origin}/api/v2/events' \\`,
    `  -H 'Authorization: Bearer ${key}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"type":"message","payload":{"text":"..."}}'`,
  ].join('\n')
}

/** Статус ключа: отозван приоритетнее истёкшего срока. */
type KeyStatus = 'revoked' | 'expired' | 'active'

function keyStatus(key: EventBindingApiKey, now: number): KeyStatus {
  if (key.revokedAt) return 'revoked'
  if (key.expiresAt && new Date(key.expiresAt).getTime() < now) return 'expired'
  return 'active'
}

/** `YYYY-MM-DD` (значение нативного `<input type="date">`) → ISO конца дня. */
function dateInputToIso(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T23:59:59.999`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** ISO-дата → `YYYY-MM-DD` для нативного поля даты (локальный календарь). */
function isoToDateInput(iso?: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Числовой черновик поля лимита → значение API: пусто → `undefined` (не слать поле). */
function parseOptionalInt(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const value = Number.parseInt(trimmed, 10)
  return Number.isNaN(value) ? undefined : value
}

export interface EventBindingKeysProps {
  binding: EventBinding
}

type ApiErrorLike = { status?: number; code?: string }

/**
 * ADR-089/ADR-052: API-ключи привязки — первоклассная секция карточки привязки для
 * LEAD/ADMIN (серверный guard). Список метаданных (label/prefix/статус), создание
 * нескольких ключей (метка, описание, срок, лимит), инлайн-редактор, отзыв и
 * удаление, однократный показ секрета и read-only curl.
 */
export function EventBindingKeys({ binding }: EventBindingKeysProps) {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const [keys, setKeys] = useState<EventBindingApiKey[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [expiresDate, setExpiresDate] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [labelError, setLabelError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [created, setCreated] = useState<EventBindingApiKeyCreated | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editExpiresDate, setEditExpiresDate] = useState('')
  const [editRateLimit, setEditRateLimit] = useState('')
  const [editLabelError, setEditLabelError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)

  const loadKeys = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { keys: list } = await synthApi.getEventBindingKeys(binding.id)
      setKeys(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('events.keys.loadError'))
    } finally {
      setLoading(false)
    }
  }, [binding.id, t])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  const resetCreateForm = () => {
    setLabel('')
    setDescription('')
    setExpiresDate('')
    setRateLimit('')
    setLabelError(null)
    setFormError(null)
  }

  const closeCreateForm = () => {
    setFormOpen(false)
    resetCreateForm()
  }

  const isConflict = (err: unknown): boolean => (err as ApiErrorLike)?.code === 'CONFLICT'

  const handleCreate = async () => {
    if (!label.trim()) {
      setLabelError(t('events.keys.labelRequired'))
      return
    }
    setLabelError(null)
    setFormError(null)
    setCreating(true)
    try {
      const result = await synthApi.createEventBindingKey(binding.id, {
        label: label.trim(),
        description: description.trim() || undefined,
        expiresAt: dateInputToIso(expiresDate),
        rateLimitPerMinute: parseOptionalInt(rateLimit),
      })
      setCreated(result)
      closeCreateForm()
      await loadKeys()
      notify({ text: t('events.keys.created'), type: 'success', category: 'system' })
    } catch (err) {
      if (isConflict(err)) {
        setLabelError(t('errors.conflict.eventKeyLabel'))
      } else {
        setFormError(err instanceof Error ? err.message : t('common.error'))
      }
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (key: EventBindingApiKey) => {
    setEditingId(key.id)
    setEditLabel(key.label)
    setEditDescription(key.description ?? '')
    setEditExpiresDate(isoToDateInput(key.expiresAt))
    setEditRateLimit(key.rateLimitPerMinute != null ? String(key.rateLimitPerMinute) : '')
    setEditLabelError(null)
    setEditError(null)
  }

  const closeEdit = () => {
    setEditingId(null)
    setEditLabelError(null)
    setEditError(null)
  }

  const handleEditSave = async (key: EventBindingApiKey) => {
    if (!editLabel.trim()) {
      setEditLabelError(t('events.keys.labelRequired'))
      return
    }
    setEditLabelError(null)
    setEditError(null)
    setEditSaving(true)
    try {
      await synthApi.updateEventBindingKey(binding.id, key.id, {
        label: editLabel.trim(),
        description: editDescription.trim() || null,
        expiresAt: dateInputToIso(editExpiresDate) ?? null,
        rateLimitPerMinute: parseOptionalInt(editRateLimit) ?? null,
      })
      closeEdit()
      await loadKeys()
      notify({ text: t('events.keys.updated'), type: 'success', category: 'system' })
    } catch (err) {
      if (isConflict(err)) {
        setEditLabelError(t('errors.conflict.eventKeyLabel'))
      } else {
        setEditError(err instanceof Error ? err.message : t('common.error'))
      }
    } finally {
      setEditSaving(false)
    }
  }

  const handleRevoke = async (key: EventBindingApiKey) => {
    const ok = await confirm({
      title: t('events.keys.revokeTitle'),
      message: t('events.keys.revokeConfirm', { label: key.label }),
      confirmLabel: t('events.keys.revoke'),
      variant: 'warning',
      icon: 'shield',
    })
    if (!ok) return
    setPendingId(key.id)
    try {
      await synthApi.revokeEventBindingKey(binding.id, key.id)
      await loadKeys()
      notify({ text: t('events.keys.revoked'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('events.keys.revokeError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const handleDelete = async (key: EventBindingApiKey) => {
    const ok = await confirm({
      title: t('events.keys.deleteTitle'),
      message: t('events.keys.deleteConfirm', { label: key.label }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setPendingId(key.id)
    try {
      await synthApi.deleteEventBindingKey(binding.id, key.id)
      if (created?.id === key.id) setCreated(null)
      await loadKeys()
      notify({ text: t('events.keys.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('events.keys.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      notify({ text: t('events.keys.copied'), type: 'success', category: 'system' })
    })
  }

  const curl = buildEventIngestCurl(created?.key ?? '<key>')
  const now = Date.now()
  const count = keys?.length ?? 0

  const statusBadge = (status: KeyStatus) => {
    const classes =
      status === 'active'
        ? 'bg-status-success/15 text-status-success'
        : status === 'expired'
          ? 'bg-status-warning/15 text-status-warning'
          : 'bg-muted text-muted-foreground'
    const text =
      status === 'active'
        ? t('events.keys.status.active')
        : status === 'expired'
          ? t('events.keys.status.expired')
          : t('events.keys.status.revoked')
    return (
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium', classes)}>
        {text}
      </span>
    )
  }

  return (
    <div
      className="space-y-3 rounded-lg border border-border/60 bg-background p-3 min-w-0"
      data-testid={`events-binding-keys-${binding.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name="key" className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground break-words">
            {t('events.keys.title')}
          </span>
          <FieldTooltip text={t('settings.help.eventsAdmin.keys')} />
          <span
            className="shrink-0 rounded-full bg-interactive-hover px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
            title={t('events.keys.count', { count })}
          >
            {count}
          </span>
        </div>
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
          data-testid={`events-binding-key-add-${binding.id}`}
        >
          <Icon name={formOpen ? 'close' : 'add'} className="size-3.5" />
          {formOpen ? t('common.cancel') : t('events.keys.add')}
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {formOpen && (
        <div
          className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
          data-testid={`events-binding-key-form-${binding.id}`}
        >
          {formError && (
            <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
              {formError}
            </div>
          )}

          <TextField
            label={t('events.keys.form.label')}
            tooltip={t('events.keys.form.labelTooltip')}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value)
              if (labelError) setLabelError(null)
            }}
            error={labelError ?? undefined}
            required
            id={`events-key-label-${binding.id}`}
            data-testid={`events-binding-key-label-${binding.id}`}
          />

          <TextField
            label={t('events.keys.form.description')}
            tooltip={t('events.keys.form.descriptionTooltip')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            id={`events-key-description-${binding.id}`}
            data-testid={`events-binding-key-description-${binding.id}`}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
            <TextField
              label={t('events.keys.form.expiresAt')}
              tooltip={t('events.keys.form.expiresAtTooltip')}
              type="date"
              value={expiresDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              id={`events-key-expires-${binding.id}`}
              data-testid={`events-binding-key-expires-${binding.id}`}
            />

            <NumberField
              label={t('events.keys.form.rateLimit')}
              tooltip={t('events.keys.form.rateLimitTooltip')}
              min={0}
              step={1}
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder="0"
              id={`events-key-rate-${binding.id}`}
              data-testid={`events-binding-key-rate-${binding.id}`}
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline-muted"
              onClick={closeCreateForm}
              disabled={creating}
              data-testid={`events-binding-key-cancel-${binding.id}`}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
              data-testid={`events-binding-key-save-${binding.id}`}
            >
              {creating ? t('common.saving') : t('common.create')}
            </Button>
          </div>
        </div>
      )}

      {loading && keys === null && (
        <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
      )}

      {keys && keys.length === 0 && (
        <div
          className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
          data-testid={`events-binding-keys-empty-${binding.id}`}
        >
          <Icon name="key" className="size-6 opacity-40" />
          <p className="text-xs">{t('events.keys.empty')}</p>
        </div>
      )}

      {keys && keys.length > 0 && (
        <ul className="space-y-2 min-w-0" data-testid={`events-binding-keys-list-${binding.id}`}>
          {keys.map((key) => {
            const status = keyStatus(key, now)
            const editing = editingId === key.id
            return (
              <li
                key={key.id}
                data-testid={`events-binding-key-${key.id}`}
                className={cn(
                  'space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0',
                  editing && 'border-primary/40',
                )}
              >
                {editing ? (
                  <div className="space-y-3 min-w-0">
                    {editError && (
                      <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
                        {editError}
                      </div>
                    )}
                    <TextField
                      label={t('events.keys.form.label')}
                      tooltip={t('events.keys.form.labelTooltip')}
                      value={editLabel}
                      onChange={(e) => {
                        setEditLabel(e.target.value)
                        if (editLabelError) setEditLabelError(null)
                      }}
                      error={editLabelError ?? undefined}
                      required
                      id={`events-key-edit-label-${key.id}`}
                      data-testid={`events-binding-key-edit-label-${key.id}`}
                    />
                    <TextField
                      label={t('events.keys.form.description')}
                      tooltip={t('events.keys.form.descriptionTooltip')}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      id={`events-key-edit-description-${key.id}`}
                      data-testid={`events-binding-key-edit-description-${key.id}`}
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
                      <TextField
                        label={t('events.keys.form.expiresAt')}
                        tooltip={t('events.keys.form.expiresAtTooltip')}
                        type="date"
                        value={editExpiresDate}
                        onChange={(e) => setEditExpiresDate(e.target.value)}
                        id={`events-key-edit-expires-${key.id}`}
                        data-testid={`events-binding-key-edit-expires-${key.id}`}
                      />
                      <NumberField
                        label={t('events.keys.form.rateLimit')}
                        tooltip={t('events.keys.form.rateLimitTooltip')}
                        min={0}
                        step={1}
                        value={editRateLimit}
                        onChange={(e) => setEditRateLimit(e.target.value)}
                        placeholder="0"
                        id={`events-key-edit-rate-${key.id}`}
                        data-testid={`events-binding-key-edit-rate-${key.id}`}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        variant="outline-muted"
                        onClick={closeEdit}
                        disabled={editSaving}
                        data-testid={`events-binding-key-edit-cancel-${key.id}`}
                      >
                        {t('common.cancel')}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => void handleEditSave(key)}
                        disabled={editSaving}
                        data-testid={`events-binding-key-edit-save-${key.id}`}
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
                          {key.label}
                        </span>
                        <code className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                          {key.prefix}…
                        </code>
                        {statusBadge(status)}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-10 min-w-10"
                          onClick={() => openEdit(key)}
                          title={t('common.edit')}
                          aria-label={t('common.edit')}
                          data-testid={`events-binding-key-edit-${key.id}`}
                        >
                          <Icon name="edit-2" className="size-4" />
                        </Button>
                        {status !== 'revoked' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-10 min-w-10"
                            onClick={() => void handleRevoke(key)}
                            disabled={pendingId === key.id}
                            title={t('events.keys.revoke')}
                            aria-label={t('events.keys.revoke')}
                            data-testid={`events-binding-key-revoke-${key.id}`}
                          >
                            <Icon name="shield" className="size-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-10 min-w-10 hover:text-destructive"
                          onClick={() => void handleDelete(key)}
                          disabled={pendingId === key.id}
                          title={t('common.delete')}
                          aria-label={t('common.delete')}
                          data-testid={`events-binding-key-delete-${key.id}`}
                        >
                          <Icon name="delete-bin" className="size-4" />
                        </Button>
                      </div>
                    </div>

                    {key.description && (
                      <p className="break-words text-xs text-muted-foreground">{key.description}</p>
                    )}

                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                      <span className="min-w-0 break-words">
                        {t('events.keys.meta.createdBy')}: {key.createdBy}
                      </span>
                      <span className="min-w-0 break-words">
                        {t('events.keys.meta.created')}: {formatDateTime(key.createdAt, locale)}
                      </span>
                      {key.lastUsedAt && (
                        <span className="min-w-0 break-words">
                          {t('events.keys.lastUsed')}: {formatDateTime(key.lastUsedAt, locale)}
                        </span>
                      )}
                      <span className="min-w-0 break-words">
                        {t('events.keys.meta.expires')}:{' '}
                        {key.expiresAt
                          ? formatDateTime(key.expiresAt, locale)
                          : t('events.keys.meta.noExpiry')}
                      </span>
                      <span className="min-w-0 break-words">
                        {t('events.keys.meta.rateLimit')}:{' '}
                        {key.rateLimitPerMinute != null
                          ? key.rateLimitPerMinute
                          : t('events.keys.meta.noLimit')}
                      </span>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {created && (
        <div
          className="space-y-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 min-w-0"
          data-testid={`events-binding-key-secret-${binding.id}`}
        >
          <div className="flex items-start justify-between gap-2 min-w-0">
            <p className="break-words text-xs font-medium text-status-warning">
              {t('events.keys.secretWarning')}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 min-h-8 min-w-8"
              onClick={() => setCreated(null)}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <Icon name="close" className="size-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
              {created.key}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 min-h-10"
              onClick={() => copy(created.key)}
              title={t('common.copy')}
              aria-label={t('common.copy')}
              data-testid={`events-binding-key-copy-${binding.id}`}
            >
              <Icon name="file-copy" className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Read-only подсказка с тестовым curl (постоянно в секции ключей). */}
      <div className="space-y-1 min-w-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-[0.6875rem] text-muted-foreground">
            {t('events.keys.curlTitle')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 min-h-8 px-2"
            onClick={() => copy(curl)}
            title={t('common.copy')}
            aria-label={t('common.copy')}
            data-testid={`events-binding-key-curl-copy-${binding.id}`}
          >
            <Icon name="file-copy" className="size-3.5" />
          </Button>
        </div>
        <pre
          data-testid={`events-binding-key-curl-${binding.id}`}
          className="max-h-40 overflow-auto break-all whitespace-pre-wrap rounded-lg border border-border/60 bg-surface-inset p-2 text-[0.6875rem]"
        >
          {curl}
        </pre>
      </div>
    </div>
  )
}
