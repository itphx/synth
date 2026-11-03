/**
 * Пагинация пайплайнов проекта, прогонов и журнала прогона (ADR-101, B1):
 *   - `GET /projects/:id/pipelines` → `{pipelines, total, offset, limit, next_offset}`;
 *   - `GET .../pipelines/:pid/runs` → `{runs, offset, limit, next_offset}`;
 *   - `GET /pipeline-runs/:runId` → `{run, events, events_has_more, events_next_before}`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте useUIStore, а Node/vitest
// без --localstorage-file его не даёт — ставим заглушку до импорта стора.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  getProjectPipelines: vi.fn(),
  getProjectPipelinesPage: vi.fn(),
  listPipelineRuns: vi.fn(),
  listPipelineRunsPage: vi.fn(),
  getPipelineRun: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { usePipelinesStore } from './pipelinesStore'
import type { PipelineRunEvent, PipelineRunRecord, ProjectPipeline } from '@/lib/api/synthApi'

function pipeline(id: string): ProjectPipeline {
  return {
    id,
    name: id,
    scope: 'project',
    projectId: 'p1',
    draftVersion: 1,
    hasDraft: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T11:00:00.000Z',
  }
}

function run(id: string): PipelineRunRecord {
  return {
    id,
    pipelineId: 'pl1',
    version: 1,
    status: 'done',
    startedAt: '2026-10-20T12:00:00.000Z',
  }
}

function event(ts: string, type: string): PipelineRunEvent {
  return { runId: 'run1', ts, type: type as PipelineRunEvent['type'] }
}

/** Страница пайплайнов проекта — ответ `GET /projects/:id/pipelines`. */
function pipelinesPage(pipelines: ProjectPipeline[], nextOffset: number | null = null) {
  return { pipelines, total: pipelines.length, offset: 0, limit: 100, next_offset: nextOffset }
}

/** Страница прогонов — ответ `GET .../pipelines/:pid/runs`. */
function runsPage(runs: PipelineRunRecord[], nextOffset: number | null = null) {
  return { runs, offset: 0, limit: 100, next_offset: nextOffset }
}

beforeEach(() => {
  vi.clearAllMocks()
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
    loadingProjects: new Set<string>(),
    loadingMoreProjects: new Set<string>(),
    runsByPipeline: {},
    runsFilterByPipeline: {},
    loadingMoreRuns: new Set<string>(),
    runDetail: {},
    runError: {},
    runSignal: {},
    loadingOlderEvents: new Set<string>(),
    error: null,
  })
})

describe('pipelinesStore — страница пайплайнов проекта', () => {
  it('loadProjectPipelines берёт первую страницу и сохраняет курсор', async () => {
    mocks.getProjectPipelinesPage.mockResolvedValue(pipelinesPage([pipeline('pl1')], 1))

    await usePipelinesStore.getState().loadProjectPipelines('p1')

    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledWith('p1', { limit: 100 })
    const state = usePipelinesStore.getState()
    expect(state.pipelinesByProject.p1?.pipelines.map((p) => p.id)).toEqual(['pl1'])
    expect(state.pipelinesByProject.p1?.next_offset).toBe(1)
  })

  it('loadMorePipelines дописывает следующую страницу', async () => {
    mocks.getProjectPipelinesPage.mockResolvedValueOnce(pipelinesPage([pipeline('pl1')], 1))
    mocks.getProjectPipelinesPage.mockResolvedValueOnce(pipelinesPage([pipeline('pl2')], null))

    await usePipelinesStore.getState().loadProjectPipelines('p1')
    await usePipelinesStore.getState().loadMorePipelines('p1')

    expect(mocks.getProjectPipelinesPage).toHaveBeenLastCalledWith('p1', {
      limit: 100,
      offset: 1,
    })
    const state = usePipelinesStore.getState()
    expect(state.pipelinesByProject.p1?.pipelines.map((p) => p.id)).toEqual(['pl1', 'pl2'])
    expect(state.pipelinesByProject.p1?.next_offset).toBeNull()
    expect(state.loadingMoreProjects.size).toBe(0)
  })

  it('removePipeline убирает пайплайн из страницы', async () => {
    mocks.getProjectPipelinesPage.mockResolvedValue(pipelinesPage([pipeline('pl1'), pipeline('pl2')]))

    await usePipelinesStore.getState().loadProjectPipelines('p1')
    usePipelinesStore.getState().removePipeline('p1', 'pl1')

    expect(
      usePipelinesStore.getState().pipelinesByProject.p1?.pipelines.map((p) => p.id),
    ).toEqual(['pl2'])
  })
})

