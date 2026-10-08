import { useCallback, useEffect, useState } from 'react'
import type { EventBinding, EventDeliveryMode } from '@itphx/synth-shared'
import { synthApi, type EventJournalEntry } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { SelectContent, SelectItem } from '../ui/select'
import { SelectField, SettingsPanel, SettingsSection, TextField } from '../ui/settings'

/** AD-089: режимы доставки биндинга (без `drop` — он осознанный отказ без привязки). */
const EVENT_MODES: EventDeliveryMode[] = ['bound', 'ephemeral', 'queue']

/** Ограничение журнала: сколько последних записей запрашивать. */
const JOURNAL_LIMIT = 50

interface EditorState {
  id?: string
  source: string
  chatKey: string
  threadKey: string
  mode: EventDeliveryMode
  sessionId: string
  agentTemplate: string
  project: string
}

const EMPTY_EDITOR: EditorState = {
  source: '',
  chatKey: '',
  threadKey: '',
  mode: 'bound',
  sessionId: '',
  agentTemplate: '',
  project: '',
}

/**
 * AD-089 / AD-072: админ-раздел «События» — реестр биндингов внешних событий
 * (привязка source/chat/thread → сессия/шаблон) и журнал решений Router.
 *
 * Мониторинг и CRUD биндингов идут через `synthApi`; мутации — только ADMIN
 * (серверный guard), UI лишь скрывает раздел от не-админов.
 */
