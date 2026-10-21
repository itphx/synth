import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'
import type {
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineSpec,
  ProjectPipelineDetail,
} from '@/lib/api/synthApi'
import { pipelineSpecSchema, validatePipelineSpec } from '@itphx/synth-shared/types'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { usePipelinesStore } from '@/stores/pipelinesStore'
import { canEditProjectContent } from '@/lib/projectAccess'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatRelativeTime } from '@/lib/formatDate'
import { PipelineSpecView } from './PipelineSpecView'
import { PipelineEditor } from './editor/PipelineEditor'

/** Статусы прогона — фильтр списка (ADR-101 §2.9). */
const RUN_STATUSES: PipelineRunStatus[] = [
  'pending',
  'running',
  'awaiting_human',
  'done',
  'failed',
  'cancelled',
]

/** Режим правки черновика: канвас или JSON (ADR-101, Э7.2). */
type DraftViewMode = 'visual' | 'json'

/** Итог проверки спецификации (структура + семантика графа). */
interface DraftValidation {
  ok: boolean
  problems: string[]
}

/**
 * Проверка черновика: сначала структура (`pipelineSpecSchema`), затем
 * семантика графа (`validatePipelineSpec` — ссылки переходов, поля по виду
 * узла, выходы). Невалидная спецификация на сервер не уходит.
 */
