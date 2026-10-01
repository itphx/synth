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
  moveEntry: vi.fn(),
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

describe('filesStore.moveEntry (перемап поддерева)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFilesStore.setState({
      treesByProject: {},
      fileRevisions: {},
      deletedFiles: {},
      draftContents: {},
      expandedDirs: new Set<string>(),
      error: null,
    })
    mocks.listDirectory.mockResolvedValue({ entries: [] })
  })

  it('перемапливает ключи поддерева и перечитывает src/dst родителей', async () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true), entry('other', 'other', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
        'p1/dir/sub': [entry('b.txt', 'dir/sub/b.txt', false)],
      },
      expandedDirs: new Set(['p1/dir', 'p1/dir/sub', 'p1/other']),
      fileRevisions: { 'p1::dir/a.txt': 2 },
      deletedFiles: { 'p1::dir/sub/b.txt': true },
      draftContents: { 'p1::dir/a.txt': 'draft' },
    })
    mocks.moveEntry.mockResolvedValue({ moved: true, sourcePath: 'dir', targetPath: 'other/dir' })

    const ok = await useFilesStore.getState().moveEntry('p1', 'dir', 'other/dir')

    expect(ok).toBe(true)
    const s = useFilesStore.getState()
    // treesByProject: поддерево переехало, старые ключи исчезли,
    // а `path` записей листингов переписан на новый префикс.
    expect(s.treesByProject['p1/other/dir']).toEqual([entry('a.txt', 'other/dir/a.txt', false)])
    expect(s.treesByProject['p1/other/dir/sub']).toEqual([entry('b.txt', 'other/dir/sub/b.txt', false)])
    expect(s.treesByProject['p1/dir']).toBeUndefined()
    expect(s.treesByProject['p1/dir/sub']).toBeUndefined()
    // expandedDirs: раскрытие поддерева переехало, чужие не тронуты.
    expect(s.expandedDirs.has('p1/other/dir')).toBe(true)
    expect(s.expandedDirs.has('p1/other/dir/sub')).toBe(true)
    expect(s.expandedDirs.has('p1/dir')).toBe(false)
    expect(s.expandedDirs.has('p1/other')).toBe(true)
    // fileRevisions / deletedFiles / draftContents.
    expect(s.fileRevisions['p1::other/dir/a.txt']).toBe(2)
    expect(s.fileRevisions['p1::dir/a.txt']).toBeUndefined()
    expect(s.deletedFiles['p1::other/dir/sub/b.txt']).toBe(true)
    expect(s.deletedFiles['p1::dir/sub/b.txt']).toBeUndefined()
    expect(s.draftContents['p1::other/dir/a.txt']).toBe('draft')
    expect(s.draftContents['p1::dir/a.txt']).toBeUndefined()
    // Перечитывание родителей: src='' и dst='other'.
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false)
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', 'other', false)
  })

  it('ошибка moveEntry → false, без перемапа, error выставлен', async () => {
    useFilesStore.setState({
      draftContents: { 'p1::dir/a.txt': 'x' },
      expandedDirs: new Set(['p1/dir']),
      treesByProject: { 'p1/dir': [entry('a.txt', 'dir/a.txt', false)] },
    })
    mocks.moveEntry.mockRejectedValue(new Error('nope'))
    const beforeTrees = useFilesStore.getState().treesByProject
    const beforeDrafts = useFilesStore.getState().draftContents

    const ok = await useFilesStore.getState().moveEntry('p1', 'dir', 'other/dir')

    expect(ok).toBe(false)
    expect(useFilesStore.getState().error).toBe('nope')
    expect(useFilesStore.getState().treesByProject).toBe(beforeTrees)
    expect(useFilesStore.getState().draftContents).toBe(beforeDrafts)
    expect(useFilesStore.getState().expandedDirs.has('p1/dir')).toBe(true)
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it('переименование каталога: path записей обновлён, name не изменился', async () => {
    useFilesStore.setState({
      treesByProject: {
        'p1/src': [entry('sub', 'src/sub', true), entry('a.ts', 'src/a.ts', false)],
        'p1/src/sub': [entry('f.ts', 'src/sub/f.ts', false)],
      },
      expandedDirs: new Set(['p1/src', 'p1/src/sub']),
    })
    mocks.moveEntry.mockResolvedValue({ moved: true, sourcePath: 'src', targetPath: 'lib' })

    await useFilesStore.getState().moveEntry('p1', 'src', 'lib')

    const s = useFilesStore.getState()
    expect(s.treesByProject['p1/lib']).toEqual([
      entry('sub', 'lib/sub', true),
      entry('a.ts', 'lib/a.ts', false),
    ])
    expect(s.treesByProject['p1/lib/sub']).toEqual([entry('f.ts', 'lib/sub/f.ts', false)])
    expect(s.expandedDirs.has('p1/lib')).toBe(true)
    expect(s.expandedDirs.has('p1/lib/sub')).toBe(true)
    expect(s.expandedDirs.has('p1/src')).toBe(false)
  })

  it('межпроектный перенос: targetProjectId уходит на сервер, оба проекта перечитываются', async () => {
    useFilesStore.setState({
      treesByProject: {
        'p1/src': [entry('a.ts', 'src/a.ts', false)],
        p2: [entry('x', 'x', false)],
      },
      expandedDirs: new Set(['p1/src']),
      fileRevisions: { 'p1::src/a.ts': 3 },
      draftContents: { 'p1::src/a.ts': 'draft' },
    })
    mocks.moveEntry.mockResolvedValue({ moved: true, sourcePath: 'src', targetPath: 'lib' })

    const ok = await useFilesStore.getState().moveEntry('p1', 'src', 'lib', 'p2')

    expect(ok).toBe(true)
    expect(mocks.moveEntry).toHaveBeenCalledWith('p1', 'src', 'lib', 'p2')
    const s = useFilesStore.getState()
    // Ключи переехали в пространство целевого проекта.
    expect(s.treesByProject['p2/lib']).toEqual([entry('a.ts', 'lib/a.ts', false)])
    expect(s.treesByProject['p1/src']).toBeUndefined()
    expect(s.expandedDirs.has('p2/lib')).toBe(true)
    expect(s.expandedDirs.has('p1/src')).toBe(false)
    expect(s.fileRevisions['p2::lib/a.ts']).toBe(3)
    expect(s.draftContents['p2::lib/a.ts']).toBe('draft')
    // Родитель источника ('') и родитель назначения ('') — в обоих проектах.
    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false)
    expect(mocks.listDirectory).toHaveBeenCalledWith('p2', '', false)
  })
})

