import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `stores/worktreesStore.ts` (ADR-114 §9): инвентарь worktree'ов проекта.
 *
 * Стор работает через `synthApi` (мок), обновляется по событию
 * `worktree.updated` и по `fs.changed` (дерево Files перечитывается).
 */

const mocks = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  bindWorktree: vi.fn(),
  scheduleRefresh: vi.fn(),
  upsertSession: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listWorktrees: mocks.listWorktrees,
    createWorktree: mocks.createWorktree,
    removeWorktree: mocks.removeWorktree,
    pruneWorktrees: mocks.pruneWorktrees,
    bindWorktree: mocks.bindWorktree,
  },
}))

// Файловый стор — мок: проверяем только факт вызова `scheduleRefresh`.
vi.mock('@/stores/filesStore', () => ({
  useFilesStore: { getState: () => ({ scheduleRefresh: mocks.scheduleRefresh }) },
}))

// Стор сессий — мок: `bind` обновляет снимок привязки через `upsertSession`.
vi.mock('@/stores/sessionsStore', () => ({
  useSessionsStore: { getState: () => ({ upsertSession: mocks.upsertSession }) },
}))

import { useWorktreesStore, findWorktree, type WorktreeUpdatedEvent } from './worktreesStore'
import type { WorktreeSummary } from '@/lib/api/synthApi'