export function EventsAdminSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [bindings, setBindings] = useState<EventBinding[] | null>(null)
  const [bindingsLoading, setBindingsLoading] = useState(true)
  const [bindingsError, setBindingsError] = useState<string | null>(null)

  const [journal, setJournal] = useState<EventJournalEntry[] | null>(null)
  const [journalLoading, setJournalLoading] = useState(true)
  const [journalError, setJournalError] = useState<string | null>(null)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadBindings = useCallback(async () => {
    setBindingsLoading(true)
    setBindingsError(null)
    try {
      const { bindings: list } = await synthApi.listEventBindings()
      setBindings(list)
    } catch (err) {
      setBindingsError(err instanceof Error ? err.message : t('events.bindings.loadError'))
    } finally {
      setBindingsLoading(false)
    }
  }, [t])

  const loadJournal = useCallback(async () => {
    setJournalLoading(true)
    setJournalError(null)
    try {
      const { entries } = await synthApi.getEventJournal(JOURNAL_LIMIT)
      setJournal(entries)
    } catch (err) {
      setJournalError(err instanceof Error ? err.message : t('events.journal.loadError'))
    } finally {
      setJournalLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadBindings()
  }, [loadBindings])

  useEffect(() => {
    void loadJournal()
  }, [loadJournal])

  const openCreate = () => {
    setFormError(null)
    setSaveError(null)
    setEditor({ ...EMPTY_EDITOR })
  }

  const openEdit = (binding: EventBinding) => {
    setFormError(null)
    setSaveError(null)
    setEditor({
      id: binding.id,
      source: binding.source,
      chatKey: binding.chatKey ?? '',
      threadKey: binding.threadKey ?? '',
      mode: binding.mode,
      sessionId: binding.sessionId ?? '',
      agentTemplate: binding.agentTemplate ?? '',
      project: binding.project ?? '',
    })
  }

  const closeEditor = () => {
    setEditor(null)
    setFormError(null)
    setSaveError(null)
  }

  const handleSave = async () => {
    if (!editor) return
    if (!editor.source.trim()) {
      setFormError(t('events.form.sourceRequired'))
      return
    }
    setFormError(null)
    setSaving(true)
    setSaveError(null)
    try {
      await synthApi.upsertEventBinding({
        source: editor.source.trim(),
        chatKey: editor.chatKey.trim() || undefined,
        threadKey: editor.threadKey.trim() || undefined,
        sessionId: editor.sessionId.trim() || undefined,
        mode: editor.mode,
        agentTemplate: editor.agentTemplate.trim() || undefined,
        project: editor.project.trim() || undefined,
      })
      await loadBindings()
      closeEditor()
      notify({ text: t('events.bindings.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setSaveError(message)
      notify({
        text: t('events.bindings.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (binding: EventBinding) => {
    const label = binding.threadKey ?? binding.chatKey ?? binding.source
    const ok = await confirm({
      title: t('events.bindings.deleteTitle'),
      message: t('events.bindings.deleteConfirm', { source: label }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    try {
      await synthApi.deleteEventBinding(binding.id)
      await loadBindings()
      notify({ text: t('events.bindings.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('events.bindings.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    }
  }

  const modeLabel = (mode: EventDeliveryMode) => t(`events.mode.${mode}`)

  return (
    <SettingsPanel
      title={t('events.title')}
      description={t('events.description')}
      meta={bindings ? t('events.bindings.count', { count: bindings.length }) : undefined}
    >
      {/* Биндинги (AD-089 §EventBinding) */}
      <SettingsSection
        title={t('events.bindings.title')}
        description={t('events.bindings.description')}
        actions={
          <Button data-testid="events-binding-add" onClick={openCreate}>
            <Icon name="add" className="size-3.5" />
            {t('events.bindings.add')}
          </Button>
        }
      >
        {bindingsError && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {bindingsError}
          </div>
        )}

        {editor && (
          <div
            className="w-full min-w-0 rounded-xl border border-border/60 bg-background p-4 space-y-3"
            data-testid="events-binding-editor"
          >
            <h4 className="text-sm font-medium text-foreground break-words">
              {editor.id ? t('events.form.edit') : t('events.form.new')}
            </h4>

            {saveError && (
              <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                {saveError}
              </div>
            )}

            <TextField
              label={t('events.form.source')}
              value={editor.source}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, source: e.target.value } : prev))}
              error={formError ?? undefined}
              id="events-binding-source"
              data-testid="events-binding-source"
            />

            <TextField
              label={t('events.form.chatKey')}
              value={editor.chatKey}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, chatKey: e.target.value } : prev))}
              mono
              id="events-binding-chat-key"
              data-testid="events-binding-chat-key"
            />

            <TextField
              label={t('events.form.threadKey')}
              value={editor.threadKey}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, threadKey: e.target.value } : prev))}
              mono
              id="events-binding-thread-key"
              data-testid="events-binding-thread-key"
            />

            <SelectField
              label={t('events.form.mode')}
              value={editor.mode}
              onValueChange={(value) =>
                setEditor((prev) => (prev ? { ...prev, mode: value as EventDeliveryMode } : prev))
              }
              ariaLabel={t('events.form.mode')}
            >
              <SelectContent>
                {EVENT_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {modeLabel(mode)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <TextField
              label={t('events.form.sessionId')}
              value={editor.sessionId}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, sessionId: e.target.value } : prev))}
              mono
              id="events-binding-session"
              data-testid="events-binding-session"
            />

            <TextField
              label={t('events.form.agentTemplate')}
              value={editor.agentTemplate}
              onChange={(e) =>
                setEditor((prev) => (prev ? { ...prev, agentTemplate: e.target.value } : prev))
              }
              id="events-binding-agent"
              data-testid="events-binding-agent"
            />

            <TextField
              label={t('events.form.project')}
              value={editor.project}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, project: e.target.value } : prev))}
              mono
              id="events-binding-project"
              data-testid="events-binding-project"
            />

            <div className="flex flex-wrap items-center gap-2 justify-end">
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                disabled={saving}
                data-testid="events-binding-save"
              >
                {saving ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                variant="outline-muted"
                onClick={closeEditor}
                disabled={saving}
                data-testid="events-binding-cancel"
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {bindingsLoading && bindings === null && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {bindings && bindings.length === 0 && !editor && (
          <div className="text-center text-muted-foreground py-6">
            <Icon name="send-plane" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('events.bindings.empty')}</p>
          </div>
        )}

        {bindings && bindings.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="events-bindings-list">
            {bindings.map((binding) => {
              const key = binding.threadKey ?? binding.chatKey
              return (
                <div
                  key={binding.id}
                  data-testid={`events-binding-${binding.id}`}
                  className="flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border bg-surface-inset hover:border-primary/50 transition-colors min-w-0"
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                      <Icon name="send-plane" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium break-words">{binding.source}</span>
                      <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-primary/15 text-primary">
                        {modeLabel(binding.mode)}
                      </span>
                    </div>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground min-w-0">
                      <div className="min-w-0 break-words">
                        <dt className="inline font-medium">{t('events.column.key')}:</dt>{' '}
                        <dd className="inline">{key ?? t('events.bindings.noKey')}</dd>
                      </div>
                      <div className="min-w-0 break-words">
                        <dt className="inline font-medium">{t('events.column.session')}:</dt>{' '}
                        <dd className="inline">{binding.sessionId ?? t('events.bindings.noValue')}</dd>
                      </div>
                      <div className="min-w-0 break-words">
                        <dt className="inline font-medium">{t('events.column.agent')}:</dt>{' '}
                        <dd className="inline">{binding.agentTemplate ?? t('events.bindings.noValue')}</dd>
                      </div>
                      <div className="min-w-0 break-words">
                        <dt className="inline font-medium">{t('events.column.project')}:</dt>{' '}
                        <dd className="inline">{binding.project ?? t('events.bindings.noValue')}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 min-h-10 min-w-10"
                      onClick={() => openEdit(binding)}
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                      data-testid={`events-binding-edit-${binding.id}`}
                    >
                      <Icon name="edit-2" className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 min-h-10 min-w-10 hover:text-destructive"
                      onClick={() => void handleDelete(binding)}
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      data-testid={`events-binding-delete-${binding.id}`}
                    >
                      <Icon name="delete-bin" className="size-4" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      {/* Журнал обработанных событий (AD-089) */}
      <SettingsSection
        title={t('events.journal.title')}
        description={t('events.journal.description')}
        actions={
          <Button
            variant="outline"
            data-testid="events-journal-refresh"
            onClick={() => void loadJournal()}
            disabled={journalLoading}
          >
            <Icon name="refresh" className="size-3.5" />
            {t('common.refresh')}
          </Button>
        }
      >
        {journalError && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {journalError}
          </div>
        )}

        {journalLoading && journal === null && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {journal && journal.length === 0 && (
          <div className="text-center text-muted-foreground py-6">
            <Icon name="time" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('events.journal.empty')}</p>
          </div>
        )}

        {journal && journal.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="events-journal-list">
            {journal.map((entry, index) => {
              const reason =
                entry.decision && (entry.decision.kind === 'queue' || entry.decision.kind === 'drop')
                  ? entry.decision.reason
                  : undefined
              return (
                <div
                  key={`${entry.event.id}-${index}`}
                  data-testid={`events-journal-${index}`}
                  className="p-3 rounded-lg border border-border bg-surface-inset space-y-1 min-w-0"
                >
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
                      {entry.decision?.kind ?? t('events.journal.noDecision')}
                    </span>
                    <span className="text-xs text-muted-foreground break-words">
                      {entry.event.source} · {entry.event.type}
                    </span>
                    <span className="text-[0.6875rem] text-muted-foreground ml-auto">
                      {formatDateTime(entry.ts)}
                    </span>
                  </div>
                  {reason && (
                    <div className="text-xs text-muted-foreground break-words">
                      <span className="font-medium">{t('events.journal.reason')}:</span> {reason}
                    </div>
                  )}
                  {entry.error && (
                    <div className="text-xs text-destructive break-words">
                      <span className="font-medium">{t('events.journal.error')}:</span> {entry.error}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}

/** Дата/время записи журнала; при некорректном значении возвращает исходное. */
function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
