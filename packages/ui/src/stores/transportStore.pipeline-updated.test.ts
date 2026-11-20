/**
 * Диспетчер транспорта: событие шины `pipeline.updated` (ADR-101 авторство ×
 * ADR-118, инвариант 27).
 *
 * Баг: «пайплайн создан/удалён из чата или в другом окне — вкладка
 * „Пайплайны“ показывает старый состав, пока не перезагрузишь страницу».
 * Событие авторства публикуется в каналы **сессий проекта** и обязано
 * инвалидировать ровно этот проект (`pipelinesStore.invalidateProject`).
 *
 * Регресс: ветка-префикс `pipeline.*` была сужена до `pipeline.run.*`
 * (плюс `pipeline.completed`) — иначе `pipeline.updated` съедался бы ею и уходил
 * в `applyRunEvent` (где у него нет `runId`), а список оставался устаревшим.
 * Оба направления зафиксированы здесь: события прогона по-прежнему идут в
 * `applyRunEvent`, событие авторства — в инвалидацию проекта.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getProjectPipelinesPage: vi.fn(),
  getSession: vi.fn(),
  getProjects: vi.fn(),
  getProjectsPage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getProjectPipelinesPage: apiMocks.getProjectPipelinesPage,
    getSession: apiMocks.getSession,
    getProjects: apiMocks.getProjects,
    getProjectsPage: apiMocks.getProjectsPage,
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { usePipelinesStore } from './pipelinesStore'
import type { WSEvent } from '@/lib/api/transport'
import type { ProjectPipeline } from '@/lib/api/synthApi'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

/** Сводка пайплайна проекта. */
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

/** Страница пайплайнов проекта. */
function pipelinesPage(pipelines: ProjectPipeline[], nextOffset: number | null = null) {
  return { pipelines, total: pipelines.length, offset: 0, limit: 100, next_offset: nextOffset }
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMocks.getProjectPipelinesPage.mockResolvedValue(pipelinesPage([pipeline('pl1')]))
  usePipelinesStore.setState({
    pipelinesByProject: {
      p1: pipelinesPage([pipeline('pl1')]),
      p2: pipelinesPage([pipeline('pl2')]),
    },
    loadedProjects: new Set<string>(['p1', 'p2']),
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

describe('transportStore dispatcher: pipeline.updated', () => {
  it('инвалидирует проект из payload и перечитывает его список', async () => {
    dispatch(
      makeEvent('pipeline.updated', { pipelineId: 'pl1', projectId: 'p1', action: 'save' }, 'sess-1'),
    )

    await vi.waitFor(() => {
      expect(apiMocks.getProjectPipelinesPage).toHaveBeenCalledWith('p1', { limit: 100 })
    })
    // Событие авторства не уходит в обработчик прогонов (у него нет `runId`).
    expect(usePipelinesStore.getState().runSignal).toEqual({})
  })

  it('не трогает другие проекты: чужой остаётся загруженным, запроса к нему нет', async () => {
    dispatch(
      makeEvent(
        'pipeline.updated',
        { pipelineId: 'pl1', projectId: 'p1', action: 'delete' },
        'sess-1',
      ),
    )

    await vi.waitFor(() => {
      expect(apiMocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)
    })
    expect(usePipelinesStore.getState().loadedProjects.has('p2')).toBe(true)
    expect(usePipelinesStore.getState().pipelinesByProject.p2?.pipelines.map((p) => p.id)).toEqual([
      'pl2',
    ])
  })

  it('событие без `projectId` (или неизвестного проекта) ничего не инвалидирует', () => {
    dispatch(makeEvent('pipeline.updated', { pipelineId: 'pl1', action: 'save' }, 'sess-1'))
    // Проект `p3` ещё не открыт — инвалидация не должна тянуть его с сервера.
    dispatch(
      makeEvent('pipeline.updated', { pipelineId: 'pl3', projectId: 'p3', action: 'save' }, 'sess-1'),
    )

    expect(apiMocks.getProjectPipelinesPage).not.toHaveBeenCalled()
    expect([...usePipelinesStore.getState().loadedProjects].sort()).toEqual(['p1', 'p2'])
  })

  it('регресс: `pipeline.run.*` по-прежнему идёт в `applyRunEvent`', () => {
    dispatch(
      makeEvent('pipeline.run.started', { runId: 'run1', pipelineId: 'pl1', status: 'running' }),
    )
    dispatch(
      makeEvent('pipeline.run.finished', { runId: 'run2', pipelineId: 'pl1', status: 'done' }),
    )
    dispatch(makeEvent('pipeline.completed', { runId: 'run3', pipelineId: 'pl1', status: 'done' }))

    const state = usePipelinesStore.getState()
    expect(state.runSignal).toEqual({ run1: 1, run2: 1, run3: 1 })
    // События прогонов список пайплайнов не инвалидируют.
    expect(apiMocks.getProjectPipelinesPage).not.toHaveBeenCalled()
  })
})
