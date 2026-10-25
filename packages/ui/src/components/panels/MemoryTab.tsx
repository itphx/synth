import React, { useCallback, useEffect, useState } from 'react'
import {
  synthApi,
  type MemoryIndexScope,
  type PipelineRunRecord,
  type PipelineTemplate,
  type ProjectPipeline,
  type SessionMemoryBlock,
  type SessionMemoryIndexItem,
  type SessionMemoryIndexState,
  type SessionMemoryResponse,
} from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { PanelTab } from './PanelTab'

/**
 * ADR-107 / PROP-047: вкладка «Память» правой панели — срез памяти по
 * активной сессии: что провайдер памяти отдал в контекст последнего хода
 * (факты и recall), каков скоуп (проект/инстанс), что доступно по индексам
 * и как ими управлять.
 *
 * Данные — `GET /api/v2/sessions/:id/memory` (права — чтение сессии). Плагин
 * памяти может быть не активен: сервер отдаёт `readiness: 'unavailable'` и
 * `provider.active: false` — вкладка объясняет это текстом, а не ошибкой.
 *
 * Управление: память проекта (тумблер, право — изменение содержимого проекта)
 * и индексы (ADMIN — создание и пересборка, переключение проектного индекса;
 * общие индексы инстанса не отключаются). Подробный портал памяти — в
 * настройках (админ-раздел «Память»); здесь только действия по месту.
 */

/** Общий стиль бейджа (как в админ-разделе «Память»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа готовности памяти. */
const READINESS_CLASS: Record<string, string> = {
  ready: 'bg-status-success/15 text-status-success',
  degraded: 'bg-status-warning/15 text-status-warning',
  unavailable: 'bg-destructive/15 text-destructive',
}

/** Цвет бейджа статуса блока памяти. */
const BLOCK_STATUS_CLASS: Record<string, string> = {
  loaded: 'bg-status-success/15 text-status-success',
  truncated: 'bg-status-warning/15 text-status-warning',
  empty: 'bg-muted text-muted-foreground',
  blocked: 'bg-destructive/15 text-destructive',
  suppressed: 'bg-muted text-muted-foreground',
}

/** Цвет бейджа состояния индекса. */
const INDEX_STATE_CLASS: Record<SessionMemoryIndexState, string> = {
  building: 'bg-primary/15 text-primary',
  ready: 'bg-status-success/15 text-status-success',
  stale: 'bg-status-warning/15 text-status-warning',
  failed: 'bg-destructive/15 text-destructive',
}

/** Области видимости индекса, доступные в форме создания. */
const INDEX_SCOPES: MemoryIndexScope[] = ['project', 'instance']

/** Виды источника корпуса, доступные в форме создания. */
const INDEX_SOURCE_KINDS: Array<'files' | 'facts'> = ['files', 'facts']

/** Действие секции «Автоматизация» памяти (ADR-101: встроенные шаблоны). */
interface MemoryAutomationAction {
  key: 'extract' | 'dedupe' | 'reindex'
  /** id встроенного шаблона инстанса. */
  templateId: string
  /** Можно ли повесить действие на расписание (у извлечения вход — сессия). */
  schedulable: boolean
  /** i18n-ключ названия/подписи/имени расписания. */
  titleKey: string
  hintKey: string
  scheduleNameKey?: string
  /** Payload разового прогона — `{sessionId}` текущей сессии. */
  withSession?: boolean
}

/**
 * Три действия над памятью: извлечение фактов из текущей сессии (только
 * разово — входом служит `sessionId`), слияние дублей и переиндексация проекта
 * (можно и разово, и по расписанию).
 */
const MEMORY_AUTOMATION_ACTIONS: MemoryAutomationAction[] = [
  {
    key: 'extract',
    templateId: 'builtin:memory-consolidation',
    schedulable: false,
    titleKey: 'rightPanel.memory.automation.extract.title',
    hintKey: 'rightPanel.memory.automation.extract.hint',
    withSession: true,
  },
  {
    key: 'dedupe',
    templateId: 'builtin:memory-consolidate-facts',
    schedulable: true,
    titleKey: 'rightPanel.memory.automation.dedupe.title',
    hintKey: 'rightPanel.memory.automation.dedupe.hint',
    scheduleNameKey: 'rightPanel.memory.automation.dedupe.scheduleName',
  },
  {
    key: 'reindex',
    templateId: 'builtin:memory-reindex',
    schedulable: true,
    titleKey: 'rightPanel.memory.automation.reindex.title',
    hintKey: 'rightPanel.memory.automation.reindex.hint',
    scheduleNameKey: 'rightPanel.memory.automation.reindex.scheduleName',
  },
]

