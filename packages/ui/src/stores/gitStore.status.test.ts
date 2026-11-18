import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте стора, а окружение
// vitest его не даёт — ставим заглушку до импорта gitStore.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({ getGitStatus: vi.fn() }))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { useGitStore } from './gitStore'

const STATUS = {
  repos: [
    {
      path: '',
      branch: 'main',
      files: [{ path: 'a.ts', kind: 'modified' as const, staged: false, unstaged: true }],
    },
  ],
}

function resetStore(): void {
  useGitStore.setState({ statusByProject: {}, statusLoadedAt: {} })
}

describe('gitStore.loadStatus — статус рабочего дерева (ADR-076, этап 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('загружает статус через API и сохраняет repos как есть', async () => {
    mocks.getGitStatus.mockResolvedValue(STATUS)

    await useGitStore.getState().loadStatus('p1')

    expect(mocks.getGitStatus).toHaveBeenCalledWith('p1')
    expect(useGitStore.getState().statusByProject.p1).toEqual(STATUS.repos)
    expect(useGitStore.getState().statusLoadedAt.p1).toBeGreaterThan(0)
  })

  it('повторный вызов в пределах TTL пропускается (без force)', async () => {
    mocks.getGitStatus.mockResolvedValue(STATUS)

    await useGitStore.getState().loadStatus('p1')
    await useGitStore.getState().loadStatus('p1')

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1)
  })

  it('force игнорирует TTL', async () => {
    mocks.getGitStatus.mockResolvedValue(STATUS)

    await useGitStore.getState().loadStatus('p1')
    await useGitStore.getState().loadStatus('p1', { force: true })

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2)
  })

  it('ошибка не рушит прошлый снимок и ничего не бросает', async () => {
    mocks.getGitStatus.mockResolvedValue(STATUS)
    await useGitStore.getState().loadStatus('p1')
    const loadedAt = useGitStore.getState().statusLoadedAt.p1

    mocks.getGitStatus.mockRejectedValue(new Error('boom'))
    await expect(useGitStore.getState().loadStatus('p1', { force: true })).resolves.toBeUndefined()

    expect(useGitStore.getState().statusByProject.p1).toEqual(STATUS.repos)
    expect(useGitStore.getState().statusLoadedAt.p1).toBe(loadedAt)
  })

  it('параллельные вызовы одного проекта не дублируются', async () => {
    let resolve!: (value: typeof STATUS) => void
    mocks.getGitStatus.mockImplementation(
      () => new Promise((r) => { resolve = r }),
    )

    const first = useGitStore.getState().loadStatus('p1')
    const second = useGitStore.getState().loadStatus('p1')

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1)
    resolve(STATUS)
    await Promise.all([first, second])
    expect(useGitStore.getState().statusByProject.p1).toEqual(STATUS.repos)
  })
})
