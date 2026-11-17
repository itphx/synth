import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { Schedule } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { FieldTooltip, TextArea, TextField } from '@/components/ui/settings'
import { EntitySelect, ProjectSelect, SessionSelect, AgentSelect } from '@/components/settings/entity-selects'
import { usePipelinesStore } from '@/stores/pipelinesStore'
import {
  EVERY_OPTIONS,
  EMPTY_SCHEDULE_EDITOR,
  TTL_OPTIONS,
  editorToInput,
  parsePipelinePayload,
  scheduleToEditor,
  type ScheduleEditorState,
  type TargetMode,
  type TriggerKind,
} from './scheduleForm'

/**
 * Модальный редактор расписания (PROP-141, этап 7b).
 *
 * Форма перенесена из прежней вкладки «Шедулер» без изменения состава полей:
 * имя, триггер (cron/интервал), цель (`bound`/`queue`/`ephemeral`/`pipeline`,
 * ADR-101) и текст задания. Ключи `rightPanel.scheduler.*` сохранены —
 * расписание остаётся той же сущностью.
 */

/** Черновик расписания для deep-link'а (ADR-051/ADR-101). */
export interface ScheduleEditorDraft {
  name: string
  projectId: string
  pipelineId: string
  payload?: Record<string, unknown>
  cron?: string
}

export interface ScheduleEditorDialogProps {
  /** Открыт ли диалог. */
  open: boolean
  /** Расписание для правки; `null` — создание нового. */
  schedule: Schedule | null
  /**
   * Черновик deep-link'а (вкладка «Память» → «Подготовить пайплайн»).
   * Предзаполняет форму создания, но ничего не сохраняет.
   */
  draft?: ScheduleEditorDraft | null
  /** Закрыть диалог. */
  onClose: () => void
  /**
   * Сессия текущего контекста (PROP-141, этап 7b): при создании расписания
   * форма сразу нацелена на неё — не нужно выбирать сессию вручную.
   */
  defaultSessionId?: string | null
  /** Проект текущего контекста — предзаполняет цель `ephemeral`. */
  defaultProjectId?: string | null
  /** Вызывается после успешного сохранения (список перечитывается). */
  onSaved?: (schedule: Schedule) => void
}

/**
 * Модальный редактор расписания: создание и правка.
 */
