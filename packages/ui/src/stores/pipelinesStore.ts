// pipelinesStore: состояние пайплайнов проекта и прогонов (ADR-101, Э7).
//
// Хранит:
//   - страницы пайплайнов проектов (`pipelinesByProject`) — из
//     `GET /projects/:id/pipelines` (страница: `{pipelines, total, next_offset}`);
//   - страницы прогонов пайплайна (`runsByPipeline`) — из `GET .../pipelines/:pid/runs`;
//   - детали открытого прогона с журналом (`runDetail`) — `GET /pipeline-runs/:runId`;
//   - ошибка загрузки прогона (`runError`) — по id прогона, чтобы страница
//     прогона показала сообщение, а не «залипла» на индикаторе загрузки.
//
// Live-обновление: движок публикует `pipeline.run.*` в **инстансный** канал
// шины (ADR-101 §2.12.3, `docs/PIPELINES.md`); UI читает их через общий
// транспорт (`stores/transportStore.ts`) — второй WebSocket/EventSource не
// заводим (ADR-024). Диспетчер транспорта вызывает `applyRunEvent`:
//   - заголовок прогона обновляется сразу (статус/текущий узел);
//   - журнал (append-only, сервер — источник истины) перечитывается по
//     сигналу `runSignal[runId]` — компонент страницы прогона реагирует на него.

import { create } from 'zustand'

import { synthApi } from '@/lib/api/synthApi'
import type {
  PipelineRunDetail,
  PipelineRunEvent,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineRunsFilter,
  PipelineRunsPage,
  ProjectPipelinesPage,
} from '@/lib/api/synthApi'

/**
 * Размер страницы пайплайнов проекта.
 *
 * Совпадает с серверным дефолтом (`DEFAULT_PIPELINES_LIMIT` в core), но задаётся
 * явно: клиент не должен зависеть от серверного дефолта при смене версии.
 */
export const PROJECT_PIPELINES_PAGE_LIMIT = 100

/** Размер страницы списка прогонов пайплайна. */
export const PIPELINE_RUNS_PAGE_LIMIT = 100

/** Полезная нагрузка live-события прогона (`pipeline.run.*`). */
export interface PipelineRunEventPayload {
  runId?: string
  pipelineId?: string
  version?: number
  projectId?: string
  node?: string
  nodeKind?: string
  status?: string
  code?: string
  durationMs?: number
  triggerKind?: string
  gateKind?: string
  [key: string]: unknown
}

/** Статусы, при которых прогон ещё активен (можно отменять). */
export const ACTIVE_RUN_STATUSES: PipelineRunStatus[] = ['pending', 'running', 'awaiting_human']

/** Активен ли прогон (нужно для кнопки отмены). */
export function isRunActive(status: PipelineRunStatus | undefined): boolean {
  return !!status && ACTIVE_RUN_STATUSES.includes(status)
}

/** Ключ события журнала — для дедупликации страниц (метка времени + тип + payload). */
function runEventKey(event: PipelineRunEvent): string {
  return `${event.ts}|${event.type}|${JSON.stringify(event.payload ?? null)}`
}

/**
 * Объединение страниц журнала прогона: старые события + свежая страница.
 *
 * Порядок — по времени события (старые сверху), как отдаёт сервер. Дубли
 * (страница может пересечься с уже загруженной по границе метки времени)
 * отбрасываются.
 */