/** Цвет бейджа статуса прогона пайплайна (как в админ-разделе «Аддоны»). */
const RUN_STATUS_CLASS: Record<PipelineRunRecord['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-primary/15 text-primary',
  awaiting_human: 'bg-status-warning/15 text-status-warning',
  done: 'bg-status-success/15 text-status-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
}

/** Осмысленное имя индекса по умолчанию для области/источника. */
function defaultIndexName(scope: MemoryIndexScope, projectId: string | undefined): string {
  if (scope === 'instance') return 'instance-facts'
  return projectId ? 'project-memory' : 'project-facts'
}

/** Статус HTTP-ошибки (503 — порты памяти не подключены). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Машиночитаемый код ошибки сервера (ADR-075). */
const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : undefined
}

/** Строка «подпись — значение» (как `StatCell` в «Статистике»). */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('ml-auto truncate text-right tabular-nums text-foreground', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  )
}

/** Карточка-секция правой панели (как `Section` в «Статистике»). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/**
 * Блок памяти в контексте хода: статус, размер и пояснение.
 *
 * Блока нет — «не передавался» (для recall — «в ходе не было вопроса»).
 */
function BlockRow({
  icon,
  label,
  id,
  block,
  missingHint,
  format,
}: {
  icon: string
  label: string
  /** Стабильный идентификатор блока (для data-testid). */
  id: 'facts' | 'recall'
  block: SessionMemoryBlock | undefined
  /** Пояснение для случая «блока нет». */
  missingHint: string
  format: (value: number) => string
}) {
  const { t } = useI18n()
  if (!block) {
    return (
      <div className="space-y-0.5" data-testid={`memory-block-${id}`}>
        <div className="flex items-center gap-1.5 text-xs">
          <Icon name={icon} className="size-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{label}</span>
          <span className="ml-auto text-muted-foreground/80">
            {t('rightPanel.memory.block.notPassed')}
          </span>
        </div>
        <div className="text-[0.6875rem] text-muted-foreground/80">{missingHint}</div>
      </div>
    )
  }
  return (
    <div className="space-y-0.5" data-testid={`memory-block-${id}`}>
      <div className="flex items-center gap-1.5 text-xs">
        <Icon name={icon} className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{label}</span>
        <span
          data-testid={`memory-block-status-${id}`}
          className={cn(BADGE, BLOCK_STATUS_CLASS[block.status] ?? 'bg-muted text-muted-foreground')}
        >
          {t(`rightPanel.memory.blockStatus.${block.status}`)}
        </span>
        <span className="ml-auto tabular-nums text-foreground">
          {format(block.chars)} · ≈{format(block.estTokens)}
        </span>
      </div>
      <div className="text-[0.6875rem] text-muted-foreground/80">
        {t(`rightPanel.memory.block.${block.status}`)}
      </div>
    </div>
  )
}

/** Инпут/селект компактной формы правой панели. */
const FIELD_CLASS =
  'w-full rounded-md bg-input border border-border px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

