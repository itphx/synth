import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listProcesses: vi.fn(),
  listProcessesWithBlocking: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listProcesses: mocks.listProcesses,
    listProcessesWithBlocking: mocks.listProcessesWithBlocking,
  },
}))

import { useProcessesStore, runningCount, bySession, processLogKey } from './processesStore'
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
    // `load` запрашивает реестр вместе с блокирующими: по умолчанию блокирующих
    // нет, а фоновые записи берутся из прежнего мока.
    mocks.listProcesses.mockResolvedValue([])
    mocks.listProcessesWithBlocking.mockImplementation(async (opts?: unknown) => ({
      runs: await mocks.listProcesses(opts),
      blocking: [],
    }))
    useProcessesStore.setState({
      byId: {},
      order: [],
      blocking: [],
      blockingLoaded: false,
      blockingScope: null,
      blockingScopeKey: null,
      blockingKnownIds: [],
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

  it('load с фильтром по сессии не трогает записи других сессий', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('s1-run', { sessionId: 's1' })])
    useProcessesStore.getState().upsert(makeRun('s2-run', { sessionId: 's2' }))
    useProcessesStore.getState().upsert(makeRun('s1-stale', { sessionId: 's1' }))

    await useProcessesStore.getState().load({ sessionId: 's1' })

    const state = useProcessesStore.getState()
    // Запись чужой сессии на месте — от неё зависят значки активности в дереве.
    expect(state.byId['s2-run']).toBeDefined()
    // Своя сессия — чистится по ответу.
    expect(state.byId['s1-stale']).toBeUndefined()
    expect(state.byId['s1-run']).toBeDefined()
  })

  it('load с фильтром по проекту не трогает чужие проекты и записи без проекта', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('p1-run', { projectId: 'p1' })])
    useProcessesStore.getState().upsert(makeRun('p9-run', { projectId: 'p9' }))
    // Пришёл только live-событием — проекта у записи нет.
    useProcessesStore.getState().upsert(makeRun('no-project'))
    useProcessesStore.getState().upsert(makeRun('p1-stale', { projectId: 'p1' }))

    await useProcessesStore.getState().load({ projectId: 'p1' })

    const state = useProcessesStore.getState()
    expect(state.byId['p9-run']).toBeDefined()
    expect(state.byId['no-project']).toBeDefined()
    expect(state.byId['p1-stale']).toBeUndefined()
    expect(state.byId['p1-run']).toBeDefined()
  })

  it('load без фильтров по-прежнему чистит всё лишнее', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('keep')])
    useProcessesStore.getState().upsert(makeRun('stale', { sessionId: 's2', projectId: 'p2' }))

    await useProcessesStore.getState().load()

    expect(useProcessesStore.getState().byId['stale']).toBeUndefined()
  })

  it('load сохраняет ошибку в сторе', async () => {
    mocks.listProcesses.mockRejectedValue(new Error('boom'))

    await useProcessesStore.getState().load()

    expect(useProcessesStore.getState().error).toBe('boom')
  })

  it('loadActive просит только активные прогоны и наполняет реестр', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('active')])

    await useProcessesStore.getState().loadActive()

    expect(mocks.listProcesses).toHaveBeenCalledWith({ status: 'running', limit: 200 })
    expect(useProcessesStore.getState().byId['active']).toBeDefined()
  })

  it('loadActive не удаляет терминальные записи', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('active')])
    useProcessesStore.getState().upsert(makeRun('done', { status: 'completed' }))

    await useProcessesStore.getState().loadActive()

    const state = useProcessesStore.getState()
    expect(state.byId['done']).toBeDefined()
    expect(state.byId['active']).toBeDefined()
  })

  it('loadActive убирает «running»-записи, которых больше нет в ответе', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('active')])
    useProcessesStore.getState().upsert(makeRun('stale'))

    await useProcessesStore.getState().loadActive()

    const state = useProcessesStore.getState()
    expect(state.byId['stale']).toBeUndefined()
    expect(state.byId['active']).toBeDefined()
  })

  it('loadActive не трогает запись, пришедшую из live-события (pendingIds)', async () => {
    mocks.listProcesses.mockResolvedValue([])
    useProcessesStore.getState().applyEvent('process.started', {
      background_run_id: 'event',
      session_id: 's1',
    })

    await useProcessesStore.getState().loadActive()

    expect(useProcessesStore.getState().byId['event']).toBeDefined()
  })

  it('loadActive сохраняет ошибку в сторе', async () => {
    mocks.listProcesses.mockRejectedValue(new Error('boom'))

    await useProcessesStore.getState().loadActive()

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

  it('remove убирает запись и её логи (все потоки)', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('bgr_1'))
    store.mergeLog('bgr_1', 'combined', { content: 'строка', offset: 0 })
    store.mergeLog('bgr_1', 'stdout', { content: 'stdout', offset: 0 })
    store.mergeLog('bgr_1', 'stderr', { content: 'stderr', offset: 0 })
    store.remove('bgr_1')

    const state = useProcessesStore.getState()
    expect(state.byId['bgr_1']).toBeUndefined()
    expect(state.logs[processLogKey('bgr_1', 'combined')]).toBeUndefined()
    expect(state.logs[processLogKey('bgr_1', 'stdout')]).toBeUndefined()
    expect(state.logs[processLogKey('bgr_1', 'stderr')]).toBeUndefined()
    expect(state.order).toEqual([])
  })

  it('remove не трогает логи другого прогона', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('bgr_1'))
    store.upsert(makeRun('bgr_2'))
    store.mergeLog('bgr_1', 'combined', { content: 'один', offset: 0 })
    store.mergeLog('bgr_2', 'combined', { content: 'два', offset: 0 })
    store.remove('bgr_1')

    const state = useProcessesStore.getState()
    expect(state.logs[processLogKey('bgr_1', 'combined')]).toBeUndefined()
    expect(state.logs[processLogKey('bgr_2', 'combined')]?.content).toBe('два')
  })

  it('clear очищает реестр целиком', () => {
    const store = useProcessesStore.getState()
    store.upsert(makeRun('bgr_1'))
    store.mergeLog('bgr_1', 'combined', { content: 'строка', offset: 0 })
    store.clear()

    const state = useProcessesStore.getState()
    expect(state.byId).toEqual({})
    expect(state.order).toEqual([])
    expect(state.logs).toEqual({})
  })

  it('mergeLog накапливает отрезки лога', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', 'combined', { content: 'первая\n', offset: 0, nextOffset: 7 })
    store.mergeLog('bgr_1', 'combined', { content: 'вторая\n', offset: 7, nextOffset: 14 })

    const log = useProcessesStore.getState().logs[processLogKey('bgr_1', 'combined')]!
    expect(log.content).toBe('первая\nвторая\n')
    expect(log.offset).toBe(14)
  })

  it('mergeLog не дублирует уже полученный отрезок', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', 'combined', { content: 'строка\n', offset: 0, nextOffset: 7 })
    store.mergeLog('bgr_1', 'combined', { content: 'строка\n', offset: 0, nextOffset: 7 })

    expect(useProcessesStore.getState().logs[processLogKey('bgr_1', 'combined')]!.content).toBe('строка\n')
  })

  it('mergeLog с offset 0 перезагружает лог целиком', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', 'combined', { content: 'старое\n', offset: 0, nextOffset: 7 })
    store.mergeLog('bgr_1', 'combined', { content: 'новое\n', offset: 0, nextOffset: 6 })

    expect(useProcessesStore.getState().logs[processLogKey('bgr_1', 'combined')]!.content).toBe('новое\n')
  })

  it('логи разных потоков не смешиваются', () => {
    const store = useProcessesStore.getState()
    store.mergeLog('bgr_1', 'combined', { content: 'общий\n', offset: 0 })
    store.mergeLog('bgr_1', 'stdout', { content: 'out\n', offset: 0 })
    store.mergeLog('bgr_1', 'stderr', { content: 'err\n', offset: 0 })

    const logs = useProcessesStore.getState().logs
    expect(logs[processLogKey('bgr_1', 'combined')]!.content).toBe('общий\n')
    expect(logs[processLogKey('bgr_1', 'stdout')]!.content).toBe('out\n')
    expect(logs[processLogKey('bgr_1', 'stderr')]!.content).toBe('err\n')
  })

  it('processLogKey различает прогоны и потоки', () => {
    expect(processLogKey('bgr_1', 'combined')).toBe('bgr_1:combined')
    expect(processLogKey('bgr_1', 'stdout')).toBe('bgr_1:stdout')
    expect(processLogKey('bgr_2', 'combined')).toBe('bgr_2:combined')
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

  it('load наполняет blocking в порядке сервера и помечает снимок загруженным', async () => {
    mocks.listProcessesWithBlocking.mockResolvedValue({
      runs: [makeRun('run')],
      blocking: [
        { id: 'blk_2', kind: 'process', sessionId: 's1', title: 'npm test' },
        { id: 'blk_1', kind: 'subagent', sessionId: 's1', title: 'аудит' },
      ],
    })

    await useProcessesStore.getState().load({ sessionId: 's1' })

    const state = useProcessesStore.getState()
    expect(mocks.listProcessesWithBlocking).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(state.blocking.map((run) => run.id)).toEqual(['blk_2', 'blk_1'])
    expect(state.blockingLoaded).toBe(true)
  })

  it('load чистит блокирующие только своего скоупа', async () => {
    useProcessesStore.setState({
      blocking: [
        { id: 's1-stale', kind: 'process', sessionId: 's1' },
        { id: 's2-run', kind: 'process', sessionId: 's2' },
      ],
      blockingLoaded: true,
      blockingScope: { sessionId: 's1' },
      blockingScopeKey: 'session:s1',
      blockingKnownIds: ['s1-stale'],
    })
    mocks.listProcessesWithBlocking.mockResolvedValue({ runs: [], blocking: [] })

    await useProcessesStore.getState().load({ sessionId: 's1' })

    const ids = useProcessesStore.getState().blocking.map((run) => run.id)
    expect(ids).toEqual(['s2-run'])
  })

  it('refreshBlocking перечитывает последний скоуп', async () => {
    mocks.listProcessesWithBlocking.mockResolvedValue({
      runs: [],
      blocking: [{ id: 'blk_1', kind: 'process', sessionId: 's1' }],
    })
    useProcessesStore.setState({ blockingLoaded: true, blockingScope: { sessionId: 's1' } })

    await useProcessesStore.getState().refreshBlocking()

    expect(mocks.listProcessesWithBlocking).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(useProcessesStore.getState().blocking.map((run) => run.id)).toEqual(['blk_1'])
  })

  it('applyEvent process.detached сохраняет вид прогона и дочернюю сессию', () => {
    useProcessesStore.getState().applyEvent('process.detached', {
      session_id: 's1',
      kind: 'subagent',
      id: 'child-1',
      child_session_id: 'child-1',
      background_run_id: 'bgr_1',
    })

    const run = useProcessesStore.getState().byId['bgr_1']
    expect(run).toMatchObject({ kind: 'subagent', childSessionId: 'child-1', status: 'running' })
  })
})
