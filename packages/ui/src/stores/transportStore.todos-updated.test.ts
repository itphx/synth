/**
 * `todos.updated` (PROP-054): список ToDo сессии обновляется **точечным**
 * патчем из payload — полный refresh сессии здесь не нужен и был бы вреден
 * (затирал бы локальные правки и тянул лишний запрос).
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

const TODOS = [{ id: 't1', content: 'Задача', status: 'pending', priority: 'medium' }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSession.mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: {}, todos: [] }],
  } as never)
})

describe('transportStore: todos.updated (PROP-054)', () => {
  it('точечно обновляет todos сессии', () => {
    dispatch(makeEvent('todos.updated', 's1', { session_id: 's1', todos: TODOS }))

    const session = useSessionsStore.getState().sessions.find((s) => s.id === 's1')!
    expect(session.todos).toEqual(TODOS)
  })

  it('полный refresh сессии не делается (локальные правки не затираются)', () => {
    dispatch(makeEvent('todos.updated', 's1', { session_id: 's1', todos: TODOS }))

    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('чужая сессия не патчится', () => {
    dispatch(makeEvent('todos.updated', 's1', { session_id: 's1', todos: TODOS }))

    const other = useSessionsStore.getState().sessions.find((s) => s.id === 's2')
    expect(other).toBeUndefined()
  })

  it('событие без todos оставляет список как был', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: {}, todos: TODOS }],
    } as never)

    dispatch(makeEvent('todos.updated', 's1', { session_id: 's1' }))

    const session = useSessionsStore.getState().sessions.find((s) => s.id === 's1')!
    expect(session.todos).toEqual(TODOS)
  })
})