describe('filesStore.remapPath (префиксный перемап)', () => {
  beforeEach(() => {
    useFilesStore.setState({
      treesByProject: {},
      fileRevisions: {},
      deletedFiles: {},
      draftContents: {},
      expandedDirs: new Set<string>(),
    })
  })

  it('внутрипроектный: ключи и entry.path переезжают на новый префикс', () => {
    useFilesStore.setState({
      treesByProject: {
        p1: [entry('dir', 'dir', true), entry('other', 'other', true)],
        'p1/dir': [entry('a.txt', 'dir/a.txt', false)],
        'p1/dir/sub': [entry('b.txt', 'dir/sub/b.txt', false)],
      },
      expandedDirs: new Set(['p1/dir', 'p1/dir/sub', 'p1/other']),
      fileRevisions: { 'p1::dir/a.txt': 2 },
      deletedFiles: { 'p1::dir/sub/b.txt': true },
      draftContents: { 'p1::dir/a.txt': 'draft' },
    })

    useFilesStore.getState().remapPath('p1', 'dir', 'p1', 'other/dir')

    const s = useFilesStore.getState()
    expect(s.treesByProject['p1/other/dir']).toEqual([entry('a.txt', 'other/dir/a.txt', false)])
    expect(s.treesByProject['p1/other/dir/sub']).toEqual([entry('b.txt', 'other/dir/sub/b.txt', false)])
    expect(s.treesByProject['p1/dir']).toBeUndefined()
    expect(s.treesByProject['p1/dir/sub']).toBeUndefined()
    expect(s.expandedDirs.has('p1/other/dir')).toBe(true)
    expect(s.expandedDirs.has('p1/other/dir/sub')).toBe(true)
    expect(s.expandedDirs.has('p1/other')).toBe(true)
    expect(s.expandedDirs.has('p1/dir')).toBe(false)
    expect(s.fileRevisions['p1::other/dir/a.txt']).toBe(2)
    expect(s.deletedFiles['p1::other/dir/sub/b.txt']).toBe(true)
    expect(s.draftContents['p1::other/dir/a.txt']).toBe('draft')
  })

  it('межпроектный: ключи переезжают в пространство целевого проекта', () => {
    useFilesStore.setState({
      treesByProject: {
        'p1/src': [entry('a.ts', 'src/a.ts', false)],
        p2: [entry('x', 'x', false)],
      },
      expandedDirs: new Set(['p1/src']),
      fileRevisions: { 'p1::src/a.ts': 3 },
      deletedFiles: { 'p1::src/a.ts': true },
      draftContents: { 'p1::src/a.ts': 'draft' },
    })

    useFilesStore.getState().remapPath('p1', 'src', 'p2', 'lib')

    const s = useFilesStore.getState()
    expect(s.treesByProject['p2/lib']).toEqual([entry('a.ts', 'lib/a.ts', false)])
    expect(s.treesByProject['p1/src']).toBeUndefined()
    expect(s.treesByProject.p2).toEqual([entry('x', 'x', false)])
    expect(s.expandedDirs.has('p2/lib')).toBe(true)
    expect(s.expandedDirs.has('p1/src')).toBe(false)
    expect(s.fileRevisions['p2::lib/a.ts']).toBe(3)
    expect(s.fileRevisions['p1::src/a.ts']).toBeUndefined()
    expect(s.deletedFiles['p2::lib/a.ts']).toBe(true)
    expect(s.draftContents['p2::lib/a.ts']).toBe('draft')
    expect(s.draftContents['p1::src/a.ts']).toBeUndefined()
  })

  it('нерелевантный путь — состояние не меняется (те же ссылки)', () => {
    const treesByProject = { p1: [entry('x', 'x', false)] }
    const expandedDirs = new Set(['p1/y'])
    const fileRevisions = { 'p1::x': 1 }
    const deletedFiles: Record<string, true> = { 'p1::z': true }
    const draftContents = { 'p1::x': 'd' }
    useFilesStore.setState({ treesByProject, expandedDirs, fileRevisions, deletedFiles, draftContents })

    useFilesStore.getState().remapPath('p1', 'missing', 'p2', 'x')

    const s = useFilesStore.getState()
    expect(s.treesByProject).toBe(treesByProject)
    expect(s.expandedDirs).toBe(expandedDirs)
    expect(s.fileRevisions).toBe(fileRevisions)
    expect(s.deletedFiles).toBe(deletedFiles)
    expect(s.draftContents).toBe(draftContents)
  })
})

