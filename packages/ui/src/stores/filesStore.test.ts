import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) в useFilesStore пишет в localStorage — мок для детерминизма.
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
  listDirectory: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { useFilesStore } from './filesStore'
import type { FileEntry } from '@/lib/api/synthApi'

function entry(name: string, path: string, isDirectory: boolean): FileEntry {
  return { name, path, isDirectory, size: 0, modifiedAt: 0 }
}

describe('filesStore.refreshProject (fs.changed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFilesStore.setState({
      treesByProject: {},
      revisionByProject: {},
      expandedProjects: new Set<string>(),
      expandedDirs: new Set<string>(),
    })
  })

  it('перечитывает корень и уже загруженные каталоги, инкрементит ревизию', async () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
      },
      expandedProjects: new Set(['p1']),
      expandedDirs: new Set(['p1/dir']),
    })
    mocks.listDirectory.mockImplementation(async (_pid: string, path?: string) => {
      if (path === 'dir') return { entries: [entry('b.txt', 'dir/b.txt', false)] }
      return { entries: [entry('dir', 'dir', true), entry('root.txt', 'root.txt', false)] }
    })

    await useFilesStore.getState().refreshProject('p1')

    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false)
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', 'dir', false)
    expect(useFilesStore.getState().revisionByProject.p1).toBe(1)
    expect(useFilesStore.getState().treesByProject['p1']).toHaveLength(2)
    expect(useFilesStore.getState().treesByProject['p1/dir']).toHaveLength(1)
    // Раскрытие сохраняется.
    expect(useFilesStore.getState().expandedProjects.has('p1')).toBe(true)
  })

  it('повторный refresh инкрементит ревизию', async () => {
    useFilesStore.setState({ treesByProject: { p1: [] } })
    mocks.listDirectory.mockResolvedValue({ entries: [] })
    await useFilesStore.getState().refreshProject('p1')
    await useFilesStore.getState().refreshProject('p1')
    expect(useFilesStore.getState().revisionByProject.p1).toBe(2)
  })

  it('без загруженного дерева всё равно инкрементит ревизию (открытый редактор)', async () => {
    await useFilesStore.getState().refreshProject('p9')
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(useFilesStore.getState().revisionByProject.p9).toBe(1)
  })
})
