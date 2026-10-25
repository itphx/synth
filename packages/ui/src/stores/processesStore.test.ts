import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listProcesses: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { listProcesses: mocks.listProcesses },
}))

import { useProcessesStore, runningCount, bySession } from './processesStore'
import type { BackgroundRunRecord } from '@/lib/api/synthApi'

function makeRun(id: string, overrides: Partial<BackgroundRunRecord> = {}): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 's1',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('processesStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProcessesStore.setState({
      byId: {},
      order: [],
      logs: {},
      pendingIds: [],
      error: null,
    })
  })

  it('load наполняет реестр и сортирует свежие первыми', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('old', { startedAt: '2026-09-01T00:00:00.000Z' }),
      makeRun('new', { startedAt: '2026-10-02T00:00:00.000Z' }),
    ])

    await useProcessesStore.getState().load()

    const state = useProcessesStore.getState()
    expect(mocks.listProcesses).toHaveBeenCalledTimes(1)
    expect(state.order).toEqual(['new', 'old'])
    expect(state.byId['new']!.id).toBe('new')
  })

  it('load не теряет запись, пришедшую из live-события (ещё нет в ответе сервера)', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('server')])
    useProcessesStore.getState().applyEvent('process.started', {
      background_run_id: 'event',
      session_id: 's1',
      command: 'sleep 10',
    })

    await useProcessesStore.getState().load()

    const state = useProcessesStore.getState()
    expect(state.byId['event']).toBeDefined()
    expect(state.byId['server']).toBeDefined()
  })

  it('load убирает записи, которых больше нет в ответе сервера', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('keep')])
    useProcessesStore.getState().upsert(makeRun('stale'))

    await useProcessesStore.getState().load()

    const state = useProcessesStore.getState()
    expect(state.byId['stale']).toBeUndefined()
    expect(state.byId['keep']).toBeDefined()
  })

  it('load сохраняет ошибку в сторе', async () => {
    mocks.listProcesses.mockRejectedValue(new Error('boom'))

    await useProcessesStore.getState().load()

    expect(useProcessesStore.getState().error).toBe('boom')
  })

  it('applyEvent process.started создаёт запись процесса', () => {
    useProcessesStore.getState().applyEvent('process.started', {
      background_run_id: 'bgr_1',
      process_id: 'proc_1',
      session_id: 's1',
      command: 'npm run dev',
      cwd: '/work',
      pid: 4242,
    })

    const run = useProcessesStore.getState().byId['bgr_1']!
    expect(run.kind).toBe('process')
    expect(run.status).toBe('running')
    expect(run.sessionId).toBe('s1')
    expect(run.command).toBe('npm run dev')
    expect(run.cwd).toBe('/work')
    expect(run.pid).toBe(4242)
  })

  it('applyEvent process.exited переводит запись в терминальный статус', () => {
    const store = useProcessesStore.getState()
    store.applyEvent('process.started', { background_run_id: 'bgr_1', session_id: 's1' })
    store.applyEvent('process.exited', {
      background_run_id: 'bgr_1',
      session_id: 's1',
      state: 'failed',
      exit_code: 2,
      signal: 'SIGTERM',
    })

    const run = useProcessesStore.getState().byId['bgr_1']!
    expect(run.status).toBe('failed')
    expect(run.exitCode).toBe(2)
    expect(run.signal).toBe('SIGTERM')
    expect(run.finishedAt).toBeDefined()
  })

  it('applyEvent process.stopped переводит запись в «остановлен»', () => {
    const store = useProcessesStore.getState()
    store.applyEvent('process.started', { background_run_id: 'bgr_1', session_id: 's1' })
    store.applyEvent('process.stopped', {
      background_run_id: 'bgr_1',
      session_id: 's1',
      state: 'cancelled',
    })

    expect(useProcessesStore.getState().byId['bgr_1']!.status).toBe('cancelled')
  })

  it('applyEvent child.completed создаёт запись саб-агента', () => {
    useProcessesStore.getState().applyEvent('child.completed', {
      background_run_id: 'bgr_2',
      child_session_id: 'child-1',
      parent_session_id: 's1',
      state: 'completed',
      description: 'Рефакторинг',
    })

    const run = useProcessesStore.getState().byId['bgr_2']!
    expect(run.kind).toBe('subagent')
    expect(run.status).toBe('completed')
    expect(run.childSessionId).toBe('child-1')
    expect(run.sessionId).toBe('s1')
    expect(run.description).toBe('Рефакторинг')
    expect(run.finishedAt).toBeDefined()
  })

  it('applyEvent child.failed ставит статус «ошибка»', () => {
    useProcessesStore.getState().applyEvent('child.failed', {
      background_run_id: 'bgr_3',
      child_session_id: 'child-2',
      parent_session_id: 's1',
    })

    expect(useProcessesStore.getState().byId['bgr_3']!.status).toBe('failed')
  })

  it('applyEvent игнорирует чужие события и события без id', () => {
    const store = useProcessesStore.getState()
    store.applyEvent('stream.chunk', { content: 'x' })
    store.applyEvent('process.started', { session_id: 's1' })

    expect(useProcessesStore.getState().order).toEqual([])
  })

  it('upsert обновляет существующую запись, не теряя поля', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('bgr_1', { command: 'a' }))
    store.upsert(makeRun('bgr_1', { status: 'completed', exitCode: 0 }))

    const run = useProcessesStore.getState().byId['bgr_1']!
    expect(run.status).toBe('completed')
    expect(run.exitCode).toBe(0)
    expect(run.command).toBe('a')
  })

  it('remove убирает запись и её лог', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('bgr_1'))
    store.mergeLog('bgr_1', { content: 'строка', offset: 0 })
    store.remove('bgr_1')

    const state = useProcessesStore.getState()
    expect(state.byId['bgr_1']).toBeUndefined()
    expect(state.logs['bgr_1']).toBeUndefined()
    expect(state.order).toEqual([])
  })

  it('clear очищает реестр целиком', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('bgr_1'))
    store.mergeLog('bgr_1', { content: 'строка', offset: 0 })
    store.clear()

    const state = useProcessesStore.getState()
    expect(state.byId).toEqual({})
    expect(state.order).toEqual([])
    expect(state.logs).toEqual({})
  })

  it('mergeLog накапливает отрезки лога', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', { content: 'первая\n', offset: 0, nextOffset: 7 })
    store.mergeLog('bgr_1', { content: 'вторая\n', offset: 7, nextOffset: 14 })

    const log = useProcessesStore.getState().logs['bgr_1']!
    expect(log.content).toBe('первая\nвторая\n')
    expect(log.offset).toBe(14)
  })

  it('mergeLog не дублирует уже полученный отрезок', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', { content: 'строка\n', offset: 0, nextOffset: 7 })
    store.mergeLog('bgr_1', { content: 'строка\n', offset: 0, nextOffset: 7 })

    expect(useProcessesStore.getState().logs['bgr_1']!.content).toBe('строка\n')
  })

  it('mergeLog с offset 0 перезагружает лог целиком', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', { content: 'старое\n', offset: 0, nextOffset: 7 })
    store.mergeLog('bgr_1', { content: 'новое\n', offset: 0, nextOffset: 6 })

    expect(useProcessesStore.getState().logs['bgr_1']!.content).toBe('новое\n')
  })

  it('runningCount считает только выполняющиеся прогоны', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('a'))
    store.upsert(makeRun('b', { status: 'completed' }))
    store.upsert(makeRun('c'))

    expect(runningCount(useProcessesStore.getState())).toBe(2)
  })

  it('bySession отдаёт прогоны сессии-владельца', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('a', { sessionId: 's1' }))
    store.upsert(makeRun('b', { sessionId: 's2' }))
    store.upsert(makeRun('c', { sessionId: 's1' }))

    const list = bySession(useProcessesStore.getState(), 's1')
    expect(list.map((run) => run.id).sort()).toEqual(['a', 'c'])
    expect(bySession(useProcessesStore.getState(), 'unknown')).toEqual([])
  })
})
