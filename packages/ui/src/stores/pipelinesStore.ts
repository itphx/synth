// pipelinesStore: состояние пайплайнов проекта и прогонов (ADR-101, Э7).
//
// Хранит:
//   - пайплайны проектов (`pipelinesByProject`) — из `GET /projects/:id/pipelines`;
//   - прогоны пайплайна (`runsByPipeline`) — из `GET .../pipelines/:pid/runs`;
//   - детали открытого прогона с журналом (`runDetail`) — `GET /pipeline-runs/:runId`.
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
  ProjectPipeline,
} from '@/lib/api/synthApi'

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

interface PipelinesState {
  /** Пайплайны по id проекта. */
  pipelinesByProject: Record<string, ProjectPipeline[]>
  /** Проекты, для которых пайплайны уже загружены. */
  loadedProjects: Set<string>
  /** Проекты, для которых идёт загрузка. */
  loadingProjects: Set<string>
  /** Ошибка загрузки (текст). */
  error: string | null

  /** Прогоны по id пайплайна (свежие первыми — как отдаёт сервер). */
  runsByPipeline: Record<string, PipelineRunRecord[]>
  /** Детали прогонов с журналом. */
  runDetail: Record<string, PipelineRunDetail>
  /** Счётчик сигналов «перечитать прогон» (live-события). */
  runSignal: Record<string, number>

  loadProjectPipelines: (projectId: string, opts?: { force?: boolean }) => Promise<void>
  removePipeline: (projectId: string, pipelineId: string) => void
  loadPipelineRuns: (
    projectId: string,
    pipelineId: string,
    filter?: PipelineRunsFilter,
  ) => Promise<void>
  loadRun: (runId: string) => Promise<void>
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
  error: null,

  runsByPipeline: {},
  runDetail: {},
  runSignal: {},

  loadProjectPipelines: async (projectId, opts) => {
    const state = get()
    if (!opts?.force && state.loadedProjects.has(projectId)) return
    if (state.loadingProjects.has(projectId)) return

    set((s) => ({
      loadingProjects: new Set(s.loadingProjects).add(projectId),
      error: null,
    }))

    try {
      const pipelines = await synthApi.getProjectPipelines(projectId)
      set((s) => ({
        pipelinesByProject: { ...s.pipelinesByProject, [projectId]: pipelines },
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

  removePipeline: (projectId, pipelineId) => {
    set((s) => {
      const list = s.pipelinesByProject[projectId]
      if (!list) return {}
      return {
        pipelinesByProject: {
          ...s.pipelinesByProject,
          [projectId]: list.filter((p) => p.id !== pipelineId),
        },
      }
    })
  },

  loadPipelineRuns: async (projectId, pipelineId, filter) => {
    try {
      const runs = await synthApi.listPipelineRuns(projectId, pipelineId, filter)
      set((s) => ({ runsByPipeline: { ...s.runsByPipeline, [pipelineId]: runs } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  loadRun: async (runId) => {
    try {
      const detail = await synthApi.getPipelineRun(runId)
      set((s) => ({ runDetail: { ...s.runDetail, [runId]: detail } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  upsertRun: (run) => {
    set((s) => {
      const list = s.runsByPipeline[run.pipelineId] ?? []
      const idx = list.findIndex((r) => r.id === run.id)
      const next = idx >= 0
        ? list.map((r, i) => (i === idx ? { ...r, ...run } : r))
        : [run, ...list]
      const detail = s.runDetail[run.id]
      return {
        runsByPipeline: { ...s.runsByPipeline, [run.pipelineId]: next },
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
