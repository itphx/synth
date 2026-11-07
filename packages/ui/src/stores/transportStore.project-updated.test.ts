/**
 * `project.updated` (PROP-054): журнал и инварианты вынесены из детали проекта,
 * поэтому событие несёт `kind` (`log` | `invariants`).
 *
 * UI перечитывает **деталь** проекта (`getProject`), а не список: список —
 * сводки без `plan`, он затирал бы открытую панель «Проект». Журнал
 * обновляется отдельно — своей страницей (`GET /projects/:id/log`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) в filesStore/gitStore пишет в localStorage — заглушка.
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
  getSession: vi.fn(),
  getProject: vi.fn(),
  getProjectsPage: vi.fn(),
  getProjects: vi.fn(),
  getProjectLogPage: vi.fn(),
  listWorktrees: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useProjectsStore } from './projectsStore'
import { useSessionsStore } from './sessionsStore'
import { useProjectLogStore } from './projectLogStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string | undefined, data: Record<string, unknown>): WSEvent {
  return {
    type,
    ...(sessionId ? { session_id: sessionId } : {}),
    data,
  } as WSEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSession.mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] })
  mocks.getProject.mockResolvedValue({ id: 'p1', name: 'P', plan: { version: 3 } })
  mocks.getProjectsPage.mockResolvedValue({
    projects: [],
    total: 0,
    offset: 0,
    limit: 100,
    next_offset: null,
  })
  mocks.getProjectLogPage.mockResolvedValue({
    entries: [],
    total: 0,
    offset: 0,
    limit: 50,
    next_offset: null,
  })
  useProjectsStore.setState({ projects: [], loading: false, error: null, total: 0, nextOffset: null, loadingMore: false })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: {} }],
  } as never)
  useProjectLogStore.setState({ byProject: {} })
})

describe('transportStore: project.updated (PROP-054)', () => {
  it('перечитывает деталь проекта, а не список', () => {
    dispatch(makeEvent('project.updated', 's1', { project_id: 'p1' }))

    expect(mocks.getProject).toHaveBeenCalledWith('p1')
    expect(mocks.getProjectsPage).not.toHaveBeenCalled()
  })

  it('kind=log перечитывает страницу журнала', async () => {
    dispatch(makeEvent('project.updated', 's1', { project_id: 'p1', kind: 'log' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.getProjectLogPage).toHaveBeenCalledWith('p1', { limit: 50, offset: 0 })
  })

  it('kind=invariants перечитывает деталь проекта (инварианты — в детали)', () => {
    dispatch(makeEvent('project.updated', 's1', { project_id: 'p1', kind: 'invariants' }))

    expect(mocks.getProject).toHaveBeenCalledWith('p1')
  })

  it('без kind журнал не перечитывается', async () => {
    dispatch(makeEvent('project.updated', 's1', { project_id: 'p1' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.getProjectLogPage).not.toHaveBeenCalled()
  })

  it('событие без project_id ничего не делает', () => {
    dispatch(makeEvent('project.updated', 's1', {}))

    expect(mocks.getProject).not.toHaveBeenCalled()
  })
})
