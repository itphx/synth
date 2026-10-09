import { useCallback, useEffect, useState } from 'react'
import type {
  EventRouteMatch,
  EventRouteRule,
  EventRouteRuleInputRequest,
  EventRouteTarget,
} from '@itphx/synth-shared'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { Icon } from '../icon/Icon'
import { Toggle } from '../ui/Toggle'
import { Button } from '../ui/button'
import { SelectContent, SelectItem } from '../ui/select'
import {
  NumberField,
  SelectField,
  SettingsSection,
  TextArea,
  TextField,
  ToggleField,
} from '../ui/settings'

/** AD-089: режим цели правила маршрутизации (совпадает с `EventRouteTarget`). */
type RouteMode = EventRouteTarget['mode']

const ROUTE_MODES: RouteMode[] = ['bound', 'ephemeral', 'queue']

interface EditorState {
  id?: string
  name: string
  /** Хранится строкой — `NumberField` даёт черновик до парсинга. */
  priority: string
  enabled: boolean
  source: string
  type: string
  chatKey: string
  threadKey: string
  principalId: string
  label: string
  /** Ключевые слова одной строкой (см. `parseKeywords`). */
  keywords: string
  mode: RouteMode
  sessionId: string
  agentTemplate: string
  project: string
  ttl: string
}

const EMPTY_EDITOR: EditorState = {
  name: '',
  priority: '0',
  enabled: true,
  source: '',
  type: '',
  chatKey: '',
  threadKey: '',
  principalId: '',
  label: '',
  keywords: '',
  mode: 'bound',
  sessionId: '',
  agentTemplate: '',
  project: '',
  ttl: '',
}

