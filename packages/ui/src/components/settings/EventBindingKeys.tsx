import { useCallback, useEffect, useState } from 'react'

import type { EventBinding, EventBindingApiKey, EventBindingApiKeyCreated } from '@itphx/synth-shared'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { TextField } from '../ui/settings'

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

export interface EventBindingKeysProps {
  binding: EventBinding
}

/**
 * AD-089/AD-052: API-ключи привязки (только LEAD/ADMIN — серверный guard).
 * Список метаданных, создание (description обяз., name опц.), удаление,
 * однократный показ секрета и read-only curl для приёма события.
 */
export function EventBindingKeys({ binding }: EventBindingKeysProps) {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const [keys, setKeys] = useState<EventBindingApiKey[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [created, setCreated] = useState<EventBindingApiKeyCreated | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

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

  const handleCreate = async () => {
    if (!description.trim()) {
      setFormError(t('events.keys.descriptionRequired'))
      return
    }
    setFormError(null)
    setCreating(true)
    try {
      const result = await synthApi.createEventBindingKey(binding.id, {
        name: name.trim() || undefined,
        description: description.trim(),
      })
      setCreated(result)
      setName('')
      setDescription('')
      setFormOpen(false)
      await loadKeys()
      notify({ text: t('events.keys.created'), type: 'success', category: 'system' })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (key: EventBindingApiKey) => {
    const ok = await confirm({
      title: t('events.keys.deleteTitle'),
      message: t('events.keys.deleteConfirm', { name: key.name || key.prefix }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setPendingId(key.id)
    try {
      await synthApi.deleteEventBindingKey(binding.id, key.id)
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

  const activeSecret = created?.key
  const curl = buildEventIngestCurl(activeSecret ?? '<key>')

  return (
    <div
      className="space-y-2 rounded-lg border border-border/60 bg-background p-3 min-w-0"
      data-testid={`events-binding-keys-${binding.id}`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name="key" className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground break-words">
            {t('events.keys.title')}
          </span>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setFormOpen((open) => !open)
            setFormError(null)
          }}
          data-testid={`events-binding-key-add-${binding.id}`}
        >
          <Icon name="add" className="size-3.5" />
          {t('events.keys.add')}
        </Button>
      </div>

      {error && (
        <div role="alert" className="p-2 rounded-lg bg-destructive/10 text-destructive text-xs">
          {error}
        </div>
      )}

      {formOpen && (
        <div className="space-y-2" data-testid={`events-binding-key-form-${binding.id}`}>
          <TextField
            label={t('events.keys.form.description')}
            tooltip={t('events.keys.form.descriptionTooltip')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={formError ?? undefined}
            id={`events-key-description-${binding.id}`}
            data-testid={`events-binding-key-description-${binding.id}`}
          />
          <TextField
            label={t('events.keys.form.name')}
            tooltip={t('events.keys.form.nameTooltip')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            id={`events-key-name-${binding.id}`}
            data-testid={`events-binding-key-name-${binding.id}`}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline-muted"
              onClick={() => setFormOpen(false)}
              disabled={creating}
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
        <div className="text-center text-muted-foreground py-3 text-xs">{t('common.loading')}</div>
      )}

      {keys && keys.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid={`events-binding-keys-empty-${binding.id}`}>
          {t('events.keys.empty')}
        </p>
      )}

      {keys && keys.length > 0 && (
        <ul className="space-y-1.5 min-w-0">
          {keys.map((key) => (
            <li
              key={key.id}
              data-testid={`events-binding-key-${key.id}`}
              className="flex flex-wrap items-start gap-2 rounded-md border border-border/60 bg-surface-inset p-2 min-w-0"
            >
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="font-mono text-xs break-all">{key.prefix}…</span>
                  {key.name && (
                    <span className="text-xs font-medium break-words">{key.name}</span>
                  )}
                </div>
                <div className="text-[0.6875rem] text-muted-foreground break-words">
                  {key.description}
                </div>
                <div className="text-[0.6875rem] text-muted-foreground break-words">
                  {key.createdBy} · {formatDateTime(key.createdAt, locale)}
                  {key.lastUsedAt && ` · ${t('events.keys.lastUsed')}: ${formatDateTime(key.lastUsedAt, locale)}`}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 min-h-8 min-w-8 hover:text-destructive"
                onClick={() => void handleDelete(key)}
                disabled={pendingId === key.id}
                title={t('common.delete')}
                aria-label={t('common.delete')}
                data-testid={`events-binding-key-delete-${key.id}`}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {created && (
        <div
          className="space-y-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 min-w-0"
          data-testid={`events-binding-key-secret-${binding.id}`}
        >
          <p className="text-xs font-medium text-status-warning break-words">
            {t('events.keys.secretWarning')}
          </p>
          <div className="flex items-center gap-2 min-w-0">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
              {created.key}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
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
            className="shrink-0 min-h-7 px-2"
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
          className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-surface-inset p-2 text-[0.6875rem] whitespace-pre-wrap break-all"
        >
          {curl}
        </pre>
      </div>
    </div>
  )
}