describe('filesStore.setDraft / clearDraft', () => {
  beforeEach(() => {
    useFilesStore.setState({ draftContents: {} })
  })

  it('пишет черновик при отличии от оригинала', () => {
    useFilesStore.getState().setDraft('p1', 'a.txt', 'edit', 'orig')
    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBe('edit')
  })

  it('удаляет черновик при равенстве содержимого оригиналу', () => {
    useFilesStore.getState().setDraft('p1', 'a.txt', 'edit', 'orig')
    useFilesStore.getState().setDraft('p1', 'a.txt', 'orig', 'orig')
    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBeUndefined()
  })

  it('идемпотентен — не меняет ссылку при том же значении', () => {
    useFilesStore.getState().setDraft('p1', 'a.txt', 'edit', 'orig')
    const first = useFilesStore.getState().draftContents
    useFilesStore.getState().setDraft('p1', 'a.txt', 'edit', 'orig')
    expect(useFilesStore.getState().draftContents).toBe(first)
  })

  it('clearDraft идемпотентен и удаляет запись', () => {
    const empty = useFilesStore.getState().draftContents
    useFilesStore.getState().clearDraft('p1', 'missing')
    expect(useFilesStore.getState().draftContents).toBe(empty)

    useFilesStore.getState().setDraft('p1', 'a.txt', 'edit', 'orig')
    useFilesStore.getState().clearDraft('p1', 'a.txt')
    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBeUndefined()
  })
})