function makeWorktree(id: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    id,
    projectId: 'p1',
    directory: `/ws/.worktrees/p1/${id}`,
    branch: 'feature/x',
    name: id,
    strategy: 'git',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as WorktreeSummary
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('worktreesStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorktreesStore.setState({ byProject: {}, loadingByProject: {}, error: null })
    mocks.listWorktrees.mockResolvedValue([makeWorktree('w1')])
    mocks.createWorktree.mockResolvedValue({ worktree: makeWorktree('w2') })
    mocks.removeWorktree.mockResolvedValue(undefined)
    mocks.pruneWorktrees.mockResolvedValue({ recordsRemoved: 3, gitPruned: true })
    mocks.bindWorktree.mockResolvedValue({ id: 's1', worktree: { worktree_id: 'w1' } })
  })

  it('refresh наполняет инвентарь проекта и снимает флаг загрузки', async () => {
    await useWorktreesStore.getState().refresh('p1')

    const state = useWorktreesStore.getState()
    expect(mocks.listWorktrees).toHaveBeenCalledWith('p1')
    expect(state.byProject.p1).toHaveLength(1)
    expect(state.byProject.p1![0]!.id).toBe('w1')
    expect(state.loadingByProject.p1).toBe(false)
    expect(state.error).toBeNull()
  })

  it('refresh сохраняет ошибку и не оставляет «загрузку» висеть', async () => {
    mocks.listWorktrees.mockRejectedValueOnce(new Error('boom'))

    await useWorktreesStore.getState().refresh('p1')

    const state = useWorktreesStore.getState()
    expect(state.error).toBe('boom')
    expect(state.loadingByProject.p1).toBe(false)
  })

  it('create вызывает API и перечитывает инвентарь', async () => {
    const result = await useWorktreesStore.getState().create('p1', { branch: 'feature/y' })

    expect(mocks.createWorktree).toHaveBeenCalledWith('p1', { branch: 'feature/y' })
    expect(result.worktree.id).toBe('w2')
    expect(mocks.listWorktrees).toHaveBeenCalledWith('p1')
  })

  it('remove без force не добавляет query, с force — добавляет', async () => {
    await useWorktreesStore.getState().remove('p1', 'w1')
    expect(mocks.removeWorktree).toHaveBeenNthCalledWith(1, 'p1', 'w1', {})

    await useWorktreesStore.getState().remove('p1', 'w1', { force: true })
    expect(mocks.removeWorktree).toHaveBeenNthCalledWith(2, 'p1', 'w1', { force: true })
    // После каждой мутации инвентарь перечитывается.
    expect(mocks.listWorktrees).toHaveBeenCalledTimes(2)
  })

  it('prune возвращает итог и перечитывает инвентарь', async () => {
    const result = await useWorktreesStore.getState().prune('p1')

    expect(mocks.pruneWorktrees).toHaveBeenCalledWith('p1')
    expect(result).toEqual({ recordsRemoved: 3, gitPruned: true })
    expect(mocks.listWorktrees).toHaveBeenCalledWith('p1')
  })

  it('bind обновляет снимок привязки в сторе сессий', async () => {
    await useWorktreesStore.getState().bind('s1', 'w1')

    expect(mocks.bindWorktree).toHaveBeenCalledWith('s1', 'w1')
    expect(mocks.upsertSession).toHaveBeenCalledWith({ id: 's1', worktree: { worktree_id: 'w1' } })
  })

  it('bind с null снимает привязку', async () => {
    await useWorktreesStore.getState().bind('s1', null)

    expect(mocks.bindWorktree).toHaveBeenCalledWith('s1', null)
  })

  it('applyEvent worktree.updated перечитывает инвентарь проекта', async () => {
    useWorktreesStore.getState().applyEvent('worktree.updated', {
      project_id: 'p1',
      worktree_id: 'w1',
      action: 'created',
    })
    await flush()

    expect(mocks.listWorktrees).toHaveBeenCalledWith('p1')
  })

  it('applyEvent worktree.updated без project_id ничего не перечитывает', async () => {
    useWorktreesStore.getState().applyEvent('worktree.updated', { action: 'created' })
    await flush()

    expect(mocks.listWorktrees).not.toHaveBeenCalled()
  })

  it('applyEvent fs.changed перечитывает дерево Files проекта', async () => {
    useWorktreesStore.getState().applyEvent('fs.changed', { project_id: 'p1' })

    expect(mocks.scheduleRefresh).toHaveBeenCalledWith('p1', {
      scope: 'all',
      paths: undefined,
      workspaceChanged: false,
      op: undefined,
    })
    expect(mocks.listWorktrees).not.toHaveBeenCalled()
  })

  it('applyEvent fs.changed пробрасывает точечную область (пути не теряются)', async () => {
    useWorktreesStore.getState().applyEvent('fs.changed', {
      project_id: 'p1',
      scope: 'file',
      paths: ['a.txt'],
      op: 'delete',
    })

    // Точная инвалидация обязана дойти до filesStore: полный 'all' здесь отключил
    // бы учёт fileRevisions/deletedFiles (редактор не увидит изменение на диске).
    expect(mocks.scheduleRefresh).toHaveBeenCalledWith('p1', {
      scope: 'file',
      paths: ['a.txt'],
      workspaceChanged: false,
      op: 'delete',
    })
  })

  it('applyEvent fs.changed игнорирует неизвестный op', async () => {
    useWorktreesStore.getState().applyEvent('fs.changed', {
      project_id: 'p1',
      scope: 'file',
      paths: ['a.txt'],
      // Неизвестный op приходит из шины как есть — тип его не описывает,
      // поэтому приводим явно (стор обязан отбросить его самостоятельно).
      op: 'bogus' as unknown as WorktreeUpdatedEvent['op'],
    })

    expect(mocks.scheduleRefresh).toHaveBeenCalledWith('p1', {
      scope: 'file',
      paths: ['a.txt'],
      workspaceChanged: false,
      op: undefined,
    })
  })

  it('applyEvent fs.changed без project_id не трогает дерево Files', async () => {
    useWorktreesStore.getState().applyEvent('fs.changed', {})

    expect(mocks.scheduleRefresh).not.toHaveBeenCalled()
  })

  it('applyEvent игнорирует чужие события', async () => {
    useWorktreesStore.getState().applyEvent('stream.chunk', { project_id: 'p1' })
    await flush()

    expect(mocks.listWorktrees).not.toHaveBeenCalled()
    expect(mocks.scheduleRefresh).not.toHaveBeenCalled()
  })

  it('list отдаёт записи проекта (пустой массив для неизвестного)', async () => {
    await useWorktreesStore.getState().refresh('p1')

    expect(useWorktreesStore.getState().list('p1')).toHaveLength(1)
    expect(useWorktreesStore.getState().list('unknown')).toEqual([])
  })

  it('findWorktree находит запись по id в любом проекте', async () => {
    await useWorktreesStore.getState().refresh('p1')
    useWorktreesStore.setState({
      byProject: {
        p1: [makeWorktree('w1')],
        p2: [makeWorktree('w2', { projectId: 'p2' })],
      },
    })

    expect(findWorktree(useWorktreesStore.getState(), 'w2')?.projectId).toBe('p2')
    expect(findWorktree(useWorktreesStore.getState(), 'missing')).toBeUndefined()
  })
})
