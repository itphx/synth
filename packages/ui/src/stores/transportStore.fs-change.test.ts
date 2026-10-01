import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useFilesStore } from './filesStore'
import { useSessionsStore } from './sessionsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

describe('transportStore dispatcher: fs.changed / project.updated', () => {
  let scheduleSpy: ReturnType<typeof vi.spyOn>
  let refreshSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useSessionsStore.setState({ sessions: [] })
    const state = useFilesStore.getState()
    scheduleSpy = vi.spyOn(state, 'scheduleRefresh').mockImplementation(() => {})
    refreshSpy = vi.spyOn(state, 'refreshProject').mockImplementation(async () => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fs.changed вызывает scheduleRefresh с project_id из payload', () => {
    dispatch(makeEvent('fs.changed', 's1', {
      session_id: 's1',
      project_id: 'p1',
      scope: 'file',
      paths: ['a.txt'],
      tool: 'write_file',
    }))
    expect(scheduleSpy).toHaveBeenCalledWith('p1', {
      scope: 'file',
      paths: ['a.txt'],
      workspaceChanged: false,
      op: undefined,
    })
  })

  it('fs.changed пробрасывает op в scheduleRefresh', () => {
    dispatch(makeEvent('fs.changed', 's1', {
      session_id: 's1',
      project_id: 'p1',
      scope: 'file',
      paths: ['a.txt'],
      op: 'delete',
      tool: 'delete_file',
    }))
    expect(scheduleSpy).toHaveBeenCalledWith('p1', {
      scope: 'file',
      paths: ['a.txt'],
      workspaceChanged: false,
      op: 'delete',
    })
  })

  it('fs.changed с некорректным op не пробрасывает его', () => {
    dispatch(makeEvent('fs.changed', 's1', {
      session_id: 's1',
      project_id: 'p1',
      scope: 'file',
      paths: ['a.txt'],
      op: 'bogus',
      tool: 'write_file',
    }))
    expect(scheduleSpy).toHaveBeenCalledWith('p1', {
      scope: 'file',
      paths: ['a.txt'],
      workspaceChanged: false,
      op: undefined,
    })
  })

  it('fs.changed без project_id — fallback на проект сессии', () => {
    useSessionsStore.setState({ sessions: [{ id: 's1', project_id: 'p2' } as never] })
    dispatch(makeEvent('fs.changed', 's1', {
      session_id: 's1',
      project_id: null,
      scope: 'all',
      tool: 'execute_shell',
    }))
    expect(scheduleSpy).toHaveBeenCalledWith('p2', {
      scope: 'all',
      paths: undefined,
      workspaceChanged: false,
      op: undefined,
    })
  })

  it('fs.changed без проекта — событие не инвалидирует дерево', () => {
    dispatch(makeEvent('fs.changed', 's1', {
      session_id: 's1',
      project_id: null,
      scope: 'all',
      tool: 'task',
    }))
    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('fs.changed с workspace_changed пробрасывает флаг', () => {
    dispatch(makeEvent('fs.changed', 's1', {
      session_id: 's1',
      project_id: 'p1',
      scope: 'all',
      workspace_changed: true,
      tool: 'project_workspace_set',
    }))
    expect(scheduleSpy).toHaveBeenCalledWith('p1', {
      scope: 'all',
      paths: undefined,
      workspaceChanged: true,
      op: undefined,
    })
  })

  it('project.updated перечитывает дерево Files', () => {
    dispatch(makeEvent('project.updated', 's1', { project_id: 'p1' }))
    expect(refreshSpy).toHaveBeenCalledWith('p1')
  })
})