function validateDraftSpec(spec: PipelineSpec | null): DraftValidation {
  if (!spec) return { ok: false, problems: ['spec: нет спецификации'] }
  const parsed = pipelineSpecSchema.safeParse(spec)
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`,
      ),
    }
  }
  const result = validatePipelineSpec(spec)
  return result.ok ? { ok: true, problems: [] } : { ok: false, problems: result.problems }
}

/**
 * Страница пайплайна проекта (ADR-101, Э7).
 *
 * Показывает имя/описание, провенанс (`installedBy`), черновик и опубликованную
 * версию, даёт действия «Сохранить черновик» / «Опубликовать» / «Запустить прогон» /
 * «Удалить» и список прогонов с фильтром по статусу.
 *
 * Черновик правится **визуально** (канвас `@xyflow/react`, Э7.2) или в JSON-режиме
 * (альтернативный способ правки — для отладки и точных правок). Опубликованная
 * версия — всегда read-only (`PipelineSpecView`).
 */
export function PipelineTab({ tab }: { tab: CenterTab }) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const projectId = tab.data.projectId ?? ''
  const pipelineId = tab.data.pipelineId ?? ''

  const projects = useProjectsStore((s) => s.projects)
  const user = useAuthStore((s) => s.user)
  const openTab = useUIStore((s) => s.openTab)
  const closeTab = useUIStore((s) => s.closeTab)
  const loadProjectPipelines = usePipelinesStore((s) => s.loadProjectPipelines)
  const runsByPipeline = usePipelinesStore((s) => s.runsByPipeline)
  const loadPipelineRuns = usePipelinesStore((s) => s.loadPipelineRuns)

  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  )
  const canEdit = canEditProjectContent(project, user)

  const [detail, setDetail] = useState<ProjectPipelineDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewMode, setViewMode] = useState<DraftViewMode>('visual')
  const [draftSpec, setDraftSpec] = useState<PipelineSpec | null>(null)
  const [draftJson, setDraftJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [validation, setValidation] = useState<DraftValidation | null>(null)
  const [statusFilter, setStatusFilter] = useState<PipelineRunStatus | ''>('')

  const reload = useCallback(async () => {
    if (!projectId || !pipelineId) return
    setLoading(true)
    try {
      const result = await synthApi.getProjectPipeline(projectId, pipelineId)
      setDetail(result)
      setDraftSpec(result.pipeline.draft ?? null)
      setDraftJson(result.pipeline.draft ? JSON.stringify(result.pipeline.draft, null, 2) : '')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId, pipelineId])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    if (!projectId || !pipelineId) return
    void loadPipelineRuns(projectId, pipelineId, statusFilter ? { status: statusFilter } : undefined)
  }, [projectId, pipelineId, statusFilter, loadPipelineRuns, reload])

  const runs = runsByPipeline[pipelineId] ?? []

  /** Спецификация черновика для сохранения (JSON-режим — из текста). */
  const currentDraftSpec = (): { spec?: PipelineSpec; error?: string } => {
    if (viewMode === 'json') {
      try {
        return { spec: JSON.parse(draftJson) as PipelineSpec }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
    return { spec: draftSpec ?? undefined }
  }

  /** Проверка графа: структура + семантика (`validatePipelineSpec`). */
  const runValidation = (): DraftValidation => {
    const { spec, error } = currentDraftSpec()
    if (error) return { ok: false, problems: [error] }
    return validateDraftSpec(spec ?? null)
  }

  const saveDraft = async () => {
    if (!detail) return
    const { spec, error } = currentDraftSpec()
    if (error || !spec) {
      setJsonError(error ?? null)
      notify({ text: t('pipelines.invalidJson'), type: 'error', category: 'error' })
      return
    }
    // Невалидная спецификация на сервер не уходит (сервер вернул бы 400).
    const check = validateDraftSpec(spec)
    setValidation(check)
    if (!check.ok) {
      notify({ text: t('pipelines.saveBlocked'), type: 'error', category: 'error' })
      return
    }
    setJsonError(null)
    setBusy(true)
    try {
      await synthApi.updateProjectPipeline(projectId, pipelineId, {
        name: detail.pipeline.name,
        ...(detail.pipeline.description ? { description: detail.pipeline.description } : {}),
        spec,
      })
      await reload()
      await loadProjectPipelines(projectId, { force: true })
      notify({ text: t('pipelines.draftSaved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setBusy(false)
    }
  }

  /** Кнопка «Проверить» — только проверка, без отправки на сервер. */
  const validateDraft = () => {
    const check = runValidation()
    setValidation(check)
    notify({
      text: check.ok ? t('pipelines.validateOk') : t('pipelines.validateFailed'),
      type: check.ok ? 'success' : 'error',
      category: check.ok ? 'system' : 'error',
    })
  }

  /** Переключение режима правки: JSON ↔ канвас (спецификация синхронизируется). */
  const switchViewMode = (mode: DraftViewMode) => {
    if (mode === viewMode) return
    if (mode === 'json') {
      setDraftJson(draftSpec ? JSON.stringify(draftSpec, null, 2) : '')
    } else {
      try {
        const parsed = JSON.parse(draftJson) as PipelineSpec
        setDraftSpec(parsed)
        setJsonError(null)
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : String(err))
        notify({ text: t('pipelines.invalidJson'), type: 'error', category: 'error' })
        return
      }
    }
    setViewMode(mode)
  }

  const publish = async () => {
    setBusy(true)
    try {
      await synthApi.publishProjectPipeline(projectId, pipelineId)
      await reload()
      await loadProjectPipelines(projectId, { force: true })
      notify({ text: t('pipelines.publishDone'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const startRun = async () => {
    setBusy(true)
    try {
      const run = await synthApi.startPipelineRun(projectId, pipelineId, {
        trigger: { kind: 'manual' },
      })
      openTab({
        id: `pipeline-run-${run.id}`,
        type: 'pipeline-run',
        title: t('pipelines.runTitle', { name: detail?.pipeline.name ?? '' }),
        data: { projectId, pipelineId, runId: run.id },
      })
      notify({ text: t('pipelines.runStarted'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify({ text: message, type: 'error', category: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: t('pipelines.delete'),
      message: t('pipelines.confirmDelete'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await synthApi.deleteProjectPipeline(projectId, pipelineId)
      await loadProjectPipelines(projectId, { force: true })
      closeTab(tab.id)
      notify({ text: t('pipelines.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify({ text: message, type: 'error', category: 'error' })
    }
  }

  const openRun = (run: PipelineRunRecord) => {
    openTab({
      id: `pipeline-run-${run.id}`,
      type: 'pipeline-run',
      title: t('pipelines.runTitle', { name: detail?.pipeline.name ?? '' }),
      data: { projectId, pipelineId, runId: run.id },
    })
  }

  if (loading && !detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Icon name="loader-2" className="mr-2 h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <Icon name="alert-triangle" className="h-6 w-6" />
        <p>{error ?? t('pipelines.notFound')}</p>
        <button onClick={() => void reload()} className="rounded bg-interactive px-2 py-1 text-xs text-foreground hover:bg-interactive-hover">
          {t('common.refresh')}
        </button>
      </div>
    )
  }

  const pipeline = detail.pipeline
  const published = detail.published

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="links-line" className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold text-foreground">{pipeline.name}</h1>
          {pipeline.installedBy && (
            <span className="rounded bg-interactive px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
              {t('pipelines.installedBy', { pack: pipeline.installedBy.pack })}
            </span>
          )}
          <span className="rounded bg-interactive px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
            {t('pipelines.draftVersion', { version: String(pipeline.draftVersion) })}
          </span>
          {pipeline.publishedVersion !== undefined && (
            <span className="rounded bg-status-success/15 px-1.5 py-0.5 text-[0.65rem] text-status-success">
              {t('pipelines.publishedVersion', { version: String(pipeline.publishedVersion) })}
            </span>
          )}
        </div>
        {pipeline.description && (
          <p className="text-xs text-muted-foreground">{pipeline.description}</p>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void saveDraft()}
              disabled={busy}
              data-action="save-draft"
              className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors disabled:opacity-50"
            >
              {t('pipelines.saveDraft')}
            </button>
            <button
              onClick={validateDraft}
              disabled={busy}
              data-action="validate"
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
            >
              {t('pipelines.validate')}
            </button>
            <button
              onClick={() => void publish()}
              disabled={busy}
              data-action="publish"
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
            >
              {t('pipelines.publish')}
            </button>
            <button
              onClick={() => void startRun()}
              disabled={busy}
              data-action="start-run"
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
            >
              {t('pipelines.startRun')}
            </button>
            <button
              onClick={() => void remove()}
              disabled={busy}
              data-action="delete"
              className="rounded border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              {t('pipelines.delete')}
            </button>
          </div>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('pipelines.draft')}
            </h2>
            {canEdit && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => switchViewMode('visual')}
                  data-action="view-visual"
                  className={`rounded px-2 py-0.5 text-[0.65rem] ${viewMode === 'visual' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-interactive-hover'}`}
                >
                  {t('pipelines.editor.viewVisual')}
                </button>
                <button
                  onClick={() => switchViewMode('json')}
                  data-action="view-json"
                  className={`rounded px-2 py-0.5 text-[0.65rem] ${viewMode === 'json' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-interactive-hover'}`}
                >
                  {t('pipelines.viewJson')}
                </button>
              </div>
            )}
          </div>

          {!pipeline.draft ? (
            <p className="text-xs text-muted-foreground">{t('pipelines.noDraft')}</p>
          ) : viewMode === 'json' && canEdit ? (
            <div className="flex flex-col gap-1">
              <textarea
                value={draftJson}
                onChange={(e) => setDraftJson(e.target.value)}
                spellCheck={false}
                className="min-h-[16rem] w-full resize-y rounded border border-border bg-card p-2 font-mono text-xs text-foreground outline-none"
              />
              {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            </div>
          ) : (
            <PipelineEditor
              key={`${projectId}:${pipelineId}:${pipeline.draftVersion}`}
              spec={draftSpec ?? pipeline.draft}
              resetKey={`${pipeline.draftVersion}:${pipeline.updatedAt}`}
              onChange={setDraftSpec}
              readOnly={!canEdit}
            />
          )}

          {validation && (
            <div
              data-testid="pipeline-validation"
              className={`rounded-lg border px-2 py-1.5 ${
                validation.ok
                  ? 'border-status-success/30 bg-status-success/10'
                  : 'border-destructive/30 bg-destructive/10'
              }`}
            >
              <p
                className={`text-xs font-medium ${
                  validation.ok ? 'text-status-success' : 'text-destructive'
                }`}
              >
                {validation.ok ? t('pipelines.validateOk') : t('pipelines.problems')}
              </p>
              {!validation.ok && (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {validation.problems.map((problem, index) => (
                    <li key={index} className="text-[0.65rem] text-destructive">
                      {problem}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('pipelines.published')}
          </h2>
          {published ? (
            <PipelineSpecView spec={published.spec} />
          ) : (
            <p className="text-xs text-muted-foreground">{t('pipelines.notPublished')}</p>
          )}
          {detail.versions.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {detail.versions.map((version) => (
                <li key={version.version} className="text-xs text-muted-foreground">
                  {t('pipelines.version')} {version.version} · {formatRelativeTime(version.publishedAt)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('pipelines.runs')}
            </h2>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as PipelineRunStatus | '')}
              className="rounded bg-interactive px-2 py-1 text-xs text-foreground outline-none"
            >
              <option value="">{t('pipelines.allStatuses')}</option>
              {RUN_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('pipelines.noRuns')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    onClick={() => openRun(run)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-interactive-hover"
                  >
                    <span className="rounded bg-interactive px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                      {run.status}
                    </span>
                    <span className="text-muted-foreground">
                      {t('pipelines.version')} {run.version}
                    </span>
                    {run.currentNode && (
                      <span className="text-muted-foreground">· {run.currentNode}</span>
                    )}
                    <span className="ml-auto text-muted-foreground">
                      {run.startedAt ? formatRelativeTime(run.startedAt) : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
