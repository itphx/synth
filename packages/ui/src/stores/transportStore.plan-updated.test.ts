/**
 * `plan.updated` (PROP-054): план живёт в **проекте**, событие приходит в каналы
 * всех сессий проекта с payload `{ project_id, version }`.
 *
 * UI обязан перечитать **деталь** проекта (`getProject`), а не список:
 * список — сводки без `plan`, `loadProjects()` затирал бы открытую панель
 * «Проект» (PROP-054, «Дополнение 2026-11-07»).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getProject: vi.fn(),
  getProjectsPage: vi.fn(),
  getProjects: vi.fn(),
  listWorktrees: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher } from './transportStore'
import { useProjectsStore } from './projectsStore'
import { useSessionsStore } from './sessionsStore'
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
  useProjectsStore.setState({ projects: [], loading: false, error: null, total: 0, nextOffset: null, loadingMore: false })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: {} }],
  } as never)
})

describe('transportStore: plan.updated (PROP-054)', () => {
  it('перечитывает деталь проекта, а не список', () => {
    dispatch(makeEvent('plan.updated', 's1', { project_id: 'p1', version: 3 }))

    expect(mocks.getProject).toHaveBeenCalledWith('p1')
    expect(mocks.getProjectsPage).not.toHaveBeenCalled()
  })

  it('projectId берётся из сессии, если его нет в payload', () => {
    dispatch(makeEvent('plan.updated', 's1', { version: 3 }))

    expect(mocks.getProject).toHaveBeenCalledWith('p1')
  })

  it('plan.approved — только refresh сессии, деталь проекта не перечитывается', () => {
    dispatch(makeEvent('plan.approved', 's1', { project_id: 'p1' }))

    expect(mocks.getSession).toHaveBeenCalledWith('s1')
    expect(mocks.getProject).not.toHaveBeenCalled()
  })

  it('без проекта (сессия без проекта) деталь не запрашивается', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'S', project_id: null, settings: {} }],
    } as never)

    dispatch(makeEvent('plan.updated', 's1', { version: 3 }))

    expect(mocks.getProject).not.toHaveBeenCalled()
  })
})
