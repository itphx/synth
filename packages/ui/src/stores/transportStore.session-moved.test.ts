import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useSessionsStore } from './sessionsStore'
import { useProjectsStore } from './projectsStore'
import { useFilesStore } from './filesStore'
import { synthApi } from '@/lib/api/synthApi'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

describe('transportStore dispatcher: session.moved (ADR-040)', () => {
  let loadSpy: ReturnType<typeof vi.spyOn>
  let refreshSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    useSessionsStore.setState({ sessions: [{ id: 's1', project_id: 'p0' } as never] })
    loadSpy = vi.spyOn(useProjectsStore.getState(), 'loadProjects').mockImplementation(async () => {})
    refreshSpy = vi.spyOn(useFilesStore.getState(), 'refreshProject').mockImplementation(async () => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('патчит project_id сессии, перечитывает сессию, проекты и дерево Files', () => {
    dispatch(makeEvent('session.moved', 's1', { session_id: 's1', project_id: 'p1' }))

    const patched = useSessionsStore.getState().sessions.find((s) => s.id === 's1')
    expect(patched!.project_id).toBe('p1')
    expect(synthApi.getSession).toHaveBeenCalledWith('s1')
    expect(loadSpy).toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalledWith('p1')
  })

  it('отвязка от проекта (project_id=null): project_id сброшен, дерево не трогаем', () => {
    dispatch(makeEvent('session.moved', 's1', { session_id: 's1', project_id: null }))

    const patched = useSessionsStore.getState().sessions.find((s) => s.id === 's1')
    expect(patched!.project_id).toBeNull()
    expect(loadSpy).toHaveBeenCalled()
    expect(refreshSpy).not.toHaveBeenCalled()
  })
})
