import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { useProjectsStore } from '@/stores/projectsStore'
import { Button } from '../ui/button'
import { Icon } from '../icon/Icon'
import { SelectContent, SelectItem } from '../ui/select'
import { MemoryGraphCanvas } from './MemoryGraphCanvas'
import {
  InfoField,
  NumberField,
  SettingsPanel,
  SettingsSection,
  SelectField,
  TextField,
  ToggleField,
} from '../ui/settings'
import {
  MEMORY_CONSOLIDATION_THRESHOLD_DEFAULT,
  MEMORY_CONSOLIDATION_THRESHOLD_MAX,
  MEMORY_CONSOLIDATION_THRESHOLD_MIN,
  MEMORY_GRAPH_DEPTH_DEFAULT,
  MEMORY_GRAPH_DEPTH_MAX,
  MEMORY_GRAPH_DEPTH_MIN,
  synthApi,
  type MemoryConsolidationReport,
  type MemoryFact,
  type MemoryFactList,
  type MemoryFactListParams,
  type MemoryFactStatus,
  type MemoryFactStatusFilter,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryIndex,
  type MemoryIndexList,
  type MemoryIndexScope,
  type MemoryIndexSourceKind,
  type MemoryIndexState,
  type MemoryReadiness,
  type MemoryStatus,
} from '@/lib/api/synthApi'

/**
 * ADR-107 / PROP-047: админ-раздел «Память» — портал плагина памяти:
 * состояние провайдера, факты (с провенансом и версиями) и индексы для поиска.
 *
 * Чтение: состояние провайдера, факты, индексы. Мутации — операции с
 * индексами: создание, пересборка и удаление (инлайн-форма + кнопки в строках),
 * плюс консолидация фактов (дубли → заменённые). Отзыв факта — вне этой волны.
 *
 * Плагин памяти может быть не установлен: тогда портал отвечает 503, а
 * раздел объясняет это понятным текстом (`settings.memory.unavailable`).
 * Провайдер не активен (`status.provider.active === false`) или сервер ответил
 * 409 — кнопки мутаций заблокированы, показана подсказка.
 */

/** Общий стиль бейджа статуса (как в соседних админ-разделах). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Готовность портала — закрытый список значений и их цвета. */
const READINESS_VALUES: MemoryReadiness[] = ['ready', 'degraded', 'stale', 'unavailable']

/** Цвет бейджа готовности портала памяти. */
const READINESS_CLASS: Record<string, string> = {
  ready: 'bg-status-success/15 text-status-success',
  degraded: 'bg-status-warning/15 text-status-warning',
  stale: 'bg-status-warning/15 text-status-warning',
  unavailable: 'bg-destructive/15 text-destructive',
}

/** Цвет бейджа статуса факта. */
const FACT_STATUS_CLASS: Record<string, string> = {
  candidate: 'bg-muted text-muted-foreground',
  active: 'bg-status-success/15 text-status-success',
  superseded: 'bg-status-warning/15 text-status-warning',
  retracted: 'bg-destructive/15 text-destructive',
}

/** Цвет бейджа состояния индекса. */
const INDEX_STATE_CLASS: Record<string, string> = {
  building: 'bg-primary/15 text-primary',
  ready: 'bg-status-success/15 text-status-success',
  stale: 'bg-status-warning/15 text-status-warning',
  failed: 'bg-destructive/15 text-destructive',
}

/** Статусы факта — фильтр раздела «Факты». */
const FACT_STATUSES: MemoryFactStatus[] = ['active', 'candidate', 'superseded', 'retracted']

/** Виды факта (PROP-047 §5.2) — фильтр раздела «Факты». */
const FACT_KINDS = ['decision', 'constraint', 'reference', 'preference', 'observation'] as const

/** Состояния индекса — бейдж в таблице индексов. */
const INDEX_STATES: MemoryIndexState[] = ['building', 'ready', 'stale', 'failed']

/** Режимы исполнения провайдера памяти. */
const PROVIDER_MODES = ['inline', 'remote'] as const

/** Значение фильтра «все виды» — пустой фильтр на сервере. */
const ALL_KINDS = 'all'

/** Значение фильтра «все статусы» — сервер так понимает (`status=all`). */
const ALL_STATUSES = 'all'

/** Размер страницы фактов. */
const PAGE_LIMIT = 50

/** Виды источника корпуса, которые UI умеет создавать. */
const INDEX_SOURCE_KINDS: MemoryIndexSourceKind[] = ['files', 'facts']

/** Области видимости индекса: проект (по умолчанию) или общий для инстанса. */
const INDEX_SCOPES: MemoryIndexScope[] = ['project', 'instance']

/** Имя индекса по умолчанию в форме создания. */
const INDEX_DEFAULT_NAME = 'project'

/** Значение «проект не выбран» в селекте проекта (пустая строка недопустима). */
const PROJECT_NONE = '__none__'

/** Значение «все проекты» в селекте консолидации (пустая строка недопустима). */
const PROJECT_ALL = '__all__'

/** Интервал автообновления статуса, пока индексы собираются (мс). */
const INDEX_POLL_INTERVAL_MS = 3000

/** Максимальная длина текста факта в списке графа (обрезается с многоточием). */
const GRAPH_FACT_TEXT_MAX = 120

/** Максимальная длина подписи узла в строке связи. */
const GRAPH_LABEL_TEXT_MAX = 60

/** Функция перевода UI-словаря. */
type Translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => string

/**
 * Подпись значения из закрытого списка: известные значения переводятся,
 * неизвестные (новый вид факта на сервере) показываются как есть — не ключ i18n.
 */
function label(t: Translate, known: readonly string[], prefix: string, value: string): string {
  return known.includes(value) ? t(`${prefix}.${value}`) : value
}

/** Статус HTTP-ошибки (503 — сервис памяти не сконфигурирован). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Уверенность факта: два знака после запятой. */
function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return '—'
  return confidence.toFixed(2)
}

/**
 * Совпадение ссылки на сущность с узлом графа: по имени или по id
 * (регистр не важен — упоминание в тексте факта может отличаться).
 */
function matchesEntity(
  reference: string | undefined,
  entity: { id: string; name: string },
): boolean {
  const ref = (reference ?? '').trim()
  if (!ref) return false
  if (ref === entity.id || ref === entity.name) return true
  return ref.toLowerCase() === entity.name.toLowerCase()
}

/** Обрезка длинного текста факта в списке графа. */
function truncateGraphText(text: string): string {
  const value = text.trim()
  if (value.length <= GRAPH_FACT_TEXT_MAX) return value
  return `${value.slice(0, GRAPH_FACT_TEXT_MAX)}…`
}

/** Узлы графа по id — для разрешения концов рёбер. */
function indexGraphNodes(nodes: MemoryGraphNode[]): Map<string, MemoryGraphNode> {
  const byId = new Map<string, MemoryGraphNode>()
  for (const node of nodes) byId.set(node.id, node)
  return byId
}

/**
 * Подпись узла графа: имя сущности или обрезанный текст факта.
 *
 * Узла-факта без текста (например, обрезанного сервером) показываем по id.
 */
