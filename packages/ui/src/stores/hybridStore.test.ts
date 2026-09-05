import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getHybridStatus: vi.fn(),
  },
}))

import { useHybridStore, selectIsOffline } from './hybridStore'
import { synthApi } from '@/lib/api/synthApi'

const ENABLED_CONNECTED = {
  enabled: true,
  connected: true,
  backendUrl: 'https://backend.example',
  user: { id: 'u1', username: 'dev', roles: ['USER'] },
  serverConfigured: true,
  serverLoginAvailable: true,
}

describe('hybridStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useHybridStore.getState().stopPolling()
    useHybridStore.setState({ enabled: false, connected: false, backendUrl: null, user: null, loading: false, lastCheckedAt: null })
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
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue({ enabled: false, connected: false, backendUrl: null, user: null, serverConfigured: false, serverLoginAvailable: false })

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

    // Интервал 10с > кеш-окно 5с — каждый тик реальный запрос (не кеш).
    useHybridStore.getState().startPolling(10_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(5)

    useHybridStore.getState().stopPolling()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(5)
  })

  it('повторный startPolling не плодит интервалы (stopPolling внутри)', async () => {
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue(ENABLED_CONNECTED)

    useHybridStore.getState().startPolling(10_000)
    useHybridStore.getState().startPolling(10_000)
    // Второй startPolling: немедленный loadStatus попадает в кеш (< 5с) — fetch не дублируется.
    const callsAfterStart = vi.mocked(synthApi.getHybridStatus).mock.calls.length
    expect(callsAfterStart).toBe(1)

    await vi.advanceTimersByTimeAsync(20_000)
    // За 2 тика — ровно 2 дополнительных вызова (один активный интервал)
    const total = vi.mocked(synthApi.getHybridStatus).mock.calls.length
    expect(total - callsAfterStart).toBe(2)
  })

  it('loadStatus: повторный вызов в пределах 5с возвращает кеш (без fetch)', async () => {
    vi.mocked(synthApi.getHybridStatus).mockResolvedValue(ENABLED_CONNECTED)

    await useHybridStore.getState().loadStatus()
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(1)

    // Сразу повторный вызов — кеш свежий, fetch не делается.
    await useHybridStore.getState().loadStatus()
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(1)

    // Ровно 5с — окно истекло, следующий вызов делает запрос.
    await vi.advanceTimersByTimeAsync(5_000)
    await useHybridStore.getState().loadStatus()
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(2)

    // 4999мс — всё ещё кеш.
    await vi.advanceTimersByTimeAsync(4_999)
    await useHybridStore.getState().loadStatus()
    expect(vi.mocked(synthApi.getHybridStatus)).toHaveBeenCalledTimes(2)
  })

  it('selectIsOffline: enabled && !connected', () => {
    const s = useHybridStore.getState()
    expect(selectIsOffline({ ...s, enabled: true, connected: false })).toBe(true)
    expect(selectIsOffline({ ...s, enabled: true, connected: true })).toBe(false)
    expect(selectIsOffline({ ...s, enabled: false, connected: false })).toBe(false)
  })
})
