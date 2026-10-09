import { useCallback, useEffect, useState } from 'react'
import type { EventBinding, EventDeliveryMode } from '@itphx/synth-shared'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useCanManageEvents } from '@/hooks/useCanManageEvents'
import { confirm } from '@/lib/confirm'
import { useUIStore } from '@/stores/useUIStore'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { SelectContent, SelectItem } from '../ui/select'
import { SelectField, SettingsPanel, SettingsSection, TextField } from '../ui/settings'
import { AgentSelect, ProjectSelect, SessionSelect } from './entity-selects'
import { EventBindingKeys } from './EventBindingKeys'
import { EventJournalPanel } from './EventJournalPanel'
import { EventRoutesSection } from './EventRoutesSection'

/** AD-089: режимы доставки биндинга (без `drop` — он осознанный отказ без привязки). */
const EVENT_MODES: EventDeliveryMode[] = ['bound', 'ephemeral', 'queue']

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
 * AD-089 / AD-072: раздел «События» — реестр биндингов внешних событий
 * (привязка source/чат/тред → сессия/шаблон), правила маршрутизации и журнал
 * решений Router.
 *
 * Раздел виден всем ролям (просмотр), но мутации (создание/изменение/удаление,
 * API-ключи) доступны только LEAD/ADMIN — UI лишь прячет управление, enforcement
 * на сервере.
 */
export function EventsAdminSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const canManage = useCanManageEvents()

  const [bindings, setBindings] = useState<EventBinding[] | null>(null)
  const [bindingsLoading, setBindingsLoading] = useState(true)
  const [bindingsError, setBindingsError] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])

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

  useEffect(() => {
    void loadBindings()
  }, [loadBindings])

  const openCreate = () => {
    if (!canManage) return
    setFormError(null)
    setSaveError(null)
    setEditor({ ...EMPTY_EDITOR })
  }

  const openEdit = (binding: EventBinding) => {
    if (!canManage) return
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

  const toggleKeys = (id: string) => {
    setExpandedKeys((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  }

  const openJournalInLogs = () => {
    const ui = useUIStore.getState()
    ui.setLogsPage('events')
    ui.setLogsDialogOpen(true)
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
          canManage ? (
            <Button data-testid="events-binding-add" onClick={openCreate}>
              <Icon name="add" className="size-3.5" />
              {t('events.bindings.add')}
            </Button>
          ) : undefined
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
              tooltip={t('events.form.sourceTooltip')}
              value={editor.source}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, source: e.target.value } : prev))}
              error={formError ?? undefined}
              id="events-binding-source"
              data-testid="events-binding-source"
            />

            <SelectField
              label={t('events.form.mode')}
              tooltip={t('events.form.modeTooltip')}
              value={editor.mode}
              onValueChange={(value) =>
                setEditor((prev) => (prev ? { ...prev, mode: value as EventDeliveryMode } : prev))
              }
              ariaLabel={t('events.form.mode')}
              items={EVENT_MODES.map((mode) => ({ value: mode, label: modeLabel(mode) }))}
            >
              <SelectContent>
                {EVENT_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {modeLabel(mode)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <ProjectSelect
              label={t('events.form.project')}
              tooltip={t('events.form.projectTooltip')}
              value={editor.project}
              onChange={(value) => setEditor((prev) => (prev ? { ...prev, project: value } : prev))}
              includeEmpty
              emptyLabel={t('events.bindings.noValue')}
              testId="events-binding-project"
            />

            <SessionSelect
              label={t('events.form.sessionId')}
              tooltip={t('events.form.sessionTooltip')}
              value={editor.sessionId}
              onChange={(value) => setEditor((prev) => (prev ? { ...prev, sessionId: value } : prev))}
              projectId={editor.project || null}
              includeEmpty
              emptyLabel={t('events.bindings.noValue')}
              testId="events-binding-session"
              allowCreate
            />

            <AgentSelect
              label={t('events.form.agentTemplate')}
              tooltip={t('events.form.agentTooltip')}
              value={editor.agentTemplate}
              onChange={(value) =>
                setEditor((prev) => (prev ? { ...prev, agentTemplate: value } : prev))
              }
              includeEmpty
              emptyLabel={t('events.bindings.noValue')}
              testId="events-binding-agent"
            />

            <TextField
              label={t('events.form.chatKey')}
              tooltip={t('events.form.chatKeyTooltip')}
              value={editor.chatKey}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, chatKey: e.target.value } : prev))}
              mono
              id="events-binding-chat-key"
              data-testid="events-binding-chat-key"
            />

            <TextField
              label={t('events.form.threadKey')}
              tooltip={t('events.form.threadKeyTooltip')}
              value={editor.threadKey}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, threadKey: e.target.value } : prev))}
              mono
              id="events-binding-thread-key"
              data-testid="events-binding-thread-key"
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
                  className="rounded-lg border border-border bg-surface-inset hover:border-primary/50 transition-colors min-w-0"
                >
                  <div className="flex flex-wrap items-start gap-3 p-3 min-w-0">
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
                    {canManage && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 min-h-10 min-w-10"
                          onClick={() => toggleKeys(binding.id)}
                          title={t('events.keys.title')}
                          aria-label={t('events.keys.title')}
                          aria-expanded={expandedKeys.includes(binding.id)}
                          data-testid={`events-binding-keys-toggle-${binding.id}`}
                        >
                          <Icon name="key" className="size-4" />
                        </Button>
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
                    )}
                  </div>
                  {canManage && expandedKeys.includes(binding.id) && (
                    <div className="px-3 pb-3">
                      <EventBindingKeys binding={binding} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      {/* Правила маршрутизации (AD-089 §EventRouteRule) */}
      <EventRoutesSection canManage={canManage} />

      {/* Журнал обработанных событий (AD-089) — доступен всем ролям */}
      <EventJournalPanel
        extraActions={
          <Button
            variant="outline"
            onClick={openJournalInLogs}
            data-testid="events-journal-open-logs"
          >
            <Icon name="external-link" className="size-3.5" />
            {t('events.journal.openInLogs')}
          </Button>
        }
      />
    </SettingsPanel>
  )
}