function graphNodeLabel(node: MemoryGraphNode | undefined, fallback: string): string {
  if (!node) return fallback
  if (node.kind === 'entity') return node.name?.trim() || node.id
  const text = (node.text ?? '').trim()
  if (!text) return node.factId ?? node.id
  return text.length > GRAPH_LABEL_TEXT_MAX ? `${text.slice(0, GRAPH_LABEL_TEXT_MAX)}…` : text
}

/**
 * Факты, связанные с сущностью.
 *
 * Основной источник — рёбра «факт → сущность» (связь `mentions`); запасной
 * вариант — поле `entity` узла-факта (если сервер его прислал).
 */
function factsOfEntity(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  entity: { id: string; name: string },
): MemoryGraphNode[] {
  const byId = indexGraphNodes(nodes)
  const linked = new Set<string>()
  for (const edge of edges) {
    if (edge.from === entity.id) {
      const other = byId.get(edge.to)
      if (other?.kind === 'fact') linked.add(other.id)
    } else if (edge.to === entity.id) {
      const other = byId.get(edge.from)
      if (other?.kind === 'fact') linked.add(other.id)
    }
  }
  return nodes.filter(
    (node) => node.kind === 'fact' && (linked.has(node.id) || matchesEntity(node.entity, entity)),
  )
}

/** Связи сущности: рёбра, у которых один из концов — её узел. */
function relationsOfEntity(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  entity: { id: string },
): Array<{ key: string; from: string; to: string; relation: string }> {
  const byId = indexGraphNodes(nodes)
  return edges
    .filter((edge) => edge.from === entity.id || edge.to === entity.id)
    .map((edge) => ({
      key: `${edge.from}->${edge.to}:${edge.relation ?? ''}`,
      from: graphNodeLabel(byId.get(edge.from), edge.from),
      to: graphNodeLabel(byId.get(edge.to), edge.to),
      relation: edge.relation ?? '',
    }))
}

