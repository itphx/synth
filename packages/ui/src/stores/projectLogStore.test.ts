/**
 * Стор страницы журнала проекта (PROP-054).
 *
 * Журнал вынесен из детали проекта: источник — `GET /projects/:id/log`
 * (страница), live-обновление — событие `project.updated { kind: 'log' }`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getProjectLogPage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { useProjectLogStore, PROJECT_LOG_PAGE_LIMIT } from './projectLogStore'

function entry(id: string, text: string) {
  return {
    id,
    text,
    created_at: '2026-01-01T00:00:00.000Z',
    session_id: 's1',
    author: 'leader',
  }
}

function page(entries: ReturnType<typeof entry>[], nextOffset: number | null = null, total = entries.length) {
  return { entries, total, offset: 0, limit: PROJECT_LOG_PAGE_LIMIT, next_offset: nextOffset }
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectLogStore.setState({ byProject: {} })
})

describe('projectLogStore — страница журнала проекта', () => {
  it('refresh читает первую страницу журнала', async () => {
    mocks.getProjectLogPage.mockResolvedValue(page([entry('e1', 'Первая'), entry('e2', 'Вторая')]))

    await useProjectLogStore.getState().refresh('p1')

    expect(mocks.getProjectLogPage).toHaveBeenCalledWith('p1', { limit: PROJECT_LOG_PAGE_LIMIT, offset: 0 })
    const state = useProjectLogStore.getState().page('p1')!
    expect(state.entries.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(state.total).toBe(2)
    expect(state.loading).toBe(false)
  })

  it('refresh перезаписывает страницу (новые записи сверху)', async () => {
    mocks.getProjectLogPage.mockResolvedValueOnce(page([entry('e1', 'Первая')]))
    await useProjectLogStore.getState().refresh('p1')

    mocks.getProjectLogPage.mockResolvedValueOnce(page([entry('e2', 'Вторая'), entry('e1', 'Первая')]))
    await useProjectLogStore.getState().refresh('p1')

    const state = useProjectLogStore.getState().page('p1')!
    expect(state.entries.map((e) => e.id)).toEqual(['e2', 'e1'])
  })

  it('loadMore дописывает следующую страницу (дедуп по id)', async () => {
    mocks.getProjectLogPage.mockResolvedValueOnce(page([entry('e1', 'Первая')], 1, 2))
    await useProjectLogStore.getState().refresh('p1')

    mocks.getProjectLogPage.mockResolvedValueOnce({
      entries: [entry('e1', 'Первая'), entry('e2', 'Вторая')],
      total: 2,
      offset: 1,
      limit: PROJECT_LOG_PAGE_LIMIT,
      next_offset: null,
    })
    await useProjectLogStore.getState().loadMore('p1')

    expect(mocks.getProjectLogPage).toHaveBeenLastCalledWith('p1', {
      limit: PROJECT_LOG_PAGE_LIMIT,
      offset: 1,
    })
    const state = useProjectLogStore.getState().page('p1')!
    expect(state.entries.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('loadMore без курсора ничего не грузит', async () => {
    mocks.getProjectLogPage.mockResolvedValue(page([entry('e1', 'Первая')], null))
    await useProjectLogStore.getState().refresh('p1')
    mocks.getProjectLogPage.mockClear()

    await useProjectLogStore.getState().loadMore('p1')

    expect(mocks.getProjectLogPage).not.toHaveBeenCalled()
  })

  it('событие project.updated (kind=log) перечитывает страницу', async () => {
    mocks.getProjectLogPage.mockResolvedValue(page([entry('e1', 'Первая')]))
    await useProjectLogStore.getState().refresh('p1')
    mocks.getProjectLogPage.mockClear()

    useProjectLogStore.getState().applyEvent('project.updated', { project_id: 'p1', kind: 'log' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.getProjectLogPage).toHaveBeenCalledWith('p1', { limit: PROJECT_LOG_PAGE_LIMIT, offset: 0 })
  })

  it('событие другого kind журнал не трогает', async () => {
    useProjectLogStore.getState().applyEvent('project.updated', { project_id: 'p1', kind: 'invariants' })

    expect(mocks.getProjectLogPage).not.toHaveBeenCalled()
  })

  it('ошибка загрузки пишется в состояние, записи не теряются', async () => {
    mocks.getProjectLogPage.mockRejectedValueOnce(new Error('boom'))
    await useProjectLogStore.getState().refresh('p1')

    const state = useProjectLogStore.getState().page('p1')!
    expect(state.error).toBe('boom')
    expect(state.loading).toBe(false)
  })
})
