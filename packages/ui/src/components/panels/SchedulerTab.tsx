import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  Schedule,
  ScheduleInput,
  ScheduleRunStatus,
  ScheduleTarget,
} from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { formatDateTime } from '@/lib/formatDate'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { TextArea, TextField } from '@/components/ui/settings'
import { PanelTab } from './PanelTab'

/** AD-051/AD-089: настройка триггера — ровно одно из `cron` / `every`. */
type TriggerKind = 'cron' | 'every'
type TargetMode = ScheduleTarget['mode']

/** Интервалы `every` (парсер core: целое число + `s|m|h|d`). */
const EVERY_OPTIONS = ['30s', '15m', '1h', '24h'] as const
/** TTL ephemeral-сессии (парсер `parseTtl`: `s|m|h|d`); пусто — дефолт инстанса. */
const TTL_OPTIONS = ['', '30s', '15m', '1h', '24h', '7d'] as const

interface EditorState {
  id?: string
  name: string
  enabled: boolean
  trigger: TriggerKind
  cron: string
  every: string
  mode: TargetMode
  sessionId: string
  agentTemplate: string
  project: string
  ttl: string
  prompt: string
}

const EMPTY_EDITOR: EditorState = {
  name: '',
  enabled: true,
  trigger: 'cron',
  cron: '*/5 * * * *',
  every: '15m',
  mode: 'bound',
  sessionId: '',
  agentTemplate: '',
  project: '',
  ttl: '',
  prompt: '',
}

/** Полная сущность → вход обновления (сохраняет payload/ownerId при toggle). */
function scheduleToInput(schedule: Schedule): ScheduleInput {
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    cron: schedule.cron,
    every: schedule.every,
    target: schedule.target,
    prompt: schedule.prompt,
    payload: schedule.payload,
    ownerId: schedule.ownerId,
  }
}

/** Черновик формы → вход API: пустые строки опускаются. */
function editorToInput(editor: EditorState): ScheduleInput {
  const target: ScheduleTarget =
    editor.mode === 'ephemeral'
      ? {
          mode: 'ephemeral',
          agentTemplate: editor.agentTemplate || undefined,
          project: editor.project || undefined,
          ttl: editor.ttl || undefined,
        }
      : { mode: editor.mode, sessionId: editor.sessionId }
  return {
    name: editor.name.trim(),
    enabled: editor.enabled,
    cron: editor.trigger === 'cron' ? editor.cron.trim() : undefined,
    every: editor.trigger === 'every' ? editor.every : undefined,
    target,
    prompt: editor.prompt.trim() || undefined,
  }
}

/**
 * AD-051/AD-089: вкладка правой панели «Шедулер» — CRUD расписаний планировщика.
 *
 * Расписания инстанса (не привязаны к сессии): список, инлайн-форма создания/
 * редактирования, быстрый toggle, принудительный запуск и удаление. Срабатывание
 * публикует событие через core/EventRouter — здесь только управление.
 */