export function MemorySettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const projects = useProjectsStore((s) => s.projects)

  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [facts, setFacts] = useState<MemoryFactList | null>(null)
  const [factsLoading, setFactsLoading] = useState(true)
  const [factsError, setFactsError] = useState<string | null>(null)

  const [indexes, setIndexes] = useState<MemoryIndexList | null>(null)
  const [indexesLoading, setIndexesLoading] = useState(true)
  const [indexesError, setIndexesError] = useState<string | null>(null)

  const [refreshing, setRefreshing] = useState(false)

  // Форма создания индекса (инлайн-форма в блоке «Индексы»).
  const [formOpen, setFormOpen] = useState(false)
  const [nameInput, setNameInput] = useState(INDEX_DEFAULT_NAME)
  const [scope, setScope] = useState<MemoryIndexScope>('project')
  const [sourceKind, setSourceKind] = useState<MemoryIndexSourceKind>('files')
  const [filterInput, setFilterInput] = useState('')
  const [projectInput, setProjectInput] = useState('')
  const [formErrors, setFormErrors] = useState<{ name?: string; project?: string }>({})

  // Мутации индексов: занятость (`create` или id индекса), ошибка и флаг
  // «провайдер памяти недоступен» (409 → кнопки мутаций блокируются).
  const [busy, setBusy] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [providerUnavailable, setProviderUnavailable] = useState(false)

  // Фильтры фактов: поле ввода и применённые значения — разные состояния.
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [factStatus, setFactStatus] = useState<MemoryFactStatusFilter>('active')
  const [factKind, setFactKind] = useState<string>(ALL_KINDS)
  const [offset, setOffset] = useState(0)

  // Детали выбранного факта (`GET /memory/facts/:id`).
  const [detail, setDetail] = useState<MemoryFact | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Консолидация фактов: панель запуска, параметры прогона и результат.
  const [consolidateOpen, setConsolidateOpen] = useState(false)
  const [consolidateProject, setConsolidateProject] = useState<string>(PROJECT_ALL)
  const [consolidateThreshold, setConsolidateThreshold] = useState(
    String(MEMORY_CONSOLIDATION_THRESHOLD_DEFAULT),
  )
  const [consolidateDryRun, setConsolidateDryRun] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [consolidateError, setConsolidateError] = useState<string | null>(null)
  const [consolidateThresholdError, setConsolidateThresholdError] = useState<string | null>(null)
  const [consolidateResult, setConsolidateResult] = useState<{
    report: MemoryConsolidationReport
    dryRun: boolean
  } | null>(null)
  /** Защита от двойного запуска: состояние обновляется асинхронно, ref — сразу. */
  const consolidatingRef = useRef(false)

  // Граф памяти: фильтры (проект/сущность/глубина), результат и выбранная
  // сущность. Пустая сущность — весь граф.
  const [graph, setGraph] = useState<MemoryGraph | null>(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [graphDepthError, setGraphDepthError] = useState<string | null>(null)
  const [graphProviderHint, setGraphProviderHint] = useState(false)
  const [graphProject, setGraphProject] = useState<string>(PROJECT_ALL)
  const [graphEntityInput, setGraphEntityInput] = useState('')
  const [graphDepth, setGraphDepth] = useState(String(MEMORY_GRAPH_DEPTH_DEFAULT))
  const [graphSelectedName, setGraphSelectedName] = useState<string | null>(null)

  /** 503 — сервис памяти не сконфигурирован: портал недоступен. */
  const describeError = useCallback(
    (err: unknown, fallback: string): string =>
      statusOf(err) === 503 ? t('settings.memory.unavailable') : fallback,
    [t],
  )

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await synthApi.getMemoryStatus())
    } catch (err) {
      setStatusError(
        describeError(
          err,
          t('settings.memory.status.error', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        ),
      )
    } finally {
      setStatusLoading(false)
    }
  }, [describeError, t])

  /** Параметры выборки фактов — собираются из применённых фильтров. */
  const factParams = useMemo<MemoryFactListParams>(
    () => ({
      ...(query ? { query } : {}),
      ...(factKind !== ALL_KINDS ? { kind: factKind } : {}),
      status: factStatus,
      limit: PAGE_LIMIT,
      offset,
    }),
    [query, factKind, factStatus, offset],
  )

  const loadFacts = useCallback(async () => {
    setFactsLoading(true)
    setFactsError(null)
    try {
      setFacts(await synthApi.listMemoryFacts(factParams))
    } catch (err) {
      setFactsError(
        describeError(
          err,
          t('settings.memory.facts.error', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        ),
      )
    } finally {
      setFactsLoading(false)
    }
  }, [describeError, factParams, t])

  const loadIndexes = useCallback(async () => {
    setIndexesLoading(true)
    setIndexesError(null)
    try {
      setIndexes(await synthApi.listMemoryIndexes())
    } catch (err) {
      setIndexesError(
        describeError(
          err,
          t('settings.memory.indexes.error', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        ),
      )
    } finally {
      setIndexesLoading(false)
    }
  }, [describeError, t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    void loadFacts()
  }, [loadFacts])

  useEffect(() => {
    void loadIndexes()
  }, [loadIndexes])

  /** Есть ли индексы в работе — тогда статус и список нужно опрашивать. */
  const hasBuildingIndexes = useMemo(
    () => (indexes?.items ?? []).some((index) => index.state === 'building'),
    [indexes],
  )

  /**
   * Автообновление, пока индексы собираются: один таймер на раздел, снимается
   * на unmount и как только building-индексы исчезли.
   */
  useEffect(() => {
    if (!hasBuildingIndexes) return
    const timer = setInterval(() => {
      void loadStatus()
      void loadIndexes()
    }, INDEX_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasBuildingIndexes, loadIndexes, loadStatus])

  /** Провайдер памяти недоступен: активен=false или сервер ответил 409. */
  const providerInactive = providerUnavailable || (status !== null && !status.provider.active)

  /** Есть ли активная мутация (создание/пересборка/удаление). */
  const mutating = busy !== null

  /** Проекты для селекта формы создания индекса. */
  const projectItems = useMemo(
    () => projects.map((project) => ({ value: project.id, label: project.name })),
    [projects],
  )

  /** Реестр проектов нужен селектам (индексы, консолидация, граф). */
  useEffect(() => {
    void useProjectsStore.getState().loadProjects()
  }, [])

  /** Сброс формы создания индекса. */
  const resetForm = useCallback(() => {
    setNameInput(INDEX_DEFAULT_NAME)
    setScope('project')
    setSourceKind('files')
    setFilterInput('')
    setProjectInput('')
    setFormErrors({})
  }, [])

  const handleToggleForm = useCallback(() => {
    if (formOpen) {
      setFormOpen(false)
      resetForm()
      return
    }
    resetForm()
    setFormOpen(true)
  }, [formOpen, resetForm])

  /**
   * Ошибка мутации: 409 — провайдер памяти недоступен (кнопки блокируются),
   * прочие — текст сервера (`error.message`), в т.ч. 422 `MEMORY_INDEX_FAILED`.
   */
  const handleMutationError = useCallback(
    (err: unknown) => {
      const code = statusOf(err)
      if (code === 409) {
        setProviderUnavailable(true)
        setMutationError(t('settings.memory.indexes.providerUnavailable'))
        return
      }
      setMutationError(err instanceof Error ? err.message : t('common.error'))
      // 422 — сервер зафиксировал неудачную сборку: перечитываем список,
      // чтобы строка индекса показала состояние `failed` и текст ошибки.
      if (code === 422) void loadIndexes()
    },
    [loadIndexes, t],
  )

  /**
   * Нужен ли проект для текущей комбинации «область + источник».
   *
   * `scope: 'project'` — индекс принадлежит проекту (проект обязателен);
   * `scope: 'instance'` — индекс общий для инстанса, проект обязателен только
   * для источника `files` (откуда берутся файлы), для `facts` — не нужен.
   *
   * Флаг решает сразу три вещи: обязательность поля, его видимость в форме и
   * отправку `projectId` в теле.
   */
  const projectRequired = scope === 'project' || sourceKind === 'files'

  /**
   * Подпись поля проекта: в области инстанса это проект-источник (его
   * workspace индексируется), в области проекта — сам проект-владелец.
   */
  const projectLabel =
    scope === 'instance'
      ? t('settings.memory.indexes.form.scope.sourceProject')
      : t('settings.memory.indexes.form.project')

  /** Подсказка поля проекта в области инстанса: файлы берутся из его workspace. */
  const projectDescription =
    scope === 'instance' ? t('settings.memory.indexes.form.scope.instanceFilesHint') : undefined

  /** Создание индекса: валидация формы → мутация → перезапрос статуса и списка. */
  const handleCreateIndex = useCallback(async () => {
    const name = nameInput.trim()
    const kind = sourceKind
    const projectId = projectInput
    const errors: { name?: string; project?: string } = {}
    if (!name) errors.name = t('settings.memory.indexes.form.nameRequired')
    // Проект обязателен для индекса проекта и для источника `files`
    // (сервер отвечает 400 `MEMORY_PROJECT_REQUIRED` без `projectId`).
    // Для индекса инстанса с источником `facts` проект не нужен.
    if (projectRequired && !projectId) {
      errors.project = t('settings.memory.indexes.form.projectRequired')
    }
    setFormErrors(errors)
    if (errors.name || errors.project) return

    const filter = filterInput.trim()
    setBusy('create')
    setMutationError(null)
    try {
      await synthApi.createMemoryIndex({
        name,
        source: { kind, ...(filter ? { filter } : {}) },
        ...(projectRequired && projectId ? { projectId } : {}),
        // Область «проект» — дефолт сервера, в тело не пишем.
        ...(scope === 'instance' ? { scope } : {}),
      })
      await Promise.all([loadStatus(), loadIndexes()])
      notify({
        text: t('settings.memory.indexes.created', { name }),
        type: 'success',
        category: 'system',
      })
      setFormOpen(false)
      resetForm()
    } catch (err) {
      handleMutationError(err)
    } finally {
      setBusy(null)
    }
  }, [
    filterInput,
    handleMutationError,
    loadIndexes,
    loadStatus,
    nameInput,
    notify,
    projectInput,
    projectRequired,
    resetForm,
    scope,
    sourceKind,
    t,
  ])

  /** Пересборка индекса: сборка уходит в фон, статус обновляется опросом. */
  const handleRebuildIndex = useCallback(
    async (index: MemoryIndex) => {
      if (busy) return
      setBusy(index.id)
      setMutationError(null)
      try {
        await synthApi.rebuildMemoryIndex(index.id)
        await Promise.all([loadStatus(), loadIndexes()])
        notify({
          text: t('settings.memory.indexes.rebuilt', { name: index.name }),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        handleMutationError(err)
      } finally {
        setBusy(null)
      }
    },
    [busy, handleMutationError, loadIndexes, loadStatus, notify, t],
  )

  /** Удаление индекса — только после подтверждения. */
  const handleDeleteIndex = useCallback(
    async (index: MemoryIndex) => {
      if (busy) return
      const ok = await confirm({
        title: t('settings.memory.indexes.removeConfirmTitle'),
        message: t('settings.memory.indexes.removeConfirm', { name: index.name }),
        confirmLabel: t('settings.memory.indexes.remove'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setBusy(index.id)
      setMutationError(null)
      try {
        await synthApi.deleteMemoryIndex(index.id)
        await Promise.all([loadStatus(), loadIndexes()])
        notify({
          text: t('settings.memory.indexes.deleted', { name: index.name }),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        handleMutationError(err)
      } finally {
        setBusy(null)
      }
    },
    [busy, handleMutationError, loadIndexes, loadStatus, notify, t],
  )

  /** Текст отчёта консолидации (для тоста и баннера в панели). */
  const consolidationReportText = useCallback(
    (report: MemoryConsolidationReport, dryRun: boolean): string =>
      t(dryRun ? 'settings.memory.consolidate.reportDryRun' : 'settings.memory.consolidate.report', {
        clusters: report.clusters,
        superseded: report.superseded,
        kept: report.kept,
      }),
    [t],
  )

  /** Открытие/закрытие панели консолидации (результат прошлого прогона сбрасывается). */
  const handleToggleConsolidate = useCallback(() => {
    if (consolidateOpen) {
      setConsolidateOpen(false)
      return
    }
    setConsolidateError(null)
    setConsolidateThresholdError(null)
    setConsolidateResult(null)
    setConsolidateOpen(true)
  }, [consolidateOpen])

  /**
   * Порог консолидации: вне диапазона 0.5..0.99 — инлайн-ошибка у поля,
   * запрос не уходит (сервер ответил бы 400 `VALIDATION_ERROR`).
   */
  const validateThreshold = useCallback(
    (raw: string): number | null => {
      const value = Number(raw.trim())
      if (
        !raw.trim() ||
        !Number.isFinite(value) ||
        value < MEMORY_CONSOLIDATION_THRESHOLD_MIN ||
        value > MEMORY_CONSOLIDATION_THRESHOLD_MAX
      ) {
        setConsolidateThresholdError(t('settings.memory.consolidate.thresholdInvalid'))
        return null
      }
      setConsolidateThresholdError(null)
      return value
    },
    [t],
  )

  /**
   * Ошибка консолидации: 409 — провайдер памяти недоступен (кнопки блокируются),
   * 400 — порог вне диапазона (инлайн-ошибка), 422 и прочие — текст сервера.
   */
  const handleConsolidateError = useCallback(
    (err: unknown) => {
      const code = statusOf(err)
      if (code === 409) {
        setProviderUnavailable(true)
        setConsolidateError(t('settings.memory.consolidate.providerUnavailable'))
        return
      }
      if (code === 400) {
        setConsolidateThresholdError(t('settings.memory.consolidate.thresholdInvalid'))
        return
      }
      setConsolidateError(err instanceof Error ? err.message : t('common.error'))
    },
    [t],
  )

  /**
   * Запуск консолидации: порог → подтверждение (кроме пробного прогона) →
   * запрос → отчёт и перечитывание фактов/статуса.
   */
  const handleConsolidate = useCallback(async () => {
    if (consolidatingRef.current) return
    const threshold = validateThreshold(consolidateThreshold)
    if (threshold === null) return

    consolidatingRef.current = true
    setConsolidating(true)
    setConsolidateError(null)
    try {
      if (!consolidateDryRun) {
        const ok = await confirm({
          title: t('settings.memory.consolidate.confirmTitle'),
          message: t('settings.memory.consolidate.confirm'),
          confirmLabel: t('settings.memory.consolidate.run'),
          variant: 'warning',
          icon: 'git-branch',
        })
        if (!ok) return
      }
      const { report } = await synthApi.consolidateMemory({
        ...(consolidateProject !== PROJECT_ALL ? { projectId: consolidateProject } : {}),
        threshold,
        dryRun: consolidateDryRun,
      })
      setConsolidateResult({ report, dryRun: consolidateDryRun })
      notify({
        text: consolidationReportText(report, consolidateDryRun),
        type: 'success',
        category: 'system',
      })
      await Promise.all([loadFacts(), loadStatus()])
    } catch (err) {
      handleConsolidateError(err)
    } finally {
      consolidatingRef.current = false
      setConsolidating(false)
    }
  }, [
    consolidateDryRun,
    consolidateProject,
    consolidateThreshold,
    consolidationReportText,
    handleConsolidateError,
    loadFacts,
    loadStatus,
    notify,
    t,
    validateThreshold,
  ])

  /**
   * Глубина обхода графа: вне 1..3 — инлайн-ошибка, запрос не уходит
   * (сервер ответил бы 400 `VALIDATION_ERROR`).
   */
  const validateGraphDepth = useCallback(
    (raw: string): number | null => {
      const value = Number(raw.trim())
      if (
        !raw.trim() ||
        !Number.isInteger(value) ||
        value < MEMORY_GRAPH_DEPTH_MIN ||
        value > MEMORY_GRAPH_DEPTH_MAX
      ) {
        setGraphDepthError(t('settings.memory.graph.depthInvalid'))
        return null
      }
      setGraphDepthError(null)
      return value
    },
    [t],
  )

  /**
   * Ошибка построения графа: 409 — плагин памяти не активен (подсказка),
   * 400 — глубина вне диапазона (инлайн-ошибка), прочие — баннер с текстом
   * сервера (в т.ч. 422 `MEMORY_GRAPH_FAILED`).
   */
  const handleGraphError = useCallback(
    (err: unknown) => {
      const code = statusOf(err)
      if (code === 409) {
        setProviderUnavailable(true)
        setGraphProviderHint(true)
        setGraphError(null)
        return
      }
      if (code === 400) {
        setGraphDepthError(t('settings.memory.graph.depthInvalid'))
        setGraphError(null)
        return
      }
      setGraphProviderHint(false)
      setGraphError(
        describeError(err, err instanceof Error ? err.message : t('common.error')),
      )
    },
    [describeError, t],
  )

  /**
   * Построение графа по текущим фильтрам. `override.entity` — сущность,
   * выбранная в списке: клик подставляет её в фильтр и перестраивает граф.
   */
  const buildGraph = useCallback(
    async (override?: { entity?: string }) => {
      const depth = validateGraphDepth(graphDepth)
      if (depth === null) return
      const entity = (override?.entity ?? graphEntityInput).trim()
      setGraphLoading(true)
      setGraphError(null)
      setGraphProviderHint(false)
      try {
        setGraph(
          await synthApi.getMemoryGraph({
            ...(entity ? { entity } : {}),
            depth,
            ...(graphProject !== PROJECT_ALL ? { projectId: graphProject } : {}),
          }),
        )
        setGraphSelectedName(entity || null)
      } catch (err) {
        handleGraphError(err)
      } finally {
        setGraphLoading(false)
      }
    },
    [graphDepth, graphEntityInput, graphProject, handleGraphError, validateGraphDepth],
  )

  /** Клик по сущности в списке: подставляет её в фильтр и перестраивает граф. */
  const selectGraphEntity = useCallback(
    (entity: { name: string }) => {
      setGraphEntityInput(entity.name)
      void buildGraph({ entity: entity.name })
    },
    [buildGraph],
  )

  /** «Обновить» — перезапрос всех трёх срезов портала. */
  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadStatus(), loadFacts(), loadIndexes()])
    } finally {
      setRefreshing(false)
    }
  }, [loadFacts, loadIndexes, loadStatus, refreshing])

  /** Применение поиска по тексту: фильтр меняется — страница возвращается на первую. */
  const applyQuery = useCallback(() => {
    setQuery(queryInput.trim())
    setOffset(0)
  }, [queryInput])

  const handleStatusFilter = useCallback((value: string) => {
    setFactStatus(value as MemoryFactStatusFilter)
    setOffset(0)
  }, [])

  const handleKindFilter = useCallback((value: string) => {
    setFactKind(value)
    setOffset(0)
  }, [])

  const handlePrevPage = useCallback(() => {
    setOffset((current) => Math.max(0, current - PAGE_LIMIT))
  }, [])

  const handleNextPage = useCallback(() => {
    setOffset((current) => current + PAGE_LIMIT)
  }, [])

  /** Детали факта: повторный клик по тому же факту закрывает блок. */
  const handleOpenDetail = useCallback(
    async (id: string) => {
      if (detailId === id) {
        setDetailId(null)
        setDetail(null)
        setDetailError(null)
        return
      }
      setDetailId(id)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(true)
      try {
        setDetail(await synthApi.getMemoryFact(id))
      } catch (err) {
        setDetailError(
          describeError(
            err,
            t('settings.memory.facts.detail.error', {
              error: err instanceof Error ? err.message : t('common.error'),
            }),
          ),
        )
      } finally {
        setDetailLoading(false)
      }
    },
    [describeError, detailId, t],
  )

  const factsItems = facts?.items ?? []
  const factsTotal = facts?.total ?? 0
  const factsFrom = factsItems.length > 0 ? offset + 1 : 0
  const factsTo = offset + factsItems.length
  const hasNextPage = factsItems.length > 0 && offset + factsItems.length < factsTotal

  /** Сущности графа: имя и число связанных с ними фактов. */
  const graphEntities = useMemo(() => {
    const nodes = graph?.nodes ?? []
    const edges = graph?.edges ?? []
    return nodes
      .filter((node) => node.kind === 'entity')
      .map((node) => {
        const name = node.name?.trim() || node.id
        const entity = { id: node.id, name }
        return {
          id: node.id,
          name,
          factCount: factsOfEntity(nodes, edges, entity).length,
        }
      })
  }, [graph])

  /** Выбранная сущность — узел графа по имени фильтра (если такой есть). */
  const graphSelected = useMemo(() => {
    const name = graphSelectedName
    if (!name) return null
    const exact = graphEntities.find((entity) => entity.name === name)
    if (exact) return exact
    const lower = name.toLowerCase()
    return graphEntities.find((entity) => entity.name.toLowerCase() === lower) ?? null
  }, [graphEntities, graphSelectedName])

  /** Связи выбранной сущности: «откуда —rel→ куда». */
  const graphRelations = useMemo(() => {
    const selected = graphSelected
    if (!selected || !graph) return []
    return relationsOfEntity(graph.nodes, graph.edges, selected)
  }, [graph, graphSelected])

  /**
   * Подпись связи: известные метки плагина переводим, пользовательские
   * (`[[сущность|связь]]`) показываем как есть.
   */
  const graphRelationLabel = useCallback(
    (relation: string): string => {
      if (!relation) return t('settings.memory.graph.relationUnknown')
      if (relation === 'mentions') return t('settings.memory.graph.relationMentions')
      if (relation === 'co_occurs') return t('settings.memory.graph.relationCoOccurs')
      return relation
    },
    [t],
  )

  /** Связанные с выбранной сущностью факты. */
  const graphFacts = useMemo(() => {
    const selected = graphSelected
    if (!selected || !graph) return []
    return factsOfEntity(graph.nodes, graph.edges, selected)
  }, [graph, graphSelected])

  return (
    <SettingsPanel
      title={t('settings.memory.title')}
      description={t('settings.memory.description')}
    >
      {/* 1. Состояние: провайдер, готовность, счётчики. */}
      <SettingsSection
        id="memory-status"
        title={t('settings.memory.status.title')}
        description={t('settings.memory.status.description')}
        tooltip={t('settings.help.memory.section.memory-status')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            data-testid="memory-refresh"
          >
            <Icon name="refresh" className={cn('size-3.5', refreshing && 'animate-spin')} />
            {refreshing ? t('settings.memory.refreshing') : t('settings.memory.refresh')}
          </Button>
        }
      >
        {statusError && (
          <div
            role="alert"
            data-testid="memory-status-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{statusError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadStatus()}
              data-testid="memory-status-retry"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.memory.retry')}
            </Button>
          </div>
        )}

        {statusLoading && !status && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {status && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="memory-badges">
              <span
                data-testid="memory-readiness-badge"
                className={cn(BADGE, READINESS_CLASS[status.readiness])}
              >
                {label(t, READINESS_VALUES, 'settings.memory.readiness', status.readiness)}
              </span>
              <span
                data-testid="memory-provider-badge"
                className={cn(
                  BADGE,
                  status.provider.active
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {status.provider.active
                  ? t('settings.memory.provider.active')
                  : t('settings.memory.provider.inactive')}
              </span>
            </div>

            <div className="space-y-1.5 min-w-0" data-testid="memory-status-info">
              <InfoField
                label={t('settings.memory.field.readiness')}
                value={label(t, READINESS_VALUES, 'settings.memory.readiness', status.readiness)}
              />
              <InfoField label={t('settings.memory.field.provider')} value={status.provider.id || '—'} mono />
              <InfoField
                label={t('settings.memory.field.providerMode')}
                value={
                  status.provider.mode
                    ? label(t, PROVIDER_MODES, 'settings.memory.provider.mode', status.provider.mode)
                    : t('settings.memory.provider.mode.none')
                }
                mono
              />
              <InfoField
                label={t('settings.memory.field.namespace')}
                value={status.namespace || '—'}
                mono
              />
              <InfoField
                label={t('settings.memory.field.factsTotal')}
                value={String(status.facts.total)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.factsActive')}
                value={String(status.facts.active)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesTotal')}
                value={String(status.indexes.total)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesReady')}
                value={String(status.indexes.ready)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesStale')}
                value={String(status.indexes.stale)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesFailed')}
                value={String(status.indexes.failed)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesBuilding')}
                value={String(status.indexes.building)}
                mono
              />
            </div>
          </>
        )}
      </SettingsSection>

      {/* 2. Факты: фильтры, постраничный список, детали факта. */}
      <SettingsSection
        id="memory-facts"
        title={t('settings.memory.facts.title')}
        description={t('settings.memory.facts.description')}
        tooltip={t('settings.help.memory.section.memory-facts')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleConsolidate}
            disabled={providerInactive || consolidating}
            data-testid="memory-consolidate-toggle"
          >
            <Icon name="git-branch" className="size-3.5" />
            {t('settings.memory.consolidate.open')}
          </Button>
        }
      >
        {factsError && (
          <div
            role="alert"
            data-testid="memory-facts-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{factsError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadFacts()}
              data-testid="memory-facts-retry"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.memory.retry')}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
          <div className="sm:col-span-2 flex flex-wrap items-end gap-2 min-w-0">
            <TextField
              label={t('settings.memory.facts.filter.query')}
              placeholder={t('settings.memory.facts.filter.queryPlaceholder')}
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyQuery()
                }
              }}
              containerClassName="flex-1 min-w-0"
              id="memory-facts-query"
              data-testid="memory-facts-query"
            />
            <Button
              variant="outline"
              onClick={applyQuery}
              disabled={factsLoading}
              data-testid="memory-facts-search"
            >
              <Icon name="search" className="size-3.5" />
              {t('settings.memory.facts.filter.apply')}
            </Button>
          </div>

          <SelectField
            label={t('settings.memory.facts.filter.status')}
            value={factStatus}
            onValueChange={handleStatusFilter}
            ariaLabel={t('settings.memory.facts.filter.status')}
            triggerTestId="memory-facts-status-filter"
            items={[
              { value: ALL_STATUSES, label: t('settings.memory.facts.filter.all') },
              ...FACT_STATUSES.map((value) => ({
                value,
                label: t(`settings.memory.facts.status.${value}`),
              })),
            ]}
          >
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>{t('settings.memory.facts.filter.all')}</SelectItem>
              {FACT_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.memory.facts.status.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('settings.memory.facts.filter.kind')}
            value={factKind}
            onValueChange={handleKindFilter}
            ariaLabel={t('settings.memory.facts.filter.kind')}
            triggerTestId="memory-facts-kind-filter"
            items={[
              { value: ALL_KINDS, label: t('settings.memory.facts.filter.all') },
              ...FACT_KINDS.map((value) => ({
                value,
                label: t(`settings.memory.facts.kind.${value}`),
              })),
            ]}
          >
            <SelectContent>
              <SelectItem value={ALL_KINDS}>{t('settings.memory.facts.filter.all')}</SelectItem>
              {FACT_KINDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.memory.facts.kind.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>

        {providerInactive && (
          <p
            data-testid="memory-consolidate-provider-hint"
            className="text-xs text-status-warning break-words"
          >
            {t('settings.memory.consolidate.providerUnavailable')}
          </p>
        )}

        {/* Панель консолидации фактов (PROP-047): проект, порог, пробный прогон. */}
        {consolidateOpen && (
          <div
            className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="memory-consolidate-panel"
          >
            <div className="text-xs font-medium text-foreground break-words">
              {t('settings.memory.consolidate.title')}
            </div>
            <p className="text-xs text-muted-foreground break-words">
              {t('settings.memory.consolidate.description')}
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
              <SelectField
                label={t('settings.memory.consolidate.project')}
                value={consolidateProject}
                onValueChange={setConsolidateProject}
                ariaLabel={t('settings.memory.consolidate.project')}
                triggerTestId="memory-consolidate-project"
                items={[
                  { value: PROJECT_ALL, label: t('settings.memory.consolidate.projectAll') },
                  ...projectItems,
                ]}
              >
                <SelectContent>
                  <SelectItem value={PROJECT_ALL}>
                    {t('settings.memory.consolidate.projectAll')}
                  </SelectItem>
                  {projectItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>

              <NumberField
                label={t('settings.memory.consolidate.threshold')}
                description={t('settings.memory.consolidate.thresholdHint')}
                value={consolidateThreshold}
                onChange={(event) => setConsolidateThreshold(event.target.value)}
                min={MEMORY_CONSOLIDATION_THRESHOLD_MIN}
                max={MEMORY_CONSOLIDATION_THRESHOLD_MAX}
                step={0.01}
                error={consolidateThresholdError ?? undefined}
                data-testid="memory-consolidate-threshold"
              />
            </div>

            <div data-testid="memory-consolidate-dry-run">
              <ToggleField
                label={t('settings.memory.consolidate.dryRun')}
                description={t('settings.memory.consolidate.dryRunHint')}
                enabled={consolidateDryRun}
                onToggle={() => setConsolidateDryRun((value) => !value)}
                ariaLabel={t('settings.memory.consolidate.dryRun')}
              />
            </div>

            {consolidateError && (
              <div
                role="alert"
                data-testid="memory-consolidate-error"
                className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
              >
                {consolidateError}
              </div>
            )}

            {consolidateResult && (
              <div
                data-testid="memory-consolidate-report"
                className="rounded-lg bg-status-success/15 p-3 text-sm text-foreground break-words"
              >
                {consolidationReportText(consolidateResult.report, consolidateResult.dryRun)}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleConsolidate()}
                disabled={consolidating || providerInactive}
                data-testid="memory-consolidate-run"
              >
                <Icon name="check" className={cn('size-3.5', consolidating && 'animate-spin')} />
                {consolidating
                  ? t('settings.memory.consolidate.running')
                  : t('settings.memory.consolidate.run')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleConsolidate}
                disabled={consolidating}
                data-testid="memory-consolidate-cancel"
              >
                {t('settings.memory.consolidate.cancel')}
              </Button>
            </div>
          </div>
        )}

        {factsLoading && !facts && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {facts && factsItems.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="memory-facts-empty"
          >
            <Icon name="lightbulb" className="size-6 opacity-40" />
            <p className="text-xs">{t('settings.memory.facts.empty')}</p>
          </div>
        )}

        {facts && factsItems.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="memory-facts-table">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">{t('settings.memory.facts.column.text')}</th>
                    <th className="py-1 pr-2 font-medium">{t('settings.memory.facts.column.kind')}</th>
                    <th className="py-1 pr-2 font-medium">{t('settings.memory.facts.column.status')}</th>
                    <th className="py-1 pr-2 font-medium">
                      {t('settings.memory.facts.column.confidence')}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t('settings.memory.facts.column.provenance')}
                    </th>
                    <th className="py-1 font-medium">{t('settings.memory.facts.column.version')}</th>
                  </tr>
                </thead>
                <tbody>
                  {factsItems.map((fact) => (
                    <tr
                      key={fact.id}
                      className="border-t border-border/60 align-top"
                      data-testid={`memory-fact-${fact.id}`}
                    >
                      <td className="max-w-[16rem] py-1 pr-2">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left text-foreground"
                          title={fact.text}
                          onClick={() => void handleOpenDetail(fact.id)}
                          data-testid={`memory-fact-text-${fact.id}`}
                        >
                          {fact.text}
                        </button>
                      </td>
                      <td className="py-1 pr-2 text-muted-foreground">
                        {label(t, FACT_KINDS, 'settings.memory.facts.kind', fact.kind)}
                      </td>
                      <td className="py-1 pr-2">
                        <span
                          data-testid={`memory-fact-status-${fact.id}`}
                          className={cn(BADGE, FACT_STATUS_CLASS[fact.status])}
                        >
                          {label(t, FACT_STATUSES, 'settings.memory.facts.status', fact.status)}
                        </span>
                      </td>
                      <td className="py-1 pr-2 font-mono">{formatConfidence(fact.confidence)}</td>
                      <td className="py-1 pr-2 text-muted-foreground">
                        <span className="block break-words">
                          {fact.provenance.sourceKind} {fact.provenance.sourceId}
                        </span>
                        <span className="block text-muted-foreground">
                          {formatDateTime(fact.provenance.capturedAt, locale)}
                        </span>
                      </td>
                      <td className="py-1 font-mono">{fact.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              className="flex flex-wrap items-center justify-between gap-2 min-w-0"
              data-testid="memory-facts-pagination"
            >
              <span className="text-xs text-muted-foreground break-words">
                {t('settings.memory.facts.page', {
                  from: factsFrom,
                  to: factsTo,
                  total: factsTotal,
                })}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrevPage}
                  disabled={factsLoading || offset <= 0}
                  data-testid="memory-facts-prev"
                >
                  <Icon name="arrow-go-back" className="size-3.5" />
                  {t('settings.memory.facts.prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={factsLoading || !hasNextPage}
                  data-testid="memory-facts-next"
                >
                  {t('settings.memory.facts.next')}
                  <Icon name="arrow-right" className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}

        {detailLoading && (
          <div className="py-2 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {detailError && (
          <div
            role="alert"
            data-testid="memory-fact-detail-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {detailError}
          </div>
        )}

        {detail && (
          <div
            className="space-y-1.5 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="memory-fact-detail"
          >
            <div className="text-xs font-medium text-foreground break-words">
              {t('settings.memory.facts.detail.title')}
            </div>
            <p className="text-xs text-foreground break-words">{detail.text}</p>
            <InfoField
              label={t('settings.memory.facts.detail.capturedAt')}
              value={formatDateTime(detail.provenance.capturedAt, locale)}
            />
            <InfoField
              label={t('settings.memory.facts.detail.updatedAt')}
              value={formatDateTime(detail.updatedAt, locale)}
            />
            {detail.validUntil && (
              <InfoField
                label={t('settings.memory.facts.detail.validUntil')}
                value={formatDateTime(detail.validUntil, locale)}
              />
            )}
            {detail.supersededBy && (
              <InfoField
                label={t('settings.memory.facts.detail.supersededBy')}
                value={detail.supersededBy}
                mono
              />
            )}
            {detail.projectId && (
              <InfoField
                label={t('settings.memory.facts.detail.projectId')}
                value={detail.projectId}
                mono
              />
            )}
            {detail.userId && (
              <InfoField
                label={t('settings.memory.facts.detail.userId')}
                value={detail.userId}
                mono
              />
            )}
          </div>
        )}
      </SettingsSection>

      {/* 3. Граф: сущности, связи и связанные факты (только списки, без canvas). */}
      <SettingsSection
        id="memory-graph"
        title={t('settings.memory.graph.title')}
        description={t('settings.memory.graph.description')}
        tooltip={t('settings.help.memory.section.memory-graph')}
      >
        {graph && (
          <div
            className="text-xs text-muted-foreground break-words"
            data-testid="memory-graph-stats"
          >
            {t('settings.memory.graph.stats', {
              entities: graph.stats.entities,
              facts: graph.stats.facts,
              edges: graph.stats.edges,
            })}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
          <SelectField
            label={t('settings.memory.graph.project')}
            value={graphProject}
            onValueChange={setGraphProject}
            ariaLabel={t('settings.memory.graph.project')}
            triggerTestId="memory-graph-project"
            items={[
              { value: PROJECT_ALL, label: t('settings.memory.graph.projectAll') },
              ...projectItems,
            ]}
          >
            <SelectContent>
              <SelectItem value={PROJECT_ALL}>
                {t('settings.memory.graph.projectAll')}
              </SelectItem>
              {projectItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <TextField
            label={t('settings.memory.graph.entity')}
            placeholder={t('settings.memory.graph.entityPlaceholder')}
            value={graphEntityInput}
            onChange={(event) => setGraphEntityInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void buildGraph()
              }
            }}
            containerClassName="min-w-0"
            data-testid="memory-graph-entity"
          />

          <NumberField
            label={t('settings.memory.graph.depth')}
            description={t('settings.memory.graph.depthHint')}
            value={graphDepth}
            onChange={(event) => setGraphDepth(event.target.value)}
            min={MEMORY_GRAPH_DEPTH_MIN}
            max={MEMORY_GRAPH_DEPTH_MAX}
            step={1}
            error={graphDepthError ?? undefined}
            data-testid="memory-graph-depth"
          />

          <div className="flex items-end min-w-0">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void buildGraph()}
              disabled={graphLoading}
              data-testid="memory-graph-build"
            >
              <Icon
                name={graphLoading ? 'loader-2' : 'links-line'}
                className={cn('size-3.5', graphLoading && 'animate-spin')}
              />
              {t('settings.memory.graph.build')}
            </Button>
          </div>
        </div>

        {graphProviderHint && (
          <p
            data-testid="memory-graph-provider-hint"
            className="text-xs text-status-warning break-words"
          >
            {t('settings.memory.graph.providerUnavailable')}
          </p>
        )}

        {graphError && (
          <div
            role="alert"
            data-testid="memory-graph-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {graphError}
          </div>
        )}

        {graphLoading && (
          <div
            className="py-2 text-center text-xs text-muted-foreground"
            data-testid="memory-graph-loading"
          >
            {t('common.loading')}
          </div>
        )}

        {/* Визуализация графа: клик по узлу — тот же обработчик, что клик по
            сущности в списке (подставляет `entity` и перестраивает граф).
            Пустой граф канвас не рисует — состояние показывает секция. */}
        {graph && (
          <MemoryGraphCanvas
            graph={graph}
            selectedEntity={graphSelected?.name}
            onSelectEntity={(name) => selectGraphEntity({ name })}
          />
        )}

        {graph && (
          <div className="space-y-1.5 min-w-0">
            <div className="text-xs font-medium text-foreground break-words">
              {t('settings.memory.graph.entitiesTitle')}
            </div>
            {graphEntities.length === 0 ? (
              <p
                className="text-xs text-muted-foreground break-words"
                data-testid="memory-graph-entities-empty"
              >
                {t('settings.memory.graph.entitiesEmpty')}
              </p>
            ) : (
              <ul className="space-y-1 min-w-0" data-testid="memory-graph-entities">
                {graphEntities.map((entity) => (
                  <li key={entity.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => selectGraphEntity(entity)}
                      className={cn(
                        'block max-w-full truncate text-left text-xs text-foreground',
                        graphSelected?.id === entity.id && 'font-medium text-primary',
                      )}
                      title={entity.name}
                      data-testid={`memory-graph-entity-${entity.id}`}
                    >
                      {entity.name}
                      <span className="ml-1.5 text-muted-foreground">
                        {t('settings.memory.graph.entityFacts', { count: entity.factCount })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {graph && graph.edges.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="memory-graph-empty"
          >
            <Icon name="links-line" className="size-6 opacity-40" />
            <p className="text-xs">{t('settings.memory.graph.empty')}</p>
          </div>
        )}

        {graphSelected && (
          <div
            className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="memory-graph-selected"
          >
            <div className="text-xs font-medium text-foreground break-words">
              {t('settings.memory.graph.selectedTitle', { name: graphSelected.name })}
            </div>

            <div className="space-y-1 min-w-0">
              <div className="text-xs font-medium text-muted-foreground break-words">
                {t('settings.memory.graph.relationsTitle')}
              </div>
              {graphRelations.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground break-words"
                  data-testid="memory-graph-relations-empty"
                >
                  {t('settings.memory.graph.relationsEmpty')}
                </p>
              ) : (
                <ul className="space-y-1 min-w-0" data-testid="memory-graph-relations">
                  {graphRelations.map((relation) => (
                    <li
                      key={relation.key}
                      className="text-xs text-foreground break-words"
                      data-testid={`memory-graph-relation-${relation.key}`}
                    >
                      {relation.from} —{graphRelationLabel(relation.relation)}
                      → {relation.to}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1 min-w-0">
              <div className="text-xs font-medium text-muted-foreground break-words">
                {t('settings.memory.graph.factsTitle')}
              </div>
              {graphFacts.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground break-words"
                  data-testid="memory-graph-facts-empty"
                >
                  {t('settings.memory.graph.factsEmpty')}
                </p>
              ) : (
                <ul className="space-y-1 min-w-0" data-testid="memory-graph-facts">
                  {graphFacts.map((fact) => (
                    <li
                      key={fact.id}
                      className="text-xs text-muted-foreground break-words"
                      title={fact.text}
                      data-testid={`memory-graph-fact-${fact.id}`}
                    >
                      {truncateGraphText(fact.text ?? '')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SettingsSection>

      {/* 4. Индексы: корпуса для поиска + операции с индексами. */}
      <SettingsSection
        id="memory-indexes"
        title={t('settings.memory.indexes.title')}
        description={t('settings.memory.indexes.description')}
        tooltip={t('settings.help.memory.section.memory-indexes')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleForm}
            disabled={providerInactive}
            data-testid="memory-index-create-toggle"
          >
            <Icon name="add" className="size-3.5" />
            {t('settings.memory.indexes.create')}
          </Button>
        }
      >
        {providerInactive && (
          <p
            data-testid="memory-index-provider-hint"
            className="text-xs text-status-warning break-words"
          >
            {t('settings.memory.indexes.providerUnavailable')}
          </p>
        )}

        {mutationError && (
          <div
            role="alert"
            data-testid="memory-index-mutation-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {mutationError}
          </div>
        )}

        {indexesError && (
          <div
            role="alert"
            data-testid="memory-indexes-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{indexesError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadIndexes()}
              data-testid="memory-indexes-retry"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.memory.retry')}
            </Button>
          </div>
        )}

        {/* Форма создания индекса — инлайн, без модального окна. */}
        {formOpen && (
          <div
            className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="memory-index-create-form"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
              <TextField
                label={t('settings.memory.indexes.form.name')}
                placeholder={t('settings.memory.indexes.form.namePlaceholder')}
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                error={formErrors.name}
                data-testid="memory-index-create-name"
              />
              <SelectField
                label={t('settings.memory.indexes.form.scope')}
                description={
                  scope === 'instance'
                    ? t('settings.memory.indexes.form.scope.instanceHint')
                    : undefined
                }
                value={scope}
                onValueChange={(value) => setScope(value as MemoryIndexScope)}
                ariaLabel={t('settings.memory.indexes.form.scope')}
                triggerTestId="memory-index-create-scope"
                items={INDEX_SCOPES.map((value) => ({
                  value,
                  label: t(`settings.memory.indexes.form.scope.${value}`),
                }))}
              >
                <SelectContent>
                  {INDEX_SCOPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`settings.memory.indexes.form.scope.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
              <SelectField
                label={t('settings.memory.indexes.form.source')}
                value={sourceKind}
                onValueChange={(value) => setSourceKind(value as MemoryIndexSourceKind)}
                ariaLabel={t('settings.memory.indexes.form.source')}
                triggerTestId="memory-index-create-source"
                items={INDEX_SOURCE_KINDS.map((kind) => ({
                  value: kind,
                  label: t(`settings.memory.indexes.form.source.${kind}`),
                }))}
              >
                <SelectContent>
                  {INDEX_SOURCE_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`settings.memory.indexes.form.source.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
              <TextField
                label={t('settings.memory.indexes.form.filter')}
                placeholder={t('settings.memory.indexes.form.filterPlaceholder')}
                value={filterInput}
                onChange={(event) => setFilterInput(event.target.value)}
                data-testid="memory-index-create-filter"
              />
              {/* Проект не нужен для индекса инстанса с источником `facts`. */}
              {projectRequired && (
                <SelectField
                  label={projectLabel}
                  description={projectDescription}
                  value={projectInput || PROJECT_NONE}
                  onValueChange={(value) => setProjectInput(value === PROJECT_NONE ? '' : value)}
                  ariaLabel={projectLabel}
                  triggerTestId="memory-index-create-project"
                  error={formErrors.project}
                  items={[
                    {
                      value: PROJECT_NONE,
                      label: t('settings.memory.indexes.form.projectNone'),
                    },
                    ...projectItems,
                  ]}
                >
                  <SelectContent>
                    <SelectItem value={PROJECT_NONE}>
                      {t('settings.memory.indexes.form.projectNone')}
                    </SelectItem>
                    {projectItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectField>
              )}
            </div>

            {/* Предупреждение (не блокирует): общий индекс инстанса раскрывает
                содержимое workspace проекта всем пользователям инстанса. */}
            {scope === 'instance' && sourceKind === 'files' && (
              <p
                data-testid="memory-index-create-instance-warning"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.memory.indexes.form.scope.instanceFilesWarning')}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleCreateIndex()}
                disabled={mutating}
                data-testid="memory-index-create-submit"
              >
                <Icon name="check" className="size-3.5" />
                {t('settings.memory.indexes.createSubmit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleForm}
                disabled={mutating}
                data-testid="memory-index-create-cancel"
              >
                {t('settings.memory.indexes.createCancel')}
              </Button>
            </div>
          </div>
        )}

        {indexesLoading && !indexes && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {indexes && indexes.items.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="memory-indexes-empty"
          >
            <Icon name="database-2" className="size-6 opacity-40" />
            <p className="text-xs">{t('settings.memory.indexes.empty')}</p>
          </div>
        )}

        {indexes && indexes.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="memory-indexes-table">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.name')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.state')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.generation')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.embedding')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.volume')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.updated')}
                  </th>
                  <th className="py-1 font-medium">
                    {t('settings.memory.indexes.column.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {indexes.items.map((index: MemoryIndex) => (
                  <tr
                    key={index.id}
                    className="border-t border-border/60 align-top"
                    data-testid={`memory-index-${index.id}`}
                  >
                    <td className="py-1 pr-2 break-words">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-foreground">{index.name}</span>
                        {/* Область индекса: «инстанс» — общий для всех пользователей. */}
                        {index.scope === 'instance' && (
                          <span
                            data-testid={`memory-index-scope-${index.id}`}
                            className={cn(BADGE, 'bg-primary/15 text-primary')}
                          >
                            {t('settings.memory.indexes.scopeBadge.instance')}
                          </span>
                        )}
                      </span>
                      <span className="block text-muted-foreground break-words">
                        {index.source.kind}
                        {index.source.filter ? ` · ${index.source.filter}` : ''}
                      </span>
                    </td>
                    <td className="py-1 pr-2">
                      <span
                        data-testid={`memory-index-state-${index.id}`}
                        className={cn(BADGE, INDEX_STATE_CLASS[index.state])}
                      >
                        {label(t, INDEX_STATES, 'settings.memory.indexes.state', index.state)}
                      </span>
                    </td>
                    <td className="py-1 pr-2 font-mono">{index.generation}</td>
                    <td className="py-1 pr-2 font-mono break-words">
                      {index.fingerprint.model} ({index.fingerprint.dimension})
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">
                      {t('settings.memory.indexes.volume', {
                        documents: index.stats.documents,
                        chunks: index.stats.chunks,
                      })}
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">
                      {formatDateTime(index.updatedAt, locale)}
                    </td>
                    <td className="py-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRebuildIndex(index)}
                          disabled={providerInactive || mutating || index.state === 'building'}
                          data-testid={`memory-index-rebuild-${index.id}`}
                        >
                          <Icon name="refresh" className="size-3.5" />
                          {t('settings.memory.indexes.rebuild')}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void handleDeleteIndex(index)}
                          disabled={providerInactive || mutating}
                          data-testid={`memory-index-remove-${index.id}`}
                        >
                          <Icon name="delete-bin" className="size-3.5" />
                          {t('settings.memory.indexes.remove')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {indexes?.items
          .filter((index) => index.state === 'failed' && index.error)
          .map((index) => (
            <p
              key={index.id}
              data-testid={`memory-index-error-${index.id}`}
              className="text-xs text-destructive break-words"
            >
              {t('settings.memory.indexes.error.hint')}: {index.error}
            </p>
          ))}
      </SettingsSection>
    </SettingsPanel>
  )
}
