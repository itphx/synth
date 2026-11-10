import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePermissionStore, type PermissionRequest } from './permissionStore'

function makeRequest(approvalId: string, toolName = 'read_file', timeoutMs = 30_000) {
  return {
    approvalId,
    toolName,
    params: { path: '/tmp/x' },
    reason: 'test',
    askedAt: new Date().toISOString(),
    timeoutMs,
  }
}

describe('permissionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePermissionStore.setState({ requestsBySession: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('добавляет запросы в очередь, текущий — первый', () => {
    const store = usePermissionStore.getState()
    store.addRequest('s1', makeRequest('a1', 'read_file'))
    store.addRequest('s1', makeRequest('a2', 'write_file'))

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests).toHaveLength(2)
    expect(requests![0]!.approvalId).toBe('a1')
    expect(requests![1]!.approvalId).toBe('a2')
  })

  it('игнорирует дубликат approval_id', () => {
    const store = usePermissionStore.getState()
    store.addRequest('s1', makeRequest('a1'))
    store.addRequest('s1', makeRequest('a1', 'write_file'))

    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
  })

  it('убирает запрос по истечении таймаута', () => {
    const store = usePermissionStore.getState()
    store.addRequest('s1', makeRequest('a1', 'read_file', 1_000))

    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
    vi.advanceTimersByTime(1_001)
    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
  })

  it('timeoutMs=0 — запрос без авто-скрытия, живёт до ответа', () => {
    const store = usePermissionStore.getState()
    store.addRequest('s1', makeRequest('a1', 'read_file', 0))

    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
    // Даже спустя «большой» таймаут запрос не убирается автоматически
    vi.advanceTimersByTime(120_000)
    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
    // Убирается только явным removeRequest
    store.removeRequest('s1', 'a1')
    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
  })

  it('removeRequest переходит к следующему запросу и очищает таймер текущего', () => {
    const store = usePermissionStore.getState()
    store.addRequest('s1', makeRequest('a1', 'read_file', 30_000))
    store.addRequest('s1', makeRequest('a2', 'write_file', 30_000))

    store.removeRequest('s1', 'a1')

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests).toHaveLength(1)
    expect(requests![0]!.approvalId).toBe('a2')

    // Таймер a1 очищен, a2 ещё активен и сработает по своему таймауту
    vi.advanceTimersByTime(30_001)
    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
  })
})

describe('permissionStore.setAll (восстановление очереди с сервера)', () => {
  const NOW = Date.parse('2026-01-01T12:00:00.000Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    usePermissionStore.setState({ requestsBySession: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Запись снимка сервера: `askedAt` — момент публикации запроса. */
  function makeSnapshot(
    approvalId: string,
    overrides: Partial<PermissionRequest> = {},
  ): PermissionRequest {
    return {
      approvalId,
      toolName: 'read_file',
      params: { path: '/tmp/x' },
      reason: 'test',
      askedAt: new Date(NOW - 10_000).toISOString(),
      timeoutMs: 30_000,
      ...overrides,
    }
  }

  it('кладёт записи снимка в очередь', () => {
    usePermissionStore.getState().setAll('s1', [makeSnapshot('a1')])

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests).toHaveLength(1)
    expect(requests![0]!.approvalId).toBe('a1')
  })

  it('сливает снимок с локальными записями, которых в снимке нет', () => {
    // Локальный запрос пришёл событием `permission.asked`, но до сервера
    // ещё не дошёл — сохраняем, карточка не должна «прыгать».
    usePermissionStore.getState().addRequest('s1', makeSnapshot('local'))
    usePermissionStore.getState().setAll('s1', [makeSnapshot('a1')])

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests!.map((r) => r.approvalId)).toEqual(['a1', 'local'])
  })

  it('таймер ставится на остаток, а не на полный timeoutMs', () => {
    // Запрошено 30 с назад → осталось 20 с.
    usePermissionStore.getState().setAll('s1', [makeSnapshot('a1')])

    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
    vi.advanceTimersByTime(19_000)
    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
    vi.advanceTimersByTime(1_001)
    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
  })

  it('held-запрос живёт до ответа: таймер не ставится', () => {
    usePermissionStore.getState().setAll('s1', [makeSnapshot('a1', { held: true })])

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests).toHaveLength(1)
    expect(requests![0]!.held).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(usePermissionStore.getState().requestsBySession['s1']).toHaveLength(1)
  })

  it('истёкший запрос (остаток <= 0) не добавляется', () => {
    // Запрошено 30 с назад при сроке 30 с — срок вышел.
    usePermissionStore.getState().setAll('s1', [
      makeSnapshot('expired', { askedAt: new Date(NOW - 30_000).toISOString() }),
      makeSnapshot('a1'),
    ])

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests!.map((r) => r.approvalId)).toEqual(['a1'])
  })

  it('пустой снимок не трогает локальные записи (слияние)', () => {
    // Локальный запрос пришёл событием и ещё не попал в снимок — сохраняем.
    usePermissionStore.getState().addRequest('s1', makeSnapshot('local'))
    usePermissionStore.getState().setAll('s1', [])

    const requests = usePermissionStore.getState().requestsBySession['s1']
    expect(requests!.map((r) => r.approvalId)).toEqual(['local'])
  })

  it('таймер восстановленного запроса снимает карточку (сервер не шлёт permission.replied)', () => {
    usePermissionStore.getState().setAll('s1', [makeSnapshot('a1')])
    vi.advanceTimersByTime(20_001)

    expect(usePermissionStore.getState().requestsBySession['s1']).toBeUndefined()
  })
})