/** Ключевые слова — из строки в массив (разделители: запятая/перенос строки). */
function parseKeywords(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

/** Черновик формы → вход API: пустые строки опускаются. */
function editorToInput(editor: EditorState): EventRouteRuleInputRequest {
  const match: EventRouteMatch = {}
  if (editor.source.trim()) match.source = editor.source.trim()
  if (editor.type.trim()) match.type = editor.type.trim()
  if (editor.chatKey.trim()) match.chatKey = editor.chatKey.trim()
  if (editor.threadKey.trim()) match.threadKey = editor.threadKey.trim()
  if (editor.principalId.trim()) match.principalId = editor.principalId.trim()
  if (editor.label.trim()) match.label = editor.label.trim()
  const keywords = parseKeywords(editor.keywords)
  if (keywords.length > 0) match.keywords = keywords

  const target: EventRouteTarget =
    editor.mode === 'ephemeral'
      ? {
          mode: 'ephemeral',
          agentTemplate: editor.agentTemplate.trim() || undefined,
          project: editor.project.trim() || undefined,
          ttl: editor.ttl.trim() || undefined,
        }
      : { mode: editor.mode, sessionId: editor.sessionId.trim() }

  const priority = Number.parseInt(editor.priority, 10)

  return {
    name: editor.name.trim() || undefined,
    priority: Number.isNaN(priority) ? 0 : priority,
    enabled: editor.enabled,
    match,
    target,
  }
}

/**
 * Существующее правило → вход API (для upsert-обновлений из списка, напр. тумблера
 * `enabled`). Все поля правила передаются без изменений.
 */
function ruleToInput(rule: EventRouteRule): EventRouteRuleInputRequest {
  return {
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    match: rule.match,
    target: rule.target,
  }
}

/**
 * AD-089 / AD-072: секция «Правила маршрутизации» админ-раздела «События».
 *
 * Список правил (`EventRouteRule`) с инлайн-формой создания/редактирования и
 * удалением. Правила упорядочены по приоритету (больше — раньше); сама
 * маршрутизация исполняется core, здесь только управление. Мутации — ADMIN.
 */
export function EventRoutesSection() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [rules, setRules] = useState<EventRouteRule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** id правил, по которым сейчас идёт инлайн-переключение (список — не блокируем). */
  const [pendingIds, setPendingIds] = useState<string[]>([])

  const loadRules = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const { rules: list } = await synthApi.getEventRoutes()
      setRules(list)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('events.routes.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const openCreate = () => {
    setFormError(null)
    setSaveError(null)
    setEditor({ ...EMPTY_EDITOR })
  }

  const openEdit = (rule: EventRouteRule) => {
    setFormError(null)
    setSaveError(null)
    setEditor({
      id: rule.id,
      name: rule.name ?? '',
      priority: String(rule.priority),
      enabled: rule.enabled,
      source: rule.match.source ?? '',
      type: rule.match.type ?? '',
      chatKey: rule.match.chatKey ?? '',
      threadKey: rule.match.threadKey ?? '',
      principalId: rule.match.principalId ?? '',
      label: rule.match.label ?? '',
      keywords: (rule.match.keywords ?? []).join(', '),
      mode: rule.target.mode,
      sessionId:
        rule.target.mode === 'bound' || rule.target.mode === 'queue' ? rule.target.sessionId : '',
      agentTemplate: rule.target.mode === 'ephemeral' ? rule.target.agentTemplate ?? '' : '',
      project: rule.target.mode === 'ephemeral' ? rule.target.project ?? '' : '',
      ttl: rule.target.mode === 'ephemeral' ? rule.target.ttl ?? '' : '',
    })
  }

  const closeEditor = () => {
    setEditor(null)
    setFormError(null)
    setSaveError(null)
  }

  const handleSave = async () => {
    if (!editor) return
    if (editor.mode !== 'ephemeral' && !editor.sessionId.trim()) {
      setFormError(t('events.routes.form.sessionRequired'))
      return
    }
    setFormError(null)
    setSaving(true)
    setSaveError(null)
    try {
      const input = editorToInput(editor)
      await synthApi.createEventRoute(editor.id ? { ...input, id: editor.id } : input)
      await loadRules()
      closeEditor()
      notify({ text: t('events.routes.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setSaveError(message)
      notify({
        text: t('events.routes.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (rule: EventRouteRule) => {
    const label = rule.name?.trim() || t('events.routes.unnamed')
    const ok = await confirm({
      title: t('events.routes.deleteTitle'),
      message: t('events.routes.deleteConfirm', { name: label }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    try {
      await synthApi.deleteEventRoute(rule.id)
      await loadRules()
      notify({ text: t('events.routes.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('events.routes.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    }
  }

  /** Общий guard повторных кликов по конкретному правилу (`id`). */
  const runWithPending = async (id: string, fn: () => Promise<void>) => {
    if (pendingIds.includes(id)) return
    setPendingIds((ids) => [...ids, id])
    try {
      await fn()
    } finally {
      setPendingIds((ids) => ids.filter((x) => x !== id))
    }
  }

  const isPending = (id: string) => pendingIds.includes(id)

  /**
   * Инлайн-переключение `enabled` правила: upsert по `id` (createEventRoute) и
   * повторный `getEventRoutes`. Пока запрос в полёте, список не блокируется —
   * «занят» только конкретный тумблер. При ошибке состояние не меняем (правило
   * остаётся прежним) и показываем тост; повторные клики гасит `isPending`.
   */
  const handleToggle = (rule: EventRouteRule) => {
    void runWithPending(rule.id, async () => {
      try {
        await synthApi.createEventRoute({
          ...ruleToInput(rule),
          id: rule.id,
          enabled: !rule.enabled,
        })
        await loadRules()
      } catch (err) {
        notify({
          text: t('events.routes.toggleError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      }
    })
  }

  const modeLabel = (mode: RouteMode) => t(`events.mode.${mode}`)

  const matchSummary = (match: EventRouteMatch): string => {
    const parts: string[] = []
    if (match.source) parts.push(`${t('events.routes.form.source')}: ${match.source}`)
    if (match.type) parts.push(`${t('events.routes.form.type')}: ${match.type}`)
    if (match.chatKey) parts.push(`${t('events.routes.form.chatKey')}: ${match.chatKey}`)
    if (match.threadKey) parts.push(`${t('events.routes.form.threadKey')}: ${match.threadKey}`)
    if (match.principalId) parts.push(`${t('events.routes.form.principalId')}: ${match.principalId}`)
    if (match.label) parts.push(`${t('events.routes.form.label')}: ${match.label}`)
    if (match.keywords && match.keywords.length > 0) {
      parts.push(`${t('events.routes.form.keywords')}: ${match.keywords.join(', ')}`)
    }
    return parts.length > 0 ? parts.join(' · ') : t('events.routes.anyEvent')
  }

  const targetSummary = (target: EventRouteTarget): string => {
    if (target.mode === 'ephemeral') {
      const parts = [modeLabel('ephemeral')]
      if (target.agentTemplate) {
        parts.push(`${t('events.routes.form.agentTemplate')}: ${target.agentTemplate}`)
      }
      if (target.project) parts.push(`${t('events.routes.form.project')}: ${target.project}`)
      if (target.ttl) parts.push(`${t('events.routes.form.ttl')}: ${target.ttl}`)
      return parts.join(' · ')
    }
    return `${modeLabel(target.mode)}: ${target.sessionId}`
  }

  return (
    <SettingsSection
      title={t('events.routes.title')}
      description={t('events.routes.description')}
      actions={
        <Button data-testid="events-route-add" onClick={openCreate}>
          <Icon name="add" className="size-3.5" />
          {t('events.routes.add')}
        </Button>
      }
    >
      {loadError && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {loadError}
        </div>
      )}

      {editor && (
        <div
          className="w-full min-w-0 rounded-xl border border-border/60 bg-background p-4 space-y-3"
          data-testid="events-route-editor"
        >
          <h4 className="text-sm font-medium text-foreground break-words">
            {editor.id ? t('events.routes.form.edit') : t('events.routes.form.new')}
          </h4>

          {saveError && (
            <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {saveError}
            </div>
          )}

          <TextField
            label={t('events.routes.form.name')}
            value={editor.name}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            id="events-route-name"
            data-testid="events-route-name"
          />

          <NumberField
            label={t('events.routes.form.priority')}
            value={editor.priority}
            onChange={(e) =>
              setEditor((prev) => (prev ? { ...prev, priority: e.target.value } : prev))
            }
            id="events-route-priority"
            data-testid="events-route-priority"
          />

          <ToggleField
            label={t('events.routes.form.enabled')}
            enabled={editor.enabled}
            onToggle={() =>
              setEditor((prev) => (prev ? { ...prev, enabled: !prev.enabled } : prev))
            }
            ariaLabel={t('events.routes.form.enabled')}
          />

          <div className="text-xs font-medium text-muted-foreground min-w-0">
            {t('events.routes.form.matchTitle')}
          </div>

          <TextField
            label={t('events.routes.form.source')}
            value={editor.source}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, source: e.target.value } : prev))}
            id="events-route-source"
            data-testid="events-route-source"
          />

          <TextField
            label={t('events.routes.form.type')}
            value={editor.type}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, type: e.target.value } : prev))}
            id="events-route-type"
            data-testid="events-route-type"
          />

          <TextField
            label={t('events.routes.form.chatKey')}
            value={editor.chatKey}
            onChange={(e) =>
              setEditor((prev) => (prev ? { ...prev, chatKey: e.target.value } : prev))
            }
            mono
            id="events-route-chat-key"
            data-testid="events-route-chat-key"
          />

          <TextField
            label={t('events.routes.form.threadKey')}
            value={editor.threadKey}
            onChange={(e) =>
              setEditor((prev) => (prev ? { ...prev, threadKey: e.target.value } : prev))
            }
            mono
            id="events-route-thread-key"
            data-testid="events-route-thread-key"
          />

          <TextField
            label={t('events.routes.form.principalId')}
            value={editor.principalId}
            onChange={(e) =>
              setEditor((prev) => (prev ? { ...prev, principalId: e.target.value } : prev))
            }
            mono
            id="events-route-principal"
            data-testid="events-route-principal"
          />

          <TextField
            label={t('events.routes.form.label')}
            value={editor.label}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, label: e.target.value } : prev))}
            id="events-route-label"
            data-testid="events-route-label"
          />

          <TextArea
            label={t('events.routes.form.keywords')}
            description={t('events.routes.form.keywordsHelp')}
            value={editor.keywords}
            onChange={(e) =>
              setEditor((prev) => (prev ? { ...prev, keywords: e.target.value } : prev))
            }
            rows={2}
            id="events-route-keywords"
            data-testid="events-route-keywords"
          />

          <div className="text-xs font-medium text-muted-foreground min-w-0">
            {t('events.routes.form.targetTitle')}
          </div>

          <SelectField
            label={t('events.routes.form.mode')}
            value={editor.mode}
            onValueChange={(value) =>
              setEditor((prev) => (prev ? { ...prev, mode: value as RouteMode } : prev))
            }
            ariaLabel={t('events.routes.form.mode')}
            items={ROUTE_MODES.map((mode) => ({ value: mode, label: modeLabel(mode) }))}
          >
            <SelectContent>
              {ROUTE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {modeLabel(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          {editor.mode === 'ephemeral' ? (
            <>
              <TextField
                label={t('events.routes.form.agentTemplate')}
                value={editor.agentTemplate}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, agentTemplate: e.target.value } : prev))
                }
                id="events-route-agent"
                data-testid="events-route-agent"
              />

              <TextField
                label={t('events.routes.form.project')}
                value={editor.project}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, project: e.target.value } : prev))
                }
                mono
                id="events-route-project"
                data-testid="events-route-project"
              />

              <TextField
                label={t('events.routes.form.ttl')}
                value={editor.ttl}
                onChange={(e) => setEditor((prev) => (prev ? { ...prev, ttl: e.target.value } : prev))}
                placeholder="24h"
                mono
                id="events-route-ttl"
                data-testid="events-route-ttl"
              />
            </>
          ) : (
            <TextField
              label={t('events.routes.form.sessionId')}
              value={editor.sessionId}
              onChange={(e) =>
                setEditor((prev) => (prev ? { ...prev, sessionId: e.target.value } : prev))
              }
              error={formError ?? undefined}
              mono
              id="events-route-session"
              data-testid="events-route-session"
            />
          )}

          <div className="flex flex-wrap items-center gap-2 justify-end">
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={saving}
              data-testid="events-route-save"
            >
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button
              variant="outline-muted"
              onClick={closeEditor}
              disabled={saving}
              data-testid="events-route-cancel"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {loading && rules === null && (
        <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
      )}

      {rules && rules.length === 0 && !editor && (
        <div className="text-center text-muted-foreground py-6">
          <Icon name="git-branch" className="size-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">{t('events.routes.empty')}</p>
        </div>
      )}

      {rules && rules.length > 0 && (
        <div className="space-y-2 min-w-0" data-testid="events-routes-list">
          {rules.map((rule) => (
            <div
              key={rule.id}
              data-testid={`events-route-${rule.id}`}
              className="flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border bg-surface-inset hover:border-primary/50 transition-colors min-w-0"
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <Icon name="git-branch" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium break-words">
                    {rule.name?.trim() || t('events.routes.unnamed')}
                  </span>
                  <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
                    {t('events.routes.priority')}: {rule.priority}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[0.625rem] font-medium ${
                      rule.enabled
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {rule.enabled
                      ? t('events.routes.status.enabled')
                      : t('events.routes.status.disabled')}
                  </span>
                  <span className="shrink-0" data-testid={`events-route-toggle-${rule.id}`}>
                    <Toggle
                      enabled={rule.enabled}
                      onToggle={() => handleToggle(rule)}
                      pending={isPending(rule.id)}
                      ariaLabel={`${rule.name?.trim() || t('events.routes.unnamed')}: ${t(
                        'events.routes.form.enabled',
                      )}`}
                    />
                  </span>
                </div>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-muted-foreground min-w-0">
                  <div className="min-w-0 break-words">
                    <dt className="inline font-medium">{t('events.routes.match')}:</dt>{' '}
                    <dd className="inline">{matchSummary(rule.match)}</dd>
                  </div>
                  <div className="min-w-0 break-words">
                    <dt className="inline font-medium">{t('events.routes.target')}:</dt>{' '}
                    <dd className="inline">{targetSummary(rule.target)}</dd>
                  </div>
                </dl>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 min-h-10 min-w-10"
                  onClick={() => openEdit(rule)}
                  title={t('common.edit')}
                  aria-label={t('common.edit')}
                  data-testid={`events-route-edit-${rule.id}`}
                >
                  <Icon name="edit-2" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 min-h-10 min-w-10 hover:text-destructive"
                  onClick={() => void handleDelete(rule)}
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                  data-testid={`events-route-delete-${rule.id}`}
                >
                  <Icon name="delete-bin" className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  )
}