export function mergeRunEvents(
  existing: PipelineRunEvent[],
  incoming: PipelineRunEvent[],
): PipelineRunEvent[] {
  if (existing.length === 0) return [...incoming]
  if (incoming.length === 0) return [...existing]
  const seen = new Set(incoming.map(runEventKey))
  const kept = existing.filter((event) => !seen.has(runEventKey(event)))
  return [...kept, ...incoming].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

/** Метка времени самого старого события в списке (`null` — список пуст). */
function oldestEventTs(events: PipelineRunEvent[]): string | null {
  let oldest: string | null = null
  for (const event of events) {
    if (oldest === null || event.ts < oldest) oldest = event.ts
  }
  return oldest
}

interface PipelinesState {
  /** Страница пайплайнов по id проекта. */
  pipelinesByProject: Record<string, ProjectPipelinesPage>
  /** Проекты, для которых пайплайны уже загружены. */
  loadedProjects: Set<string>
  /** Проекты, для которых идёт загрузка. */
  loadingProjects: Set<string>
  /** Проекты, для которых идёт догрузка следующей страницы пайплайнов. */
  loadingMoreProjects: Set<string>
  /** Ошибка загрузки (текст). */
  error: string | null

  /** Страница прогонов по id пайплайна (свежие первыми — как отдаёт сервер). */
  runsByPipeline: Record<string, PipelineRunsPage>
  /** Фильтр выборки прогонов, применённый при последней загрузке (по id пайплайна). */
  runsFilterByPipeline: Record<string, PipelineRunsFilter>
  /** Пайплайны, для которых идёт догрузка следующей страницы прогонов. */
  loadingMoreRuns: Set<string>
  /** Детали прогонов с журналом. */
  runDetail: Record<string, PipelineRunDetail>
  /** Ошибка загрузки прогона — по id прогона (страница прогона показывает её вместо вечной загрузки). */
  runError: Record<string, string>
  /** Счётчик сигналов «перечитать прогон» (live-события). */
  runSignal: Record<string, number>
  /** Прогоны, для которых идёт догрузка старых событий журнала. */
  loadingOlderEvents: Set<string>

  loadProjectPipelines: (projectId: string, opts?: { force?: boolean }) => Promise<void>
  /** Догрузить следующую страницу пайплайнов проекта (кнопка «Показать ещё»). */
  loadMorePipelines: (projectId: string) => Promise<void>
  removePipeline: (projectId: string, pipelineId: string) => void
  loadPipelineRuns: (
    projectId: string,
    pipelineId: string,
    filter?: PipelineRunsFilter,
  ) => Promise<void>
  /** Догрузить следующую страницу прогонов пайплайна (кнопка «Показать ещё»). */
  loadMorePipelineRuns: (projectId: string, pipelineId: string) => Promise<void>
  loadRun: (runId: string) => Promise<void>
  /** Догрузить более старые события журнала прогона (кнопка «Загрузить старые события»). */
  loadOlderRunEvents: (runId: string) => Promise<void>
  upsertRun: (run: PipelineRunRecord) => void
  /** Live-событие прогона (`pipeline.run.*`) — обновить заголовок и сигнал. */
  applyRunEvent: (payload: PipelineRunEventPayload) => void
  /** Журнал прогона: события (append-only, сервер — источник истины). */
  appendRunEvent: (runId: string, event: PipelineRunEvent) => void
}

export const usePipelinesStore = create<PipelinesState>()((set, get) => ({
  pipelinesByProject: {},
  loadedProjects: new Set<string>(),
  loadingProjects: new Set<string>(),
  loadingMoreProjects: new Set<string>(),
  error: null,

  runsByPipeline: {},
  runsFilterByPipeline: {},
  loadingMoreRuns: new Set<string>(),
  runDetail: {},
  runError: {},
  runSignal: {},
  loadingOlderEvents: new Set<string>(),

  loadProjectPipelines: async (projectId, opts) => {
    const state = get()
    if (!opts?.force && state.loadedProjects.has(projectId)) return
    if (state.loadingProjects.has(projectId)) return

    set((s) => ({
      loadingProjects: new Set(s.loadingProjects).add(projectId),
      error: null,
    }))

    try {
      // Список пайплайнов пагинирован: грузим **первую** страницу.
      const page = await synthApi.getProjectPipelinesPage(projectId, {
        limit: PROJECT_PIPELINES_PAGE_LIMIT,
      })
      set((s) => ({
        pipelinesByProject: { ...s.pipelinesByProject, [projectId]: page },
        loadedProjects: new Set(s.loadedProjects).add(projectId),
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set((s) => {
        const next = new Set(s.loadingProjects)
        next.delete(projectId)
        return { loadingProjects: next }
      })
    }
  },

  /**
   * Догрузка следующей страницы пайплайнов проекта (кнопка «Показать ещё»).
   *
   * Страница **дописывается** к уже загруженной — раскрытие проекта и выбор
   * не сбрасываются.
   */
  loadMorePipelines: async (projectId) => {
    const state = get()
    const page = state.pipelinesByProject[projectId]
    if (!page || page.next_offset === null) return
    if (state.loadingMoreProjects.has(projectId)) return

    set((s) => ({ loadingMoreProjects: new Set(s.loadingMoreProjects).add(projectId) }))
    try {
      const next = await synthApi.getProjectPipelinesPage(projectId, {
        limit: PROJECT_PIPELINES_PAGE_LIMIT,
        offset: page.next_offset,
      })
      set((s) => {
        const current = s.pipelinesByProject[projectId]
        if (!current) return {}
        const seen = new Set(current.pipelines.map((p) => p.id))
        const incoming = (next.pipelines ?? []).filter((p) => !seen.has(p.id))
        return {
          pipelinesByProject: {
            ...s.pipelinesByProject,
            [projectId]: {
              ...next,
              pipelines: [...current.pipelines, ...incoming],
            },
          },
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set((s) => {
        const loading = new Set(s.loadingMoreProjects)
        loading.delete(projectId)
        return { loadingMoreProjects: loading }
      })
    }
  },

  removePipeline: (projectId, pipelineId) => {
    set((s) => {
      const page = s.pipelinesByProject[projectId]
      if (!page) return {}
      return {
        pipelinesByProject: {
          ...s.pipelinesByProject,
          [projectId]: {
            ...page,
            pipelines: page.pipelines.filter((p) => p.id !== pipelineId),
          },
        },
      }
    })
  },

  loadPipelineRuns: async (projectId, pipelineId, filter) => {
    try {
      const page = await synthApi.listPipelineRunsPage(projectId, pipelineId, {
        limit: PIPELINE_RUNS_PAGE_LIMIT,
        ...(filter?.status ? { status: filter.status } : {}),
      })
      set((s) => ({
        runsByPipeline: { ...s.runsByPipeline, [pipelineId]: page },
        runsFilterByPipeline: { ...s.runsFilterByPipeline, [pipelineId]: filter ?? {} },
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  /** Догрузка следующей страницы прогонов пайплайна (кнопка «Показать ещё»). */
  loadMorePipelineRuns: async (projectId, pipelineId) => {
    const state = get()
    const page = state.runsByPipeline[pipelineId]
    if (!page || page.next_offset === null) return
    if (state.loadingMoreRuns.has(pipelineId)) return

    set((s) => ({ loadingMoreRuns: new Set(s.loadingMoreRuns).add(pipelineId) }))
    try {
      const filter = state.runsFilterByPipeline[pipelineId] ?? {}
      const next = await synthApi.listPipelineRunsPage(projectId, pipelineId, {
        limit: PIPELINE_RUNS_PAGE_LIMIT,
        ...(filter.status ? { status: filter.status } : {}),
        offset: page.next_offset,
      })
      set((s) => {
        const current = s.runsByPipeline[pipelineId]
        if (!current) return {}
        const seen = new Set(current.runs.map((r) => r.id))
        const incoming = (next.runs ?? []).filter((r) => !seen.has(r.id))
        return {
          runsByPipeline: {
            ...s.runsByPipeline,
            [pipelineId]: { ...next, runs: [...current.runs, ...incoming] },
          },
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set((s) => {
        const loading = new Set(s.loadingMoreRuns)
        loading.delete(pipelineId)
        return { loadingMoreRuns: loading }
      })
    }
  },

  loadRun: async (runId) => {
    try {
      const detail = await synthApi.getPipelineRun(runId)
      set((s) => {
        // Ошибка прогона снимается — деталь снова актуальна.
        const runError = { ...s.runError }
        delete runError[runId]
        const prev = s.runDetail[runId]
        if (!prev) {
          return { runDetail: { ...s.runDetail, [runId]: detail }, runError }
        }
        // Уже загруженные старые события не теряются: живое обновление
        // перечитывает только последнюю страницу журнала.
        const events = mergeRunEvents(prev.events, detail.events ?? [])
        // Курсор «ещё старше» — от самой старой загруженной страницы: если раньше
        // догружали старые события, свежий ответ (последняя страница) «омолодил»
        // бы курсор и потерял доступ к более старым событиям.
        const prevOldest = oldestEventTs(prev.events)
        const freshOldest = oldestEventTs(detail.events ?? [])
        const keepPrev =
          prevOldest !== null && freshOldest !== null && prevOldest < freshOldest
        return {
          runDetail: {
            ...s.runDetail,
            [runId]: {
              ...detail,
              events,
              events_has_more: keepPrev
                ? (prev.events_has_more ?? false)
                : (detail.events_has_more ?? false),
              events_next_before: keepPrev
                ? (prev.events_next_before ?? null)
                : (detail.events_next_before ?? null),
            },
          },
          runError,
        }
      })
    } catch (err) {
      // Ошибка хранится по id прогона: страница прогона показывает её вместо
      // бесконечной загрузки (прогон удалён/нет доступа — 404/403).
      set((s) => ({
        error: err instanceof Error ? err.message : String(err),
        runError: { ...s.runError, [runId]: err instanceof Error ? err.message : String(err) },
      }))
    }
  },

  /**
   * Догрузка более старых событий журнала прогона.
   *
   * Курсор — `events_next_before` предыдущей страницы (метка времени самого
   * старого события). События **дописываются в начало** журнала.
   */
  loadOlderRunEvents: async (runId) => {
    const state = get()
    const detail = state.runDetail[runId]
    const before = detail?.events_next_before
    if (!detail || !before) return
    if (state.loadingOlderEvents.has(runId)) return

    set((s) => ({ loadingOlderEvents: new Set(s.loadingOlderEvents).add(runId) }))
    try {
      const page = await synthApi.getPipelineRun(runId, { eventsBefore: before })
      set((s) => {
        const current = s.runDetail[runId]
        if (!current) return {}
        return {
          runDetail: {
            ...s.runDetail,
            [runId]: {
              ...current,
              events: mergeRunEvents(current.events, page.events ?? []),
              events_has_more: page.events_has_more,
              events_next_before: page.events_next_before ?? null,
            },
          },
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set((s) => {
        const loading = new Set(s.loadingOlderEvents)
        loading.delete(runId)
        return { loadingOlderEvents: loading }
      })
    }
  },

  upsertRun: (run) => {
    set((s) => {
      const page = s.runsByPipeline[run.pipelineId]
      const list = page?.runs ?? []
      const idx = list.findIndex((r) => r.id === run.id)
      const nextRuns = idx >= 0
        ? list.map((r, i) => (i === idx ? { ...r, ...run } : r))
        : [run, ...list]
      const detail = s.runDetail[run.id]
      return {
        runsByPipeline: page
          ? { ...s.runsByPipeline, [run.pipelineId]: { ...page, runs: nextRuns } }
          : s.runsByPipeline,
        runDetail: detail
          ? { ...s.runDetail, [run.id]: { ...detail, run: { ...detail.run, ...run } } }
          : s.runDetail,
      }
    })
  },

  applyRunEvent: (payload) => {
    const runId = typeof payload.runId === 'string' ? payload.runId : undefined
    if (!runId) return

    set((s) => {
      const detail = s.runDetail[runId]
      const patch: Partial<PipelineRunRecord> = {}

      if (typeof payload.status === 'string') {
        patch.status = payload.status as PipelineRunStatus
      }
      if (typeof payload.node === 'string') {
        patch.currentNode = payload.node
      }
      if (typeof payload.code === 'string') {
        patch.error = payload.code
      }

      const nextDetail = detail
        ? { ...detail, run: { ...detail.run, ...patch } }
        : detail

      return {
        runDetail: nextDetail ? { ...s.runDetail, [runId]: nextDetail } : s.runDetail,
        // Журнал перечитывается с сервера — он append-only и полон деталей
        // (payload, длительности), которых нет в live-событии.
        runSignal: { ...s.runSignal, [runId]: (s.runSignal[runId] ?? 0) + 1 },
      }
    })
  },

  appendRunEvent: (runId, event) => {
    set((s) => {
      const detail = s.runDetail[runId]
      if (!detail) return {}
      return {
        runDetail: {
          ...s.runDetail,
          [runId]: { ...detail, events: [...detail.events, event] },
        },
      }
    })
  },
}))
