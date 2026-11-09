import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getInstanceCapabilities: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { getInstanceCapabilities: mocks.getInstanceCapabilities },
}))

import type { InstanceCapabilities } from '@itphx/synth-shared/types'
import {
  useInstanceCapabilitiesStore,
  selectFeatures,
  selectHasFeature,
} from './instanceCapabilitiesStore'

const CAPS: InstanceCapabilities = {
  messageModel: 2,
  eventSeq: true,
  replay: true,
  version: '0.13.7',
  features: { remoteMcp: true, users: true },
}

beforeEach(() => {
  vi.clearAllMocks()
  useInstanceCapabilitiesStore.getState().resetForTests()
})

afterEach(() => {
  useInstanceCapabilitiesStore.getState().resetForTests()
  vi.useRealTimers()
})

describe('instanceCapabilitiesStore — единственная точка обращения к /meta', () => {
  it('load() читает возможности инстанса и кладёт их в стор', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)

    await expect(useInstanceCapabilitiesStore.getState().load()).resolves.toEqual(CAPS)
    expect(useInstanceCapabilitiesStore.getState().capabilities).toEqual(CAPS)
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)
  })

  it('load() кэширует ответ (второй вызов — без нового запроса)', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)

    await useInstanceCapabilitiesStore.getState().load()
    await useInstanceCapabilitiesStore.getState().load()

    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)
  })

  it('load({ force: true }) обходит кэш', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)

    await useInstanceCapabilitiesStore.getState().load()
    await useInstanceCapabilitiesStore.getState().load({ force: true })

    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(2)
  })

  it('кэш истекает через 60 секунд', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)

    await useInstanceCapabilitiesStore.getState().load()
    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
    await useInstanceCapabilitiesStore.getState().load()
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    await useInstanceCapabilitiesStore.getState().load()
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(2)
  })

  it('одновременные вызовы дедуплицируются (один запрос)', async () => {
    let resolve: ((value: unknown) => void) | undefined
    mocks.getInstanceCapabilities.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )

    const first = useInstanceCapabilitiesStore.getState().load()
    const second = useInstanceCapabilitiesStore.getState().load()
    resolve?.(CAPS)

    await expect(first).resolves.toEqual(CAPS)
    await expect(second).resolves.toEqual(CAPS)
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)
  })

  it('ошибка сети → null и никаких фич (fail-closed)', async () => {
    mocks.getInstanceCapabilities.mockRejectedValue(new Error('network'))

    await expect(useInstanceCapabilitiesStore.getState().load()).resolves.toBeNull()
    expect(useInstanceCapabilitiesStore.getState().capabilities).toBeNull()
    expect(selectFeatures(useInstanceCapabilitiesStore.getState())).toBeUndefined()
    expect(selectHasFeature('users')(useInstanceCapabilitiesStore.getState())).toBe(false)
  })
})

describe('instanceCapabilitiesStore — признаки инстанса', () => {
  it('selectFeatures отдаёт features из ответа', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)
    await useInstanceCapabilitiesStore.getState().load()

    expect(selectFeatures(useInstanceCapabilitiesStore.getState())).toEqual({
      remoteMcp: true,
      users: true,
    })
  })

  it('hasFeature строгий: только `=== true` считается фичей', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)
    await useInstanceCapabilitiesStore.getState().load()

    const state = useInstanceCapabilitiesStore.getState()
    expect(selectHasFeature('users')(state)).toBe(true)
    expect(selectHasFeature('remoteMcp')(state)).toBe(true)
    // Признака нет — «фичи нет».
    expect(selectHasFeature('unknown')(state)).toBe(false)
  })

  it('признак `false` и отсутствующий блок features — «фичи нет»', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue({
      ...CAPS,
      features: { users: false },
    })
    await useInstanceCapabilitiesStore.getState().load()
    expect(selectHasFeature('users')(useInstanceCapabilitiesStore.getState())).toBe(false)

    useInstanceCapabilitiesStore.getState().resetForTests()
    mocks.getInstanceCapabilities.mockResolvedValue({
      messageModel: 2,
      eventSeq: true,
      replay: true,
      version: '0.13.7',
    })
    await useInstanceCapabilitiesStore.getState().load()
    expect(selectHasFeature('users')(useInstanceCapabilitiesStore.getState())).toBe(false)
  })

  it('resetForTests() сбрасывает состояние и кэш', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue(CAPS)
    await useInstanceCapabilitiesStore.getState().load()
    expect(useInstanceCapabilitiesStore.getState().capabilities).not.toBeNull()

    useInstanceCapabilitiesStore.getState().resetForTests()

    expect(useInstanceCapabilitiesStore.getState().capabilities).toBeNull()
    // Кэш сброшен — следующий load() снова идёт на сервер.
    await useInstanceCapabilitiesStore.getState().load()
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(2)
  })
})