export function SchedulerTab() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const sessions = useSessionsStore((s) => s.sessions)
  const agents = useAgentsStore((s) => s.agents)
  const projects = useProjectsStore((s) => s.projects)

  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<string[]>([])

  /** id → отображаемое имя сессии (событие `bound`/`queue`). */
  const sessionName = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, session.name || session.id)
    return map
  }, [sessions])

  const loadSchedules = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const { schedules: list } = await synthApi.getSchedules()
      setSchedules(list)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('rightPanel.scheduler.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadSchedules()
  }, [loadSchedules])

  // Списки для селектов грузятся при открытии вкладки (сессии/агенты/проекты).
  useEffect(() => {
    void useSessionsStore.getState().loadSessions()
    void useAgentsStore.getState().loadAgents()
    void useProjectsStore.getState().loadProjects()
  }, [])

  /** Общий guard повторных кликов по конкретной сущности (`key`). */
  const runWithPending = async (key: string, fn: () => Promise<void>) => {
    if (pendingKeys.includes(key)) return
    setPendingKeys((keys) => [...keys, key])
    try {
      await fn()
    } finally {
      setPendingKeys((keys) => keys.filter((k) => k !== key))
    }
  }

  const isPending = (key: string) => pendingKeys.includes(key)

  const openCreate = () => {
    setFormError(null)
    setSaveError(null)
    setEditor({ ...EMPTY_EDITOR })
  }

  const openEdit = (schedule: Schedule) => {
    setFormError(null)
    setSaveError(null)
    const target = schedule.target
    setEditor({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      trigger: schedule.every ? 'every' : 'cron',
      cron: schedule.cron ?? '',
      every: schedule.every ?? '15m',
      mode: target.mode,
      sessionId: target.mode === 'bound' || target.mode === 'queue' ? target.sessionId : '',
      agentTemplate: target.mode === 'ephemeral' ? target.agentTemplate ?? '' : '',
      project: target.mode === 'ephemeral' ? target.project ?? '' : '',
      ttl: target.mode === 'ephemeral' ? target.ttl ?? '' : '',
      prompt: schedule.prompt ?? '',
    })
  }

  const closeEditor = () => {
    setEditor(null)
    setFormError(null)
    setSaveError(null)
  }

  const handleSave = async () => {
    if (!editor) return
    if (!editor.name.trim()) {
      setFormError(t('rightPanel.scheduler.form.nameRequired'))
      return
    }
    if (editor.mode !== 'ephemeral' && !editor.sessionId) {
      setFormError(t('rightPanel.scheduler.form.sessionRequired'))
      return
    }
    if (editor.trigger === 'cron' && !editor.cron.trim()) {
      setFormError(t('rightPanel.scheduler.form.cronRequired'))
      return
    }
    if (editor.trigger === 'every' && !editor.every) {
      setFormError(t('rightPanel.scheduler.form.everyRequired'))
      return
    }
    setFormError(null)
    setSaving(true)
    setSaveError(null)
    try {
      const input = editorToInput(editor)
      if (editor.id) await synthApi.updateSchedule(editor.id, input)
      else await synthApi.createSchedule(input)
      await loadSchedules()
      closeEditor()
      notify({ text: t('rightPanel.scheduler.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setSaveError(message)
      notify({
        text: t('rightPanel.scheduler.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = (schedule: Schedule) => {
    void runWithPending(`toggle:${schedule.id}`, async () => {
      try {
        await synthApi.updateSchedule(schedule.id, {
          ...scheduleToInput(schedule),
          enabled: !schedule.enabled,
        })
        await loadSchedules()
      } catch (err) {
        notify({
          text: t('rightPanel.scheduler.toggleError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      }
    })
  }

  const handleRun = (schedule: Schedule) => {
    void runWithPending(`run:${schedule.id}`, async () => {
      try {
        await synthApi.runSchedule(schedule.id)
        await loadSchedules()
        notify({ text: t('rightPanel.scheduler.runSuccess'), type: 'success', category: 'system' })
      } catch (err) {
        notify({
          text: t('rightPanel.scheduler.runError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      }
    })
  }

  const handleDelete = async (schedule: Schedule) => {
    const ok = await confirm({
      title: t('rightPanel.scheduler.deleteTitle'),
      message: t('rightPanel.scheduler.deleteConfirm', { name: schedule.name }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    await runWithPending(`delete:${schedule.id}`, async () => {
      try {
        await synthApi.deleteSchedule(schedule.id)
        await loadSchedules()
        notify({ text: t('rightPanel.scheduler.deleted'), type: 'success', category: 'system' })
      } catch (err) {
        notify({
          text: t('rightPanel.scheduler.deleteError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      }
    })
  }

  const triggerLabel = (schedule: Schedule) =>
    schedule.every
      ? `${t('rightPanel.scheduler.trigger.every')} ${schedule.every}`
      : `${t('rightPanel.scheduler.trigger.cron')} ${schedule.cron ?? ''}`

  const targetLabel = (schedule: Schedule) => {
    const target = schedule.target
    if (target.mode === 'ephemeral') {
      const parts = [t('rightPanel.scheduler.target.ephemeral')]
      if (target.agentTemplate) {
        parts.push(`${t('rightPanel.scheduler.field.agent')}: ${target.agentTemplate}`)
      }
      if (target.project) {
        parts.push(`${t('rightPanel.scheduler.field.project')}: ${target.project}`)
      }
      if (target.ttl) parts.push(`${t('rightPanel.scheduler.field.ttl')}: ${target.ttl}`)
      return parts.join(' · ')
    }
    const label =
      target.mode === 'queue'
        ? t('rightPanel.scheduler.target.queue')
        : t('rightPanel.scheduler.target.bound')
    return `${label}: ${sessionName.get(target.sessionId) ?? target.sessionId}`
  }

  const statusLabel = (status: ScheduleRunStatus) =>
    t(`rightPanel.scheduler.status.${status}`)

  return (
    <PanelTab>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="scheduler-count">
          {schedules ? t('rightPanel.scheduler.count', { count: schedules.length }) : ''}
        </span>
        <Button data-testid="scheduler-add" onClick={openCreate}>
          <Icon name="add" className="size-3.5" />
          {t('rightPanel.scheduler.add')}
        </Button>
      </div>

      {loadError && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {editor && (
        <div
          className="w-full min-w-0 space-y-3 rounded-xl border border-border/60 bg-background p-4"
          data-testid="scheduler-editor"
        >
          <h4 className="text-sm font-medium text-foreground break-words">
            {editor.id ? t('rightPanel.scheduler.form.edit') : t('rightPanel.scheduler.form.new')}
          </h4>

          {saveError && (
            <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {saveError}
            </div>
          )}

          <TextField
            label={t('rightPanel.scheduler.field.name')}
            value={editor.name}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            error={formError ?? undefined}
            id="scheduler-name"
            data-testid="scheduler-name"
          />

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">{t('rightPanel.scheduler.field.enabled')}</span>
            <Toggle
              enabled={editor.enabled}
              onToggle={() => setEditor((prev) => (prev ? { ...prev, enabled: !prev.enabled } : prev))}
              ariaLabel={t('rightPanel.scheduler.field.enabled')}
            />
          </div>

          <NativeSelect
            label={t('rightPanel.scheduler.field.trigger')}
            value={editor.trigger}
            onChange={(value) =>
              setEditor((prev) => (prev ? { ...prev, trigger: value as TriggerKind } : prev))
            }
            testId="scheduler-trigger"
          >
            <option value="cron">{t('rightPanel.scheduler.trigger.cron')}</option>
            <option value="every">{t('rightPanel.scheduler.trigger.every')}</option>
          </NativeSelect>

          {editor.trigger === 'cron' ? (
            <TextField
              label={t('rightPanel.scheduler.field.cron')}
              value={editor.cron}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, cron: e.target.value } : prev))}
              placeholder="*/5 * * * *"
              mono
              id="scheduler-cron"
              data-testid="scheduler-cron"
            />
          ) : (
            <NativeSelect
              label={t('rightPanel.scheduler.field.every')}
              value={editor.every}
              onChange={(value) => setEditor((prev) => (prev ? { ...prev, every: value } : prev))}
              testId="scheduler-every"
            >
              {EVERY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </NativeSelect>
          )}

          <NativeSelect
            label={t('rightPanel.scheduler.field.target')}
            value={editor.mode}
            onChange={(value) =>
              setEditor((prev) => (prev ? { ...prev, mode: value as TargetMode } : prev))
            }
            testId="scheduler-target"
          >
            <option value="bound">{t('rightPanel.scheduler.target.bound')}</option>
            <option value="ephemeral">{t('rightPanel.scheduler.target.ephemeral')}</option>
            <option value="queue">{t('rightPanel.scheduler.target.queue')}</option>
          </NativeSelect>

          {editor.mode !== 'ephemeral' ? (
            <NativeSelect
              label={t('rightPanel.scheduler.field.session')}
              value={editor.sessionId}
              onChange={(value) => setEditor((prev) => (prev ? { ...prev, sessionId: value } : prev))}
              testId="scheduler-session"
            >
              <option value="">{t('rightPanel.scheduler.selectSession')}</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name || session.id}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <>
              <NativeSelect
                label={t('rightPanel.scheduler.field.agent')}
                value={editor.agentTemplate}
                onChange={(value) =>
                  setEditor((prev) => (prev ? { ...prev, agentTemplate: value } : prev))
                }
                testId="scheduler-agent"
              >
                <option value="">{t('rightPanel.scheduler.selectAgent')}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.display_name || agent.id}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                label={t('rightPanel.scheduler.field.project')}
                value={editor.project}
                onChange={(value) => setEditor((prev) => (prev ? { ...prev, project: value } : prev))}
                testId="scheduler-project"
              >
                <option value="">{t('rightPanel.scheduler.selectProject')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                label={t('rightPanel.scheduler.field.ttl')}
                value={editor.ttl}
                onChange={(value) => setEditor((prev) => (prev ? { ...prev, ttl: value } : prev))}
                testId="scheduler-ttl"
              >
                {TTL_OPTIONS.map((option) => (
                  <option key={option || 'default'} value={option}>
                    {option || t('rightPanel.scheduler.ttlDefault')}
                  </option>
                ))}
              </NativeSelect>
            </>
          )}

          <TextArea
            label={t('rightPanel.scheduler.field.prompt')}
            value={editor.prompt}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, prompt: e.target.value } : prev))}
            rows={3}
            id="scheduler-prompt"
            data-testid="scheduler-prompt"
          />

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={saving}
              data-testid="scheduler-save"
            >
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button
              variant="outline-muted"
              onClick={closeEditor}
              disabled={saving}
              data-testid="scheduler-cancel"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {loading && schedules === null && (
        <div className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      )}

      {schedules && schedules.length === 0 && !editor && (
        <div className="py-6 text-center text-muted-foreground" data-testid="scheduler-empty">
          <Icon name="calendar-schedule" className="mx-auto mb-2 size-8 opacity-40" />
          <p className="text-sm">{t('rightPanel.scheduler.empty')}</p>
        </div>
      )}

      {schedules && schedules.length > 0 && (
        <div className="space-y-2 min-w-0" data-testid="scheduler-list">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              data-testid={`scheduler-item-${schedule.id}`}
              className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3 transition-colors hover:border-primary/50"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon name="calendar-schedule" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{schedule.name}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium ${
                    schedule.enabled
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {schedule.enabled
                    ? t('rightPanel.scheduler.status.enabled')
                    : t('rightPanel.scheduler.status.disabled')}
                </span>
                <Toggle
                  enabled={schedule.enabled}
                  onToggle={() => handleToggle(schedule)}
                  pending={isPending(`toggle:${schedule.id}`)}
                  ariaLabel={`${schedule.name}: ${t('rightPanel.scheduler.field.enabled')}`}
                />
              </div>

              <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-muted-foreground min-w-0">
                <InfoRow label={t('rightPanel.scheduler.row.trigger')} value={triggerLabel(schedule)} />
                <InfoRow label={t('rightPanel.scheduler.row.target')} value={targetLabel(schedule)} />
                <InfoRow
                  label={t('rightPanel.scheduler.row.nextRun')}
                  value={formatDateTime(schedule.nextRunAt, locale)}
                />
                <InfoRow
                  label={t('rightPanel.scheduler.row.lastRun')}
                  value={formatDateTime(schedule.lastRunAt, locale)}
                />
                {schedule.lastStatus && (
                  <InfoRow
                    label={t('rightPanel.scheduler.row.lastStatus')}
                    value={statusLabel(schedule.lastStatus)}
                  />
                )}
              </dl>

              {schedule.lastError && (
                <div className="break-words text-xs text-destructive" data-testid={`scheduler-error-${schedule.id}`}>
                  <span className="font-medium">{t('rightPanel.scheduler.row.lastError')}:</span>{' '}
                  {schedule.lastError}
                </div>
              )}

              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-10 min-w-10"
                  onClick={() => handleRun(schedule)}
                  disabled={isPending(`run:${schedule.id}`)}
                  title={t('rightPanel.scheduler.run')}
                  aria-label={t('rightPanel.scheduler.run')}
                  data-testid={`scheduler-run-${schedule.id}`}
                >
                  <Icon name="rocket" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-10 min-w-10"
                  onClick={() => openEdit(schedule)}
                  title={t('common.edit')}
                  aria-label={t('common.edit')}
                  data-testid={`scheduler-edit-${schedule.id}`}
                >
                  <Icon name="edit-2" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-10 min-w-10 hover:text-destructive"
                  onClick={() => void handleDelete(schedule)}
                  disabled={isPending(`delete:${schedule.id}`)}
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                  data-testid={`scheduler-delete-${schedule.id}`}
                >
                  <Icon name="delete-bin" className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelTab>
  )
}

/** Строка «лейбл — значение» в карточке расписания. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 min-w-0">
      <dt className="shrink-0 font-medium">{label}:</dt>
      <dd className="min-w-0 break-words text-right">{value}</dd>
    </div>
  )
}

/** Компактный нативный select в стиле панелей (сессии/агенты/проекты/триггер). */
function NativeSelect({
  label,
  value,
  onChange,
  children,
  testId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        data-testid={testId}
        className="w-full min-w-0 rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {children}
      </select>
    </div>
  )
}