describe('pipelinesStore — страница прогонов пайплайна', () => {
  it('loadPipelineRuns берёт первую страницу и помнит фильтр', async () => {
    mocks.listPipelineRunsPage.mockResolvedValue(runsPage([run('run1')], 1))

    await usePipelinesStore.getState().loadPipelineRuns('p1', 'pl1', { status: 'done' })

    expect(mocks.listPipelineRunsPage).toHaveBeenCalledWith('p1', 'pl1', {
      limit: 100,
      status: 'done',
    })
    const state = usePipelinesStore.getState()
    expect(state.runsByPipeline.pl1?.runs.map((r) => r.id)).toEqual(['run1'])
    expect(state.runsFilterByPipeline.pl1).toEqual({ status: 'done' })
  })

  it('loadMorePipelineRuns дописывает страницу с тем же фильтром', async () => {
    mocks.listPipelineRunsPage.mockResolvedValueOnce(runsPage([run('run1')], 1))
    mocks.listPipelineRunsPage.mockResolvedValueOnce(runsPage([run('run2')], null))

    await usePipelinesStore.getState().loadPipelineRuns('p1', 'pl1', { status: 'done' })
    await usePipelinesStore.getState().loadMorePipelineRuns('p1', 'pl1')

    expect(mocks.listPipelineRunsPage).toHaveBeenLastCalledWith('p1', 'pl1', {
      limit: 100,
      status: 'done',
      offset: 1,
    })
    const state = usePipelinesStore.getState()
    expect(state.runsByPipeline.pl1?.runs.map((r) => r.id)).toEqual(['run1', 'run2'])
    expect(state.runsByPipeline.pl1?.next_offset).toBeNull()
  })
})

describe('pipelinesStore — постраничный журнал прогона', () => {
  it('loadRun кладёт последнюю страницу событий и курсор', async () => {
    mocks.getPipelineRun.mockResolvedValue({
      run: run('run1'),
      events: [event('2026-10-20T12:00:01.000Z', 'run.finished')],
      events_has_more: true,
      events_next_before: '2026-10-20T12:00:01.000Z',
    })

    await usePipelinesStore.getState().loadRun('run1')

    const detail = usePipelinesStore.getState().runDetail.run1
    expect(detail?.events).toHaveLength(1)
    expect(detail?.events_has_more).toBe(true)
    expect(detail?.events_next_before).toBe('2026-10-20T12:00:01.000Z')
  })

  it('loadOlderRunEvents дописывает старые события в начало журнала', async () => {
    mocks.getPipelineRun.mockResolvedValueOnce({
      run: run('run1'),
      events: [event('2026-10-20T12:00:02.000Z', 'run.finished')],
      events_has_more: true,
      events_next_before: '2026-10-20T12:00:02.000Z',
    })
    mocks.getPipelineRun.mockResolvedValueOnce({
      run: run('run1'),
      events: [event('2026-10-20T12:00:00.000Z', 'run.started')],
      events_has_more: false,
      events_next_before: null,
    })

    await usePipelinesStore.getState().loadRun('run1')
    await usePipelinesStore.getState().loadOlderRunEvents('run1')

    // Курсор уходит на сервер как `events_before`.
    expect(mocks.getPipelineRun).toHaveBeenLastCalledWith('run1', {
      eventsBefore: '2026-10-20T12:00:02.000Z',
    })
    const detail = usePipelinesStore.getState().runDetail.run1
    expect(detail?.events.map((e) => e.ts)).toEqual([
      '2026-10-20T12:00:00.000Z',
      '2026-10-20T12:00:02.000Z',
    ])
    expect(detail?.events_has_more).toBe(false)
    expect(detail?.events_next_before).toBeNull()
    expect(usePipelinesStore.getState().loadingOlderEvents.size).toBe(0)
  })

  it('живое обновление не теряет уже загруженные старые события', async () => {
    mocks.getPipelineRun.mockResolvedValueOnce({
      run: run('run1'),
      events: [event('2026-10-20T12:00:02.000Z', 'run.finished')],
      events_has_more: true,
      events_next_before: '2026-10-20T12:00:02.000Z',
    })
    mocks.getPipelineRun.mockResolvedValueOnce({
      run: run('run1'),
      events: [event('2026-10-20T12:00:00.000Z', 'run.started')],
      events_has_more: false,
      events_next_before: null,
    })
    mocks.getPipelineRun.mockResolvedValueOnce({
      run: run('run1'),
      events: [event('2026-10-20T12:00:02.000Z', 'run.finished')],
      events_has_more: true,
      events_next_before: '2026-10-20T12:00:02.000Z',
    })

    await usePipelinesStore.getState().loadRun('run1')
    await usePipelinesStore.getState().loadOlderRunEvents('run1')
    // Живое обновление перечитывает только последнюю страницу.
    await usePipelinesStore.getState().loadRun('run1')

    const detail = usePipelinesStore.getState().runDetail.run1
    expect(detail?.events.map((e) => e.ts)).toEqual([
      '2026-10-20T12:00:00.000Z',
      '2026-10-20T12:00:02.000Z',
    ])
    // Курсор и признак «есть ещё старше» остались от догруженной старой
    // страницы — свежий ответ (последняя страница) их не «омолодил».
    expect(detail?.events_next_before).toBeNull()
    expect(detail?.events_has_more).toBe(false)
  })
})
