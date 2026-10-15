import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) в useGitStore пишет в localStorage — в Node/vitest его нет.
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

const mocks = vi.hoisted(() => ({
  scanGitRepos: vi.fn(),
  initGitRepo: vi.fn(),
  cloneGitRepo: vi.fn(),
  registerGitRepo: vi.fn(),
  removeGitRepo: vi.fn(),
  fetchGitRepo: vi.fn(),
  listSshKeys: vi.fn(),
  getCommitLog: vi.fn(),
  getCommitDetail: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { useGitStore } from './gitStore'
import type { GitRepoConfigData } from '@/lib/api/synthApi'

const REGISTRY_ENTRY: GitRepoConfigData = {
  id: 'r1',
  path: 'app',
  name: 'App',
  url: 'https://example.com/app.git',
  type: 'https',
  defaultBranch: 'main',
  sshKeyId: 'k1',
  lastFetch: '2026-01-01T00:00:00Z',
}

describe('gitStore — реестр репозиториев (ADR-076)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGitStore.setState({ reposByProject: {}, commitsByRepo: {}, loading: false, error: null })
  })

  it('loadRepos сохраняет метаданные реестра и прежний git-статус', async () => {
    useGitStore.setState({
      reposByProject: { p1: [{ path: 'app', isRepo: true, currentBranch: 'main' }] },
    })

    await useGitStore.getState().loadRepos('p1', [REGISTRY_ENTRY])

    const repos = useGitStore.getState().reposByProject.p1
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({
      id: 'r1',
      name: 'App',
      url: 'https://example.com/app.git',
      type: 'https',
      path: 'app',
      defaultBranch: 'main',
      sshKeyId: 'k1',
      lastFetch: '2026-01-01T00:00:00Z',
      currentBranch: 'main',
      isRepo: true,
    })
  })

  it('loadRepos нормализует legacy string[]', async () => {
    await useGitStore.getState().loadRepos('p1', ['vendor/lib'] as unknown as GitRepoConfigData[])
    expect(useGitStore.getState().reposByProject.p1[0]).toMatchObject({ path: 'vendor/lib', isRepo: true })
  })

  it('scanWorkspace мёржит статус в запись реестра с корневым path ("" ↔ ".")', async () => {
    useGitStore.setState({ reposByProject: { p1: [{ id: 'r1', path: '.', isRepo: true }] } })
    mocks.scanGitRepos.mockResolvedValue({ repos: [{ path: '', isRepo: true, currentBranch: 'dev' }] })

    const result = await useGitStore.getState().scanWorkspace('p1')

    expect(result).toHaveLength(1)
    expect(useGitStore.getState().reposByProject.p1[0]).toMatchObject({ path: '.', currentBranch: 'dev' })
  })

  it('registerRepo шлёт полную запись реестра (не string[])', async () => {
    mocks.registerGitRepo.mockResolvedValue({ id: 'r2', path: 'vendor/lib' })

    const entry = {
      path: 'vendor/lib',
      name: 'lib',
      url: 'git@example.com:lib.git',
      type: 'ssh' as const,
      defaultBranch: 'main',
      sshKeyId: 'k1',
    }
    await useGitStore.getState().registerRepo('p1', entry)

    expect(mocks.registerGitRepo).toHaveBeenCalledWith('p1', entry)
  })

  it('initRepo/cloneRepo передают name и sshKeyId', async () => {
    mocks.initGitRepo.mockResolvedValue({ path: 'app', isRepo: true })
    mocks.cloneGitRepo.mockResolvedValue({ path: 'app', isRepo: true })

    await useGitStore.getState().initRepo('p1', 'app', 'main', 'App', 'k1')
    expect(mocks.initGitRepo).toHaveBeenCalledWith('p1', 'app', 'main', 'App', 'k1')

    await useGitStore.getState().cloneRepo('p1', 'git@example.com:app.git', 'app', 'main', 'App', 'k1')
    expect(mocks.cloneGitRepo).toHaveBeenCalledWith('p1', 'git@example.com:app.git', 'app', 'main', 'App', 'k1')
  })

  it('expandAll раскрывает переданные проекты и их репозитории', () => {
    useGitStore.setState({
      reposByProject: {
        p1: [{ path: 'app' }, { path: 'vendor/lib' }],
        p2: [{ path: '' }],
      },
      expandedProjects: new Set<string>(),
      expandedRepos: new Set<string>(),
    })

    useGitStore.getState().expandAll(['p1'])

    const s = useGitStore.getState()
    expect(s.expandedProjects.has('p1')).toBe(true)
    expect(s.expandedRepos.has('p1::app')).toBe(true)
    expect(s.expandedRepos.has('p1::vendor/lib')).toBe(true)
    // проект вне списка остаётся нетронутым
    expect(s.expandedProjects.has('p2')).toBe(false)
    expect(s.expandedRepos.has('p2::')).toBe(false)
  })

  it('expandAll не сворачивает уже раскрытое и не падает без репозиториев', () => {
    useGitStore.setState({
      reposByProject: {},
      expandedProjects: new Set(['p1']),
      expandedRepos: new Set(['p1::app']),
    })

    useGitStore.getState().expandAll(['p2'])

    const s = useGitStore.getState()
    expect(s.expandedProjects.has('p1')).toBe(true)
    expect(s.expandedRepos.has('p1::app')).toBe(true)
    expect(s.expandedProjects.has('p2')).toBe(true)
  })

  it('collapseAll сворачивает все проекты и репозитории', () => {
    useGitStore.setState({
      expandedProjects: new Set(['p1', 'p2']),
      expandedRepos: new Set(['p1::app', 'p2::']),
    })

    useGitStore.getState().collapseAll()

    const s = useGitStore.getState()
    expect(s.expandedProjects.size).toBe(0)
    expect(s.expandedRepos.size).toBe(0)
  })

  it('removeRepo/fetchRepo передают opts (id, deleteLocal)', async () => {
    mocks.removeGitRepo.mockResolvedValue({ removed: { path: 'app' }, deletedLocal: true })
    mocks.fetchGitRepo.mockResolvedValue({ path: 'app', lastFetch: '2026-02-02T00:00:00Z' })

    await expect(useGitStore.getState().removeRepo('p1', { id: 'r1', deleteLocal: true })).resolves.toBe(true)
    expect(mocks.removeGitRepo).toHaveBeenCalledWith('p1', { id: 'r1', deleteLocal: true })

    await expect(useGitStore.getState().fetchRepo('p1', { id: 'r1' })).resolves.toBe(true)
    expect(mocks.fetchGitRepo).toHaveBeenCalledWith('p1', { id: 'r1' })
  })
})