export const MemoryTab: React.FC = () => {
  const { t, locale } = useI18n()
  const fmt = (value: number): string => value.toLocaleString(locale)

  const [data, setData] = useState<SessionMemoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Мутации: тумблер памяти проекта и операции с индексами.
  const [projectMemorySaving, setProjectMemorySaving] = useState(false)
  const [projectMemoryError, setProjectMemoryError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [indexError, setIndexError] = useState<string | null>(null)

  // Инлайн-форма создания индекса.
  const [formOpen, setFormOpen] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [sourceKind, setSourceKind] = useState<'files' | 'facts'>('files')
  const [scope, setScope] = useState<MemoryIndexScope>('project')
  const [formError, setFormError] = useState<string | null>(null)

  // Автоматизация (ADR-101): шаблоны инстанса и пайплайны проекта.
  const [templates, setTemplates] = useState<PipelineTemplate[] | null>(null)
  const [pipelines, setPipelines] = useState<ProjectPipeline[] | null>(null)
  const [lastRuns, setLastRuns] = useState<Record<string, PipelineRunRecord | null>>({})
  const [automationLoading, setAutomationLoading] = useState(false)
  const [automationError, setAutomationError] = useState<string | null>(null)
  const [automationBusy, setAutomationBusy] = useState<string | null>(null)
  const [automationActionErrors, setAutomationActionErrors] = useState<
    Record<string, string | undefined>
  >({})
  // Старый сервер не отдаёт `installedBy.templateId` — запоминаем связь,
  // созданную в этой сессии, чтобы строка нашла свой пайплайн.
  const [boundPipelines, setBoundPipelines] = useState<Record<string, string>>({})

  // Активная сессия — как в «Статистике» (активный center-tab).
  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId

  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.roles?.some((role) => role === 'ADMIN')

  const setRightPanelTab = useUIStore((s) => s.setRightPanelTab)
  const setScheduleDraft = useUIStore((s) => s.setScheduleDraft)

  /** Проект сессии: секция «Автоматизация» живёт только при нём. */
  const automationProjectId = data?.scope?.projectId
  const automationEnabled = isAdmin && !!automationProjectId

  /** Пайплайн проекта, созданный из встроенного шаблона. */
  const findPipeline = useCallback(
    (templateId: string): ProjectPipeline | undefined => {
      const list = pipelines ?? []
      return (
        list.find((pipeline) => pipeline.installedBy?.templateId === templateId) ??
        (boundPipelines[templateId]
          ? list.find((pipeline) => pipeline.id === boundPipelines[templateId])
          : undefined)
      )
    },
    [boundPipelines, pipelines],
  )

  const loadAutomation = useCallback(async () => {
    const projectId = automationProjectId
    if (!projectId) return
    setAutomationLoading(true)
    setAutomationError(null)
    try {
      const [templateList, pipelineList] = await Promise.all([
        synthApi.getPipelineTemplates(),
        synthApi.getProjectPipelines(projectId),
      ])
      setTemplates(templateList)
      setPipelines(pipelineList)

      // Последний прогон — по каждому найденному пайплайну. Ошибка прогона
      // не ломает секцию: строка остаётся «ещё не запускался».
      const entries = await Promise.all(
        MEMORY_AUTOMATION_ACTIONS.map(async (action) => {
          const pipeline = pipelineList.find(
            (candidate) => candidate.installedBy?.templateId === action.templateId,
          )
          if (!pipeline) return [action.templateId, null] as const
          try {
            const runs = await synthApi.listPipelineRuns(projectId, pipeline.id, { limit: 1 })
            return [action.templateId, runs[0] ?? null] as const
          } catch {
            return [action.templateId, null] as const
          }
        }),
      )
      setLastRuns(Object.fromEntries(entries))
    } catch (err) {
      setAutomationError(
        t('rightPanel.memory.automation.loadError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
    } finally {
      setAutomationLoading(false)
    }
  }, [automationProjectId, t])

  useEffect(() => {
    if (!automationEnabled) return
    void loadAutomation()
  }, [automationEnabled, loadAutomation])

  const load = useCallback(async () => {
    if (!sessionId) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await synthApi.getSessionMemory(sessionId))
    } catch (err) {
      setData(null)
      setError(
        statusOf(err) === 503
          ? t('rightPanel.memory.unavailable')
          : t('rightPanel.memory.error', {
              error: err instanceof Error ? err.message : t('common.error'),
            }),
      )
    } finally {
      setLoading(false)
    }
  }, [sessionId, t])

  useEffect(() => {
    void load()
  }, [load])

  /** Текст ошибки мутации: 403 и 409 `MEMORY_INDEX_NOT_TOGGLEABLE` — понятнее общего. */
  const mutationMessage = (err: unknown): string => {
    if (codeOf(err) === 'MEMORY_INDEX_NOT_TOGGLEABLE') {
      return t('rightPanel.memory.control.notToggleable')
    }
    if (statusOf(err) === 403) return t('rightPanel.memory.control.forbidden')
    return t('rightPanel.memory.control.mutationError', {
      error: err instanceof Error ? err.message : t('common.error'),
    })
  }

  if (!sessionId) {
    return (
      <PanelTab>
        <div className="py-2 text-center text-sm text-muted-foreground">
          {t('rightPanel.memory.noSession')}
        </div>
      </PanelTab>
    )
  }

  const lastContext = data?.lastContext ?? null
  // Нормализация: сервер может отдать неполный срез —
  // показываем нули вместо падения вкладки.
  const readiness = data?.readiness ?? 'unavailable'
  const providerActive = data?.provider?.active === true
  const factsActive = data?.facts?.active ?? 0
  const indexes = data?.indexes ?? {
    total: 0,
    project: 0,
    instance: 0,
    ready: 0,
    building: 0,
    failed: 0,
    items: [],
  }
  const indexItems = indexes.items ?? []
  const projectId = data?.scope?.projectId
  // Старый сервер может не прислать `projectMemory`: сессия с проектом —
  // память проекта включена (эффективное значение по умолчанию), без проекта — `null`.
  const projectMemory =
    data && data.projectMemory !== undefined
      ? data.projectMemory
      : projectId
        ? { enabled: true }
        : null

  const projectRequired = scope === 'project' || sourceKind === 'files'
  const canCreate = !!projectId || (scope === 'instance' && sourceKind === 'facts')

  const openCreateForm = (): void => {
    const nextScope: MemoryIndexScope = projectId ? 'project' : 'instance'
    const nextSource: 'files' | 'facts' = projectId ? 'files' : 'facts'
    setScope(nextScope)
    setSourceKind(nextSource)
    setNameInput(defaultIndexName(nextScope, projectId))
    setFormError(null)
    setFormOpen(true)
  }

  const closeCreateForm = (): void => {
    setFormOpen(false)
    setFormError(null)
  }

  /** Тумблер памяти проекта: PUT /projects/:id с `memory.enabled`, затем reload. */
  const handleToggleProjectMemory = async (): Promise<void> => {
    if (!projectId || !projectMemory || projectMemorySaving) return
    setProjectMemorySaving(true)
    setProjectMemoryError(null)
    try {
      await synthApi.updateProject(projectId, { memory: { enabled: !projectMemory.enabled } })
      await load()
    } catch (err) {
      setProjectMemoryError(mutationMessage(err))
    } finally {
      setProjectMemorySaving(false)
    }
  }

  /** Создание индекса: project+files → с проектом, instance+facts → без проекта. */
  const handleCreateIndex = async (): Promise<void> => {
    if (busy) return
    if (!canCreate) {
      setFormError(t('rightPanel.memory.control.projectRequired'))
      return
    }
    const name = nameInput.trim() || defaultIndexName(scope, projectId)
    setBusy('create')
    setFormError(null)
    setIndexError(null)
    try {
      await synthApi.createMemoryIndex({
        name,
        source: { kind: sourceKind },
        ...(scope === 'instance' ? { scope } : {}),
        ...(projectRequired && projectId ? { projectId } : {}),
      })
      await load()
      closeCreateForm()
    } catch (err) {
      setFormError(mutationMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** Переключатель проектного индекса («включён» в recall). */
  const handleToggleIndex = async (index: SessionMemoryIndexItem): Promise<void> => {
    if (busy || index.scope === 'instance') return
    setBusy(index.id)
    setIndexError(null)
    try {
      await synthApi.setMemoryIndexEnabled(index.id, !index.enabled)
      await load()
    } catch (err) {
      setIndexError(mutationMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** Пересборка индекса (сборка идёт в фоне, затем reload). */
  const handleRebuildIndex = async (index: SessionMemoryIndexItem): Promise<void> => {
    if (busy) return
    setBusy(index.id)
    setIndexError(null)
    try {
      await synthApi.rebuildMemoryIndex(index.id)
      await load()
    } catch (err) {
      setIndexError(mutationMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** Понятная ошибка действия автоматизации (inline, без падения секции). */
  const automationMessage = (err: unknown, key: string): string =>
    t(key, { error: err instanceof Error ? err.message : t('common.error') })

  const setActionError = (key: string, message: string | undefined): void => {
    setAutomationActionErrors((prev) => ({ ...prev, [key]: message }))
  }

  /** «Подготовить пайплайн»: инстанцировать (ensure) и опубликовать при необходимости. */
  const handlePrepare = async (action: MemoryAutomationAction): Promise<void> => {
    const projectId = automationProjectId
    if (!projectId || automationBusy) return
    setAutomationBusy(action.key)
    setActionError(action.key, undefined)
    try {
      let pipeline = findPipeline(action.templateId)
      if (!pipeline) {
        pipeline = await synthApi.instantiatePipelineTemplate(action.templateId, {
          projectId,
          ensure: true,
        })
        setBoundPipelines((prev) => ({ ...prev, [action.templateId]: pipeline!.id }))
      }
      if (!pipeline.publishedVersion) {
        await synthApi.publishProjectPipeline(projectId, pipeline.id)
      }
      // Последний прогон — сразу по подготовленному пайплайну.
      const runs = await synthApi
        .listPipelineRuns(projectId, pipeline.id, { limit: 1 })
        .catch(() => [] as PipelineRunRecord[])
      setLastRuns((prev) => ({ ...prev, [action.templateId]: runs[0] ?? null }))
      await loadAutomation()
    } catch (err) {
      setActionError(
        action.key,
        automationMessage(err, 'rightPanel.memory.automation.prepareError'),
      )
    } finally {
      setAutomationBusy(null)
    }
  }

  /** «Запустить сейчас»: ручной прогон опубликованного пайплайна. */
  const handleRun = async (action: MemoryAutomationAction): Promise<void> => {
    const projectId = automationProjectId
    const pipeline = findPipeline(action.templateId)
    if (!projectId || !pipeline?.publishedVersion || automationBusy) return
    setAutomationBusy(action.key)
    setActionError(action.key, undefined)
    try {
      const payload =
        action.withSession && sessionId ? { sessionId } : undefined
      await synthApi.startPipelineRun(projectId, pipeline.id, {
        trigger: { kind: 'manual', ...(payload ? { payload } : {}) },
      })
      const runs = await synthApi
        .listPipelineRuns(projectId, pipeline.id, { limit: 1 })
        .catch(() => [] as PipelineRunRecord[])
      setLastRuns((prev) => ({ ...prev, [action.templateId]: runs[0] ?? null }))
    } catch (err) {
      setActionError(action.key, automationMessage(err, 'rightPanel.memory.automation.runError'))
    } finally {
      setAutomationBusy(null)
    }
  }

  /** «Расписание»: deep-link в «Шедулер» с предзаполненной формой (не создаёт). */
  const handleSchedule = (action: MemoryAutomationAction): void => {
    const projectId = automationProjectId
    const pipeline = findPipeline(action.templateId)
    if (!projectId || !pipeline?.publishedVersion || !action.schedulable) return
    setScheduleDraft({
      name: t(action.scheduleNameKey ?? action.titleKey),
      projectId,
      pipelineId: pipeline.id,
      ...(action.withSession && sessionId ? { payload: { sessionId } } : {}),
      cron: '0 3 * * *',
    })
    setRightPanelTab('scheduler')
  }

  return (
    <PanelTab>
      {error && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="memory-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{error}</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void load()}
            data-testid="memory-retry"
          >
            <Icon name="refresh" className="size-3.5" />
            {t('rightPanel.memory.retry')}
          </Button>
        </div>
      )}

      {loading && !data && (
        <div
          role="status"
          aria-live="polite"
          data-testid="memory-loading"
          className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
        >
          <Icon name="refresh" className="size-3.5 animate-spin" />
          {t('rightPanel.memory.loading')}
        </div>
      )}

      {data && (
        <>
          {/* 1. Статус: готовность, провайдер, проект. */}
          <Section title={t('rightPanel.memory.status')}>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="memory-badges">
              <span
                data-testid="memory-readiness-badge"
                className={cn(BADGE, READINESS_CLASS[readiness] ?? 'bg-muted text-muted-foreground')}
              >
                {t(`rightPanel.memory.readiness.${readiness}`)}
              </span>
              <span
                data-testid="memory-provider-badge"
                className={cn(
                  BADGE,
                  providerActive
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {providerActive
                  ? t('rightPanel.memory.provider.active')
                  : t('rightPanel.memory.provider.inactive')}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs">
              <Row
                label={t('rightPanel.memory.project')}
                value={data.scope?.projectId ?? t('rightPanel.memory.noProject')}
                mono
              />
            </div>
          </Section>

          {/* 2. Управление: память проекта и индексы (индексы — ADMIN). */}
          <Section title={t('rightPanel.memory.control')}>
            {projectMemory === null ? (
              <p
                data-testid="memory-project-memory-hint"
                className="text-xs text-muted-foreground break-words"
              >
                {t('rightPanel.memory.control.noProject')}
              </p>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-foreground break-words">
                    {t('rightPanel.memory.control.projectMemory')}
                  </div>
                  <div className="text-[0.6875rem] text-muted-foreground break-words">
                    {t('rightPanel.memory.control.projectMemoryHint')}
                  </div>
                </div>
                <div className="shrink-0" data-testid="memory-project-memory-toggle">
                  <Toggle
                    enabled={projectMemory.enabled}
                    onToggle={() => void handleToggleProjectMemory()}
                    ariaLabel={t('rightPanel.memory.control.projectMemory')}
                    pending={projectMemorySaving}
                    disabled={projectMemorySaving}
                  />
                </div>
              </div>
            )}

            {projectMemoryError && (
              <div
                role="alert"
                aria-live="polite"
                data-testid="memory-project-memory-error"
                className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive break-words"
              >
                {projectMemoryError}
              </div>
            )}

            {isAdmin && (
              <div className="space-y-2 border-t border-border/60 pt-2">
                {!formOpen && (
                  <div className="space-y-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={openCreateForm}
                      data-testid="memory-create-index"
                    >
                      <Icon name="add" className="size-3.5" />
                      {t('rightPanel.memory.control.createIndex')}
                    </Button>
                    {!projectId && (
                      <p className="text-[0.6875rem] text-muted-foreground break-words">
                        {t('rightPanel.memory.control.noProjectHint')}
                      </p>
                    )}
                  </div>
                )}

                {formOpen && (
                  <div
                    className="space-y-2 rounded-md border border-border/60 bg-surface-inset p-2 min-w-0"
                    data-testid="memory-create-index-form"
                  >
                    <label className="block space-y-1 text-xs">
                      <span className="text-muted-foreground">
                        {t('rightPanel.memory.control.name')}
                      </span>
                      <input
                        type="text"
                        value={nameInput}
                        placeholder={t('rightPanel.memory.control.namePlaceholder')}
                        onChange={(event) => setNameInput(event.target.value)}
                        aria-label={t('rightPanel.memory.control.name')}
                        className={FIELD_CLASS}
                        data-testid="memory-create-name"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-2 min-w-0">
                      <label className="block space-y-1 text-xs">
                        <span className="text-muted-foreground">
                          {t('rightPanel.memory.control.source')}
                        </span>
                        <select
                          value={sourceKind}
                          onChange={(event) =>
                            setSourceKind(event.target.value as 'files' | 'facts')
                          }
                          aria-label={t('rightPanel.memory.control.source')}
                          className={FIELD_CLASS}
                          data-testid="memory-create-source"
                        >
                          {INDEX_SOURCE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {t(`rightPanel.memory.control.source.${kind}`)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block space-y-1 text-xs">
                        <span className="text-muted-foreground">
                          {t('rightPanel.memory.control.scope')}
                        </span>
                        <select
                          value={scope}
                          onChange={(event) =>
                            setScope(event.target.value as MemoryIndexScope)
                          }
                          aria-label={t('rightPanel.memory.control.scope')}
                          className={FIELD_CLASS}
                          data-testid="memory-create-scope"
                        >
                          {INDEX_SCOPES.map((value) => (
                            <option key={value} value={value} disabled={value === 'project' && !projectId}>
                              {t(`rightPanel.memory.control.scope.${value}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {/* Предупреждение (не блокирует): общий индекс по файлам
                        раскрывает workspace проекта всем пользователям инстанса. */}
                    {scope === 'instance' && sourceKind === 'files' && (
                      <p
                        data-testid="memory-create-instance-warning"
                        className="text-[0.6875rem] text-status-warning break-words"
                      >
                        {t('rightPanel.memory.control.instanceFilesWarning')}
                      </p>
                    )}

                    {!canCreate && (
                      <p
                        data-testid="memory-create-project-hint"
                        className="text-[0.6875rem] text-muted-foreground break-words"
                      >
                        {t('rightPanel.memory.control.projectRequired')}
                      </p>
                    )}

                    {formError && (
                      <div
                        role="alert"
                        aria-live="polite"
                        data-testid="memory-create-error"
                        className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive break-words"
                      >
                        {formError}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleCreateIndex()}
                        disabled={busy !== null || !canCreate}
                        data-testid="memory-create-submit"
                      >
                        <Icon name="check" className="size-3.5" />
                        {t('rightPanel.memory.control.createSubmit')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={closeCreateForm}
                        disabled={busy !== null}
                        data-testid="memory-create-cancel"
                      >
                        {t('rightPanel.memory.control.createCancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* 3. Автоматизация памяти (ADR-101): только ADMIN и только при проекте. */}
          {automationEnabled && (
            <Section title={t('rightPanel.memory.automation.title')}>
              <p className="text-[0.6875rem] text-muted-foreground break-words">
                {t('rightPanel.memory.automation.description')}
              </p>

              {automationError && (
                <div
                  role="alert"
                  aria-live="polite"
                  data-testid="memory-automation-error"
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive min-w-0"
                >
                  <span className="min-w-0 break-words">{automationError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void loadAutomation()}
                    data-testid="memory-automation-retry"
                  >
                    <Icon name="refresh" className="size-3.5" />
                    {t('rightPanel.memory.automation.retry')}
                  </Button>
                </div>
              )}

              {automationLoading && !templates && !automationError && (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="memory-automation-loading"
                  className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
                >
                  <Icon name="refresh" className="size-3.5 animate-spin" />
                  {t('common.loading')}
                </div>
              )}

              {templates && (
                <ul className="space-y-2" data-testid="memory-automation-list">
                  {MEMORY_AUTOMATION_ACTIONS.map((action) => {
                    const templateAvailable = templates.some(
                      (template) => template.id === action.templateId,
                    )
                    const pipeline = findPipeline(action.templateId)
                    const published = pipeline?.publishedVersion
                    const run = lastRuns[action.templateId] ?? null
                    const rowBusy = automationBusy === action.key
                    const anyBusy = automationBusy !== null
                    const actionError = automationActionErrors[action.key]
                    const blockedHint = t('rightPanel.memory.automation.runBlocked')

                    return (
                      <li
                        key={action.key}
                        data-testid={`memory-automation-row-${action.key}`}
                        className="space-y-1.5 rounded-md border border-border/60 p-2 min-w-0"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground break-words">
                            {t(action.titleKey)}
                          </div>
                          <div className="text-[0.6875rem] text-muted-foreground break-words">
                            {t(action.hintKey)}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <span
                            data-testid={`memory-automation-template-${action.key}`}
                            className={cn(
                              BADGE,
                              templateAvailable
                                ? 'bg-status-success/15 text-status-success'
                                : 'bg-status-warning/15 text-status-warning',
                            )}
                          >
                            {templateAvailable
                              ? t('rightPanel.memory.automation.template.available')
                              : t('rightPanel.memory.automation.template.missing')}
                          </span>
                          <span
                            data-testid={`memory-automation-pipeline-${action.key}`}
                            className={cn(
                              BADGE,
                              published
                                ? 'bg-status-success/15 text-status-success'
                                : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {published
                              ? t('rightPanel.memory.automation.pipeline.published', {
                                  version: String(published),
                                })
                              : t('rightPanel.memory.automation.pipeline.none')}
                          </span>
                        </div>

                        <div
                          data-testid={`memory-automation-lastrun-${action.key}`}
                          className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground min-w-0"
                        >
                          <span>{t('rightPanel.memory.automation.lastRun')}:</span>
                          {run ? (
                            <>
                              <span
                                className={cn(
                                  BADGE,
                                  RUN_STATUS_CLASS[run.status] ?? 'bg-muted text-muted-foreground',
                                )}
                              >
                                {t(`rightPanel.memory.automation.status.${run.status}`)}
                              </span>
                              <span className="tabular-nums">
                                {formatDateTime(
                                  run.createdAt ?? run.startedAt ?? run.finishedAt,
                                  locale,
                                )}
                              </span>
                            </>
                          ) : (
                            <span>{t('rightPanel.memory.automation.lastRun.none')}</span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {!published && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handlePrepare(action)}
                              disabled={anyBusy || !templateAvailable}
                              data-testid={`memory-automation-prepare-${action.key}`}
                            >
                              <Icon
                                name="refresh"
                                className={cn('size-3', rowBusy && 'animate-spin')}
                              />
                              {t('rightPanel.memory.automation.prepare')}
                            </Button>
                          )}
                          <Button
                            variant={published ? 'primary' : 'outline'}
                            size="sm"
                            onClick={() => void handleRun(action)}
                            disabled={anyBusy || !published}
                            title={!published ? blockedHint : undefined}
                            data-testid={`memory-automation-run-${action.key}`}
                          >
                            <Icon name="rocket" className="size-3" />
                            {t('rightPanel.memory.automation.run')}
                          </Button>
                          {action.schedulable && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleSchedule(action)}
                              disabled={anyBusy || !published}
                              title={!published ? blockedHint : undefined}
                              data-testid={`memory-automation-schedule-${action.key}`}
                            >
                              <Icon name="calendar-schedule" className="size-3" />
                              {t('rightPanel.memory.automation.schedule')}
                            </Button>
                          )}
                        </div>

                        {!published && (
                          <p
                            className="text-[0.6875rem] text-muted-foreground break-words"
                            data-testid={`memory-automation-blocked-${action.key}`}
                          >
                            {blockedHint}
                          </p>
                        )}

                        {actionError && (
                          <div
                            role="alert"
                            aria-live="polite"
                            data-testid={`memory-automation-action-error-${action.key}`}
                            className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive break-words"
                          >
                            {actionError}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>
          )}

          {/* 4. В контексте последнего хода: факты и recall. */}
          <Section title={t('rightPanel.memory.lastContext')}>
            {lastContext === null ? (
              <div
                data-testid="memory-no-turns"
                className="text-xs text-muted-foreground italic"
              >
                {t('rightPanel.memory.noTurns')}
              </div>
            ) : (
              <div className="space-y-2">
                <BlockRow
                  icon="brain"
                  id="facts"
                  label={t('rightPanel.memory.block.facts')}
                  block={lastContext.facts}
                  missingHint={t('rightPanel.memory.block.noFacts')}
                  format={fmt}
                />
                <BlockRow
                  icon="search"
                  id="recall"
                  label={t('rightPanel.memory.block.recall')}
                  block={lastContext.recall}
                  missingHint={t('rightPanel.memory.block.noRecall')}
                  format={fmt}
                />
              </div>
            )}
          </Section>

          {/* 5. Скоуп: агрегаты и список индексов. */}
          <Section title={t('rightPanel.memory.scope')}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <Row
                label={t('rightPanel.memory.scope.factsActive')}
                value={fmt(factsActive)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesTotal')}
                value={fmt(indexes.total)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesProject')}
                value={fmt(indexes.project)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesInstance')}
                value={fmt(indexes.instance)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesReady')}
                value={fmt(indexes.ready)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesBuilding')}
                value={fmt(indexes.building)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesFailed')}
                value={fmt(indexes.failed)}
              />
            </div>

            <div className="space-y-2 border-t border-border/60 pt-2">
              <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                {t('rightPanel.memory.indexes')}
              </div>

              {indexItems.length === 0 ? (
                <p
                  data-testid="memory-index-empty"
                  className="text-xs text-muted-foreground italic"
                >
                  {t('rightPanel.memory.indexes.empty')}
                </p>
              ) : (
                <ul className="space-y-2" data-testid="memory-index-list">
                  {indexItems.map((index) => {
                    const isInstance = index.scope === 'instance'
                    const active = isInstance || index.enabled
                    return (
                      <li
                        key={index.id}
                        data-testid={`memory-index-${index.id}`}
                        data-scope={index.scope}
                        data-enabled={String(index.enabled)}
                        className={cn(
                          'space-y-1 rounded-md border border-border/60 p-2 min-w-0',
                          !active && 'opacity-60',
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-foreground"
                            title={index.name}
                          >
                            {index.name}
                          </span>
                          <span
                            data-testid={`memory-index-scope-${index.id}`}
                            className={cn(
                              BADGE,
                              isInstance
                                ? 'bg-primary/15 text-primary'
                                : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {t(
                              isInstance
                                ? 'rightPanel.memory.indexes.scope.instance'
                                : 'rightPanel.memory.indexes.scope.project',
                            )}
                          </span>
                          <span
                            data-testid={`memory-index-state-${index.id}`}
                            className={cn(
                              BADGE,
                              INDEX_STATE_CLASS[index.state] ?? 'bg-muted text-muted-foreground',
                            )}
                          >
                            {t(`rightPanel.memory.indexes.state.${index.state}`)}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          {isInstance ? (
                            <span
                              data-testid={`memory-index-locked-${index.id}`}
                              className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground"
                            >
                              <Icon name="shield" className="size-3" />
                              {t('rightPanel.memory.indexes.instanceLocked')}
                            </span>
                          ) : isAdmin ? (
                            <>
                              <Toggle
                                enabled={index.enabled}
                                onToggle={() => void handleToggleIndex(index)}
                                ariaLabel={t('rightPanel.memory.indexes.toggle', {
                                  name: index.name,
                                })}
                                pending={busy === index.id}
                                disabled={busy !== null}
                              />
                              <span className="text-[0.6875rem] text-muted-foreground">
                                {index.enabled
                                  ? t('rightPanel.memory.indexes.enabled')
                                  : t('rightPanel.memory.indexes.disabledHint')}
                              </span>
                            </>
                          ) : (
                            <span
                              data-testid={`memory-index-status-${index.id}`}
                              className="text-[0.6875rem] text-muted-foreground"
                            >
                              {index.enabled
                                ? t('rightPanel.memory.indexes.enabled')
                                : t('rightPanel.memory.indexes.disabledHint')}
                            </span>
                          )}

                          {isAdmin && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="ml-auto"
                              onClick={() => void handleRebuildIndex(index)}
                              disabled={busy !== null}
                              data-testid={`memory-index-rebuild-${index.id}`}
                            >
                              <Icon
                                name="refresh"
                                className={cn('size-3', busy === index.id && 'animate-spin')}
                              />
                              {t('rightPanel.memory.indexes.rebuild')}
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

              {indexError && (
                <div
                  role="alert"
                  aria-live="polite"
                  data-testid="memory-index-error"
                  className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive break-words"
                >
                  {indexError}
                </div>
              )}
            </div>
          </Section>

          {/* 6. Подсказки: проблемы со скоупом и провайдером. */}
          {(indexes.failed > 0 || !providerActive) && (
            <Section title={t('rightPanel.memory.hints')}>
              {indexes.failed > 0 && (
                <p
                  data-testid="memory-hint-failed-indexes"
                  className="text-xs text-status-warning break-words"
                >
                  {t('rightPanel.memory.hint.failedIndexes')}
                </p>
              )}
              {!providerActive && (
                <p
                  data-testid="memory-hint-provider-inactive"
                  className="text-xs text-status-warning break-words"
                >
                  {t('rightPanel.memory.hint.providerInactive')}
                </p>
              )}
            </Section>
          )}
        </>
      )}
    </PanelTab>
  )
}
