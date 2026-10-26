import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    listProcesses: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useProcessesStore } from './processesStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string | undefined, data: Record<string, unknown>): WSEvent {
  return {
    type,
    ...(sessionId ? { session_id: sessionId } : {}),
    data,
  } as WSEvent
}

describe('transportStore dispatcher: process.*/child.* (реестр фоновых прогонов)', () => {
  beforeEach(() => {
    useProcessesStore.setState({
      byId: {},
      order: [],
      logs: {},
      pendingIds: [],
      error: null,
    })
  })

  it('process.started — создаёт запись фонового процесса', () => {
    dispatch(makeEvent('process.started', 's1', {
      background_run_id: 'bgr_1',
      process_id: 'proc_1',
      session_id: 's1',
      command: 'npm run build',
      cwd: '/work',
      pid: 99,
    }))

    const run = useProcessesStore.getState().byId['bgr_1']!
    expect(run.kind).toBe('process')
    expect(run.status).toBe('running')
    expect(run.command).toBe('npm run build')
    expect(run.cwd).toBe('/work')
  })

  it('process.exited — обновляет статус и код завершения', () => {
    dispatch(makeEvent('process.started', 's1', { background_run_id: 'bgr_1', session_id: 's1' }))
    dispatch(makeEvent('process.exited', 's1', {
      background_run_id: 'bgr_1',
      session_id: 's1',
      state: 'completed',
      exit_code: 0,
    }))

    const run = useProcessesStore.getState().byId['bgr_1']!
    expect(run.status).toBe('completed')
    expect(run.exitCode).toBe(0)
    expect(run.finishedAt).toBeDefined()
  })

  it('process.started без session_id в кадре — запись всё равно появляется', () => {
    dispatch(makeEvent('process.started', undefined, {
      background_run_id: 'bgr_1',
      session_id: 's1',
      command: 'sleep 5',
    }))

    expect(useProcessesStore.getState().byId['bgr_1']).toBeDefined()
  })

  it('child.completed — создаёт запись фонового саб-агента', () => {
    dispatch(makeEvent('child.completed', 's1', {
      background_run_id: 'bgr_2',
      child_session_id: 'child-1',
      parent_session_id: 's1',
      state: 'completed',
      description: 'Аудит',
    }))

    const run = useProcessesStore.getState().byId['bgr_2']!
    expect(run.kind).toBe('subagent')
    expect(run.status).toBe('completed')
    expect(run.childSessionId).toBe('child-1')
    expect(run.sessionId).toBe('s1')
  })

  it('child.failed — статус «ошибка»', () => {
    dispatch(makeEvent('child.failed', 's1', {
      background_run_id: 'bgr_3',
      child_session_id: 'child-2',
      parent_session_id: 's1',
    }))

    expect(useProcessesStore.getState().byId['bgr_3']!.status).toBe('failed')
  })

  it('child.cancelled — статус «остановлен»', () => {
    dispatch(makeEvent('child.cancelled', 's1', {
      background_run_id: 'bgr_4',
      child_session_id: 'child-3',
      parent_session_id: 's1',
    }))

    expect(useProcessesStore.getState().byId['bgr_4']!.status).toBe('cancelled')
  })

  it('чужие события не попадают в реестр фоновых прогонов', () => {
    dispatch(makeEvent('stream.chunk', 's1', { content: 'привет', stream_id: 'st1' }))

    expect(useProcessesStore.getState().order).toEqual([])
  })
})
