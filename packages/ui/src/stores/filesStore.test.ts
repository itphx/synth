import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
      fileRevisions: {},
      deletedFiles: {},
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

  it('при ошибке перечитывания каталога удаляет только его ключ', async () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
      },
    })
    mocks.listDirectory.mockImplementation(async (_pid: string, path?: string) => {
      if (path === 'dir') throw new Error('gone')
      return { entries: [entry('dir', 'dir', true)] }
    })

    await useFilesStore.getState().refreshProject('p1')

    expect(useFilesStore.getState().treesByProject['p1/dir']).toBeUndefined()
    expect(useFilesStore.getState().treesByProject['p1']).toHaveLength(1)
    expect(useFilesStore.getState().revisionByProject.p1).toBe(1)
  })
})

describe('filesStore.refreshDirs / scheduleRefresh (точная инвалидация)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useFilesStore.setState({
      treesByProject: {},
      revisionByProject: {},
      fileRevisions: {},
      deletedFiles: {},
      expandedProjects: new Set<string>(),
      expandedDirs: new Set<string>(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function flushMicrotasks() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  it('refreshDirs перечитывает только загруженные каталоги, не создаёт новые ключи', async () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
      },
    })
    mocks.listDirectory.mockResolvedValue({ entries: [entry('x', 'x', false)] })

    await useFilesStore.getState().refreshDirs('p1', ['dir', 'missing', ''])

    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', 'dir', false)
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false)
    expect(mocks.listDirectory).not.toHaveBeenCalledWith('p1', 'missing', false)
    expect(useFilesStore.getState().treesByProject['p1/missing']).toBeUndefined()
    expect(useFilesStore.getState().treesByProject['p1']).toHaveLength(1)
  })

  it('refreshDirs при ошибке удаляет ключ каталога', async () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
      },
    })
    mocks.listDirectory.mockRejectedValue(new Error('gone'))

    await useFilesStore.getState().refreshDirs('p1', ['dir'])

    expect(useFilesStore.getState().treesByProject['p1/dir']).toBeUndefined()
    expect(useFilesStore.getState().treesByProject['p1']).toHaveLength(1)
  })

  it('scheduleRefresh scope:file перечитывает родителя, не трогает revisionByProject, инкрементит fileRevisions', async () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
      },
    })
    mocks.listDirectory.mockResolvedValue({ entries: [entry('a.txt', 'dir/a.txt', false)] })

    useFilesStore.getState().scheduleRefresh('p1', {
      scope: 'file',
      paths: ['dir/a.txt'],
      op: 'write',
    })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', 'dir', false)
    expect(mocks.listDirectory).not.toHaveBeenCalledWith('p1', '', false)
    expect(useFilesStore.getState().revisionByProject.p1).toBeUndefined()
    expect(useFilesStore.getState().fileRevisions['p1::dir/a.txt']).toBe(1)
  })

  it('op:delete выставляет deletedFiles, op:write снимает', async () => {
    useFilesStore.setState({ treesByProject: { p1: [] } })
    mocks.listDirectory.mockResolvedValue({ entries: [] })

    useFilesStore.getState().scheduleRefresh('p1', {
      scope: 'file', paths: ['a.txt'], op: 'delete',
    })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBe(true)

    useFilesStore.getState().scheduleRefresh('p1', {
      scope: 'file', paths: ['a.txt'], op: 'write',
    })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBeUndefined()
    expect(useFilesStore.getState().fileRevisions['p1::a.txt']).toBe(2)
  })

  it('коалесинг: последняя операция за окно побеждает (write → delete)', async () => {
    useFilesStore.setState({ treesByProject: { p1: [] } })
    mocks.listDirectory.mockResolvedValue({ entries: [] })

    useFilesStore.getState().scheduleRefresh('p1', { scope: 'file', paths: ['a.txt'], op: 'write' })
    useFilesStore.getState().scheduleRefresh('p1', { scope: 'file', paths: ['a.txt'], op: 'delete' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBe(true)
    // Один коалесцированный refresh — одна инкрементация ревизии файла.
    expect(useFilesStore.getState().fileRevisions['p1::a.txt']).toBe(1)
  })

  it('коалесинг: file-события + all-событие → полный refresh', async () => {
    useFilesStore.setState({
      treesByProject: { p1: [], 'p1/dir': [] },
    })
    mocks.listDirectory.mockResolvedValue({ entries: [] })

    useFilesStore.getState().scheduleRefresh('p1', { scope: 'file', paths: ['dir/a.txt'], op: 'write' })
    useFilesStore.getState().scheduleRefresh('p1', { scope: 'all' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false)
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', 'dir', false)
    expect(useFilesStore.getState().revisionByProject.p1).toBe(1)
    expect(useFilesStore.getState().fileRevisions['p1::dir/a.txt']).toBeUndefined()
  })

  it('scheduleRefresh scope:all перечитывает загруженные каталоги и инкрементит revisionByProject', async () => {
    useFilesStore.setState({
      treesByProject: { p1: [], 'p1/dir': [] },
    })
    mocks.listDirectory.mockResolvedValue({ entries: [] })

    useFilesStore.getState().scheduleRefresh('p1', { scope: 'all' })
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false)
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', 'dir', false)
    expect(useFilesStore.getState().revisionByProject.p1).toBe(1)
  })
})

describe('filesStore.markDeletedFile / clearDeletedFile', () => {
  beforeEach(() => {
    useFilesStore.setState({ deletedFiles: {} })
  })

  it('markDeletedFile выставляет пометку', () => {
    useFilesStore.getState().markDeletedFile('p1', 'a.txt')
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBe(true)
  })

  it('повторный вызов идемпотентен (не меняет ссылку на объект)', () => {
    useFilesStore.getState().markDeletedFile('p1', 'a.txt')
    const first = useFilesStore.getState().deletedFiles
    useFilesStore.getState().markDeletedFile('p1', 'a.txt')
    expect(useFilesStore.getState().deletedFiles).toBe(first)
  })

  it('clearDeletedFile снимает пометку', () => {
    useFilesStore.getState().markDeletedFile('p1', 'a.txt')
    useFilesStore.getState().clearDeletedFile('p1', 'a.txt')
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBeUndefined()
  })
})
