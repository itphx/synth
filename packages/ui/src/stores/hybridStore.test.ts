import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getHybridStatus: vi.fn(),
  },
}))

import { useHybridStore } from './hybridStore'
import { synthApi } from '@/lib/api/synthApi'

const ENABLED_CONNECTED = {
  enabled: true,
  connected: true,
  backendUrl: 'https://backend.example',
  user: { id: 'u1', username: 'dev', roles: ['USER'] },
}

describe('hybridStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useHybridStore.getState().stopPolling()
    useHybridStore.setState({ enabled: false, connected: false, backendUrl: null, user: null, loading: false })
  })

  afterEach(() => {
    useHybridStore.getState().stopPolling()
    vi.useRealTimers()
  })

  it('loadStatus: гибрид включён и подключён → состояние из ответа', async () => {
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue(ENABLED_CONNECTED)

    await useHybridStore.getState().loadStatus()

    const s = useHybridStore.getState()
    expect(s.enabled).toBe(true)
    expect(s.connected).toBe(true)
    expect(s.backendUrl).toBe('https://backend.example')
    expect(s.user?.username).toBe('dev')
    expect(s.user?.roles).toEqual(['USER'])
  })

  it('loadStatus: гибрид выключен → сброс', async () => {
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue({ enabled: false, connected: false, backendUrl: null, user: null })

    await useHybridStore.getState().loadStatus()

    const s = useHybridStore.getState()
    expect(s.enabled).toBe(false)
    expect(s.connected).toBe(false)
    expect(s.backendUrl).toBeNull()
    expect(s.user).toBeNull()
  })

  it('loadStatus: ошибка эндпоинта → сброс (гибрид выключен), без проброса', async () => {
    vi.mocked(synthApi.getHybridStatus).mockRejectedValue(new Error('network down'))

    await useHybridStore.getState().loadStatus()

    const s = useHybridStore.getState()
    expect(s.enabled).toBe(false)
    expect(s.connected).toBe(false)
    expect(s.loading).toBe(false)
  })

  it('startPolling: сразу грузит статус, затем опрашивает по интервалу; stopPolling останавливает', async () => {
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue(ENABLED_CONNECTED)

    useHybridStore.getState().startPolling(1_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(5)

    useHybridStore.getState().stopPolling()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(5)
  })

  it('повторный startPolling не плодит интервалы (stopPolling внутри)', async () => {
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue(ENABLED_CONNECTED)

    useHybridStore.getState().startPolling(1_000)
    useHybridStore.getState().startPolling(1_000)
    const callsAfterStart = vi.mocked(synthApi.getHybridStatus).mock.calls.length
    expect(callsAfterStart).toBe(2)

    await vi.advanceTimersByTimeAsync(2_000)
    // За 2 тика — ровно 2 дополнительных вызова (один активный интервал)
    const total = vi.mocked(synthApi.getHybridStatus).mock.calls.length
    expect(total - callsAfterStart).toBe(2)
  })
})
