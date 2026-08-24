import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePermissionStore } from './permissionStore'

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