export function ScheduleEditorDialog({
  open,
  schedule,
  draft,
  onClose,
  defaultSessionId,
  defaultProjectId,
  onSaved,
}: ScheduleEditorDialogProps) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const pipelinesByProject = usePipelinesStore((s) => s.pipelinesByProject)
  const loadingProjects = usePipelinesStore((s) => s.loadingProjects)
  const loadProjectPipelines = usePipelinesStore((s) => s.loadProjectPipelines)

  const [editor, setEditor] = useState<ScheduleEditorState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Черновик формы пересобирается при каждом открытии диалога.
  useEffect(() => {
    if (!open) return
    setFormError(null)
    setSaveError(null)
    // Deep-link из вкладки «Память»: предзаполненная форма создания.
    if (draft) {
      setEditor({
        ...EMPTY_SCHEDULE_EDITOR,
        name: draft.name,
        trigger: 'cron',
        cron: draft.cron ?? '0 3 * * *',
        mode: 'pipeline',
        pipelineProjectId: draft.projectId,
        pipelineId: draft.pipelineId,
        pipelinePayload: JSON.stringify(draft.payload ?? {}),
      })
      if (draft.projectId) void loadProjectPipelines(draft.projectId, { force: true })
      return
    }
    if (!schedule) {
      // Предзаполняем цель текущим контекстом: из сессии создаётся `bound`,
      // для `ephemeral` сразу подставлен проект.
      setEditor({
        ...EMPTY_SCHEDULE_EDITOR,
        ...(defaultSessionId ? { sessionId: defaultSessionId } : {}),
        ...(defaultProjectId ? { project: defaultProjectId } : {}),
      })
      return
    }
    setEditor(scheduleToEditor(schedule))
  }, [open, schedule, draft, defaultSessionId, defaultProjectId, loadProjectPipelines])

  /** ADR-101: опции селекта пайплайна — имя + пометка публикации. */
  const pipelineOptions = useMemo(() => {
    if (!editor || editor.mode !== 'pipeline') return []
    return (pipelinesByProject[editor.pipelineProjectId]?.pipelines ?? []).map((pipeline) => ({
      value: pipeline.id,
      label: pipeline.publishedVersion
        ? `${pipeline.name} · ${t('pipelines.publishedVersion', {
            version: String(pipeline.publishedVersion),
          })}`
        : `${pipeline.name} · ${t('pipelines.draftOnly')}`,
    }))
  }, [editor, pipelinesByProject, t])

  /** ADR-101: выбранный пайплайн (предупреждение «не опубликован»). */
  const selectedPipeline = useMemo(() => {
    if (!editor || editor.mode !== 'pipeline' || !editor.pipelineId) return undefined
    return (pipelinesByProject[editor.pipelineProjectId]?.pipelines ?? []).find(
      (pipeline) => pipeline.id === editor.pipelineId,
    )
  }, [editor, pipelinesByProject])

  /** ADR-101: идёт ли загрузка пайплайнов выбранного проекта. */
  const pipelinesLoading = Boolean(
    editor?.mode === 'pipeline' &&
      editor.pipelineProjectId &&
      loadingProjects.has(editor.pipelineProjectId),
  )

  const handleSave = async () => {
    if (!editor) return
    if (!editor.name.trim()) {
      setFormError(t('rightPanel.scheduler.form.nameRequired'))
      return
    }
    if (editor.mode !== 'ephemeral' && editor.mode !== 'pipeline' && !editor.sessionId) {
      setFormError(t('rightPanel.scheduler.form.sessionRequired'))
      return
    }
    // PROP-141: проект у ephemeral-цели обязателен (инстансных автоматизаций
    // нет) — тот же текст, что у pipeline-цели.
    if (editor.mode === 'ephemeral' && !editor.project.trim()) {
      setFormError(t('rightPanel.scheduler.form.projectRequired'))
      return
    }
    // ADR-101: цель `pipeline` — проект и пайплайн обязательны, payload —
    // валидный JSON-объект (пусто = «payload не задан»).
    if (editor.mode === 'pipeline') {
      if (!editor.pipelineProjectId.trim()) {
        setFormError(t('rightPanel.scheduler.form.projectRequired'))
        return
      }
      if (!editor.pipelineId.trim()) {
        setFormError(t('rightPanel.scheduler.form.pipelineRequired'))
        return
      }
      if (!parsePipelinePayload(editor.pipelinePayload).ok) {
        setFormError(t('rightPanel.scheduler.form.payloadInvalid'))
        return
      }
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
      const saved = editor.id
        ? await synthApi.updateSchedule(editor.id, input)
        : await synthApi.createSchedule(input)
      onSaved?.(saved)
      notify({ text: t('rightPanel.scheduler.saved'), type: 'success', category: 'system' })
      onClose()
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

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-md" data-testid="schedule-editor-dialog">
        <h2 className="text-sm font-medium text-foreground break-words">
          {editor?.id
            ? t('rightPanel.scheduler.form.edit')
            : t('rightPanel.scheduler.form.new')}
        </h2>

        {saveError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {saveError}
          </div>
        )}

        {editor && (
          <div className="space-y-3 min-w-0" data-testid="schedule-editor">
            <TextField
              label={t('rightPanel.scheduler.field.name')}
              tooltip={t('rightPanel.scheduler.field.nameTooltip')}
              value={editor.name}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              error={formError ?? undefined}
              id="schedule-name"
              data-testid="schedule-name"
            />

            <NativeSelect
              label={t('rightPanel.scheduler.field.trigger')}
              tooltip={t('rightPanel.scheduler.field.triggerTooltip')}
              value={editor.trigger}
              onChange={(value) =>
                setEditor((prev) => (prev ? { ...prev, trigger: value as TriggerKind } : prev))
              }
              testId="schedule-trigger"
            >
              <option value="cron">{t('rightPanel.scheduler.trigger.cron')}</option>
              <option value="every">{t('rightPanel.scheduler.trigger.every')}</option>
            </NativeSelect>

            {editor.trigger === 'cron' ? (
              <TextField
                label={t('rightPanel.scheduler.field.cron')}
                tooltip={t('rightPanel.scheduler.field.cronTooltip')}
                value={editor.cron}
                onChange={(e) => setEditor((prev) => (prev ? { ...prev, cron: e.target.value } : prev))}
                placeholder="*/5 * * * *"
                mono
                id="schedule-cron"
                data-testid="schedule-cron"
              />
            ) : (
              <NativeSelect
                label={t('rightPanel.scheduler.field.every')}
                tooltip={t('rightPanel.scheduler.field.everyTooltip')}
                value={editor.every}
                onChange={(value) => setEditor((prev) => (prev ? { ...prev, every: value } : prev))}
                testId="schedule-every"
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
              tooltip={t('rightPanel.scheduler.field.targetTooltip')}
              value={editor.mode}
              onChange={(value) =>
                setEditor((prev) => (prev ? { ...prev, mode: value as TargetMode } : prev))
              }
              testId="schedule-target"
            >
              <option value="bound">{t('rightPanel.scheduler.target.bound')}</option>
              <option value="ephemeral">{t('rightPanel.scheduler.target.ephemeral')}</option>
              <option value="queue">{t('rightPanel.scheduler.target.queue')}</option>
              {/* ADR-101: цель `pipeline` — прямой запуск прогона пайплайна. */}
              <option value="pipeline">{t('rightPanel.scheduler.target.pipeline')}</option>
            </NativeSelect>

            {editor.mode === 'pipeline' ? (
              <>
                <ProjectSelect
                  label={t('rightPanel.scheduler.field.project')}
                  tooltip={t('rightPanel.scheduler.field.pipelineProjectTooltip')}
                  value={editor.pipelineProjectId}
                  onChange={(value) => {
                    setEditor((prev) =>
                      prev ? { ...prev, pipelineProjectId: value, pipelineId: '' } : prev,
                    )
                    if (value) void loadProjectPipelines(value, { force: true })
                  }}
                  testId="schedule-pipeline-project"
                />

                <EntitySelect
                  label={t('rightPanel.scheduler.field.pipeline')}
                  tooltip={t('rightPanel.scheduler.field.pipelineTooltip')}
                  value={editor.pipelineId}
                  onChange={(value) =>
                    setEditor((prev) => (prev ? { ...prev, pipelineId: value } : prev))
                  }
                  items={pipelineOptions}
                  includeEmpty
                  emptyLabel={t('rightPanel.scheduler.selectPipeline')}
                  testId="schedule-pipeline"
                />

                {editor.pipelineProjectId && pipelinesLoading && (
                  <p className="text-xs text-muted-foreground" data-testid="schedule-pipeline-loading">
                    {t('rightPanel.scheduler.pipelineLoading')}
                  </p>
                )}

                {editor.pipelineProjectId && !pipelinesLoading && pipelineOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="schedule-pipeline-none">
                    {t('rightPanel.scheduler.pipelineNone')}
                  </p>
                )}

                {selectedPipeline && !selectedPipeline.publishedVersion && (
                  <div
                    className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-xs text-status-warning"
                    data-testid="schedule-pipeline-warning"
                  >
                    {t('rightPanel.scheduler.pipelineNotPublished')}
                  </div>
                )}

                <TextArea
                  label={t('rightPanel.scheduler.field.payload')}
                  tooltip={t('rightPanel.scheduler.field.payloadTooltip')}
                  description={t('rightPanel.scheduler.field.payloadHint')}
                  value={editor.pipelinePayload}
                  onChange={(e) =>
                    setEditor((prev) => (prev ? { ...prev, pipelinePayload: e.target.value } : prev))
                  }
                  rows={3}
                  mono
                  id="schedule-payload"
                  data-testid="schedule-payload"
                />
              </>
            ) : editor.mode !== 'ephemeral' ? (
              <SessionSelect
                label={t('rightPanel.scheduler.field.session')}
                tooltip={t('rightPanel.scheduler.field.sessionTooltip')}
                value={editor.sessionId}
                onChange={(value) =>
                  setEditor((prev) => (prev ? { ...prev, sessionId: value } : prev))
                }
                includeEmpty
                emptyLabel={t('rightPanel.scheduler.selectSession')}
                testId="schedule-session"
                allowCreate
              />
            ) : (
              <>
                <AgentSelect
                  label={t('rightPanel.scheduler.field.agent')}
                  tooltip={t('rightPanel.scheduler.field.agentTooltip')}
                  value={editor.agentTemplate}
                  onChange={(value) =>
                    setEditor((prev) => (prev ? { ...prev, agentTemplate: value } : prev))
                  }
                  includeEmpty
                  emptyLabel={t('rightPanel.scheduler.selectAgent')}
                  testId="schedule-agent"
                />

                <ProjectSelect
                  label={t('rightPanel.scheduler.field.project')}
                  tooltip={t('rightPanel.scheduler.field.projectTooltip')}
                  value={editor.project}
                  onChange={(value) =>
                    setEditor((prev) => (prev ? { ...prev, project: value } : prev))
                  }
                  includeEmpty
                  emptyLabel={t('rightPanel.scheduler.selectProject')}
                  testId="schedule-project"
                />

                <NativeSelect
                  label={t('rightPanel.scheduler.field.ttl')}
                  tooltip={t('rightPanel.scheduler.field.ttlTooltip')}
                  value={editor.ttl}
                  onChange={(value) => setEditor((prev) => (prev ? { ...prev, ttl: value } : prev))}
                  testId="schedule-ttl"
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
              tooltip={t('rightPanel.scheduler.field.promptTooltip')}
              value={editor.prompt}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, prompt: e.target.value } : prev))}
              rows={3}
              id="schedule-prompt"
              data-testid="schedule-prompt"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline-muted"
            onClick={onClose}
            disabled={saving}
            data-testid="schedule-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving}
            data-testid="schedule-save"
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Компактный нативный select в стиле панелей (триггер/TTL/цель). */
function NativeSelect({
  label,
  tooltip,
  value,
  onChange,
  children,
  testId,
}: {
  label: string
  tooltip?: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {tooltip && <FieldTooltip text={tooltip} />}
      </label>
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
