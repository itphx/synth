/**
 * Пагинация списка проектов (ADR-089, B1): `GET /projects` отдаёт **страницу**
 * `{projects, total, offset, limit, next_offset}` — список проектов в дереве
 * показывается первой страницей, дальше — по кнопке «Показать ещё».
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProjectData } from '@/lib/api/synthApi'

// persist (zustand) захватывает localStorage при импорте useUIStore, а Node/vitest
// без --localstorage-file его не даёт — ставим заглушку до импорта стора.
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
  getProjects: vi.fn(),
  getProjectsPage: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  publishProject: vi.fn(),
  forkRemoteProject: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))

import { useProjectsStore } from './projectsStore'
import { useHybridStore } from './hybridStore'

function project(id: string): ProjectData {
  return {
    id,
    name: id,
    owner_id: 'u1',
    members: {},
    description: '',
    current_task: '',
    invariants: '',
    icon: null,
    color: null,
    workspace: null,
    repos: null,
    status_messages: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** Страница списка проектов — ответ `GET /projects`. */
function page(projects: ProjectData[], nextOffset: number | null = null, total = projects.length) {
  return { projects, total, offset: 0, limit: 100, next_offset: nextOffset }
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    projects: [],
    loading: false,
    error: null,
    total: 0,
    nextOffset: null,
    loadingMore: false,
  })
})

describe('projectsStore — пагинация списка проектов', () => {
  it('loadProjects берёт первую страницу (limit=100) и сохраняет курсор', async () => {
    mocks.getProjectsPage.mockResolvedValue(page([project('p1'), project('p2')], 2, 5))

    await useProjectsStore.getState().loadProjects()

    expect(mocks.getProjectsPage).toHaveBeenCalledWith({ limit: 100 })
    const state = useProjectsStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(state.total).toBe(5)
    expect(state.nextOffset).toBe(2)
    expect(state.loading).toBe(false)
  })

  it('loadMoreProjects дописывает следующую страницу (дедуп по id)', async () => {
    mocks.getProjectsPage.mockResolvedValueOnce(page([project('p1')], 1, 3))
    mocks.getProjectsPage.mockResolvedValueOnce(page([project('p1'), project('p2')], null, 3))

    await useProjectsStore.getState().loadProjects()
    await useProjectsStore.getState().loadMoreProjects()

    expect(mocks.getProjectsPage).toHaveBeenLastCalledWith({ limit: 100, offset: 1 })
    const state = useProjectsStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    // Последняя страница — курсора больше нет.
    expect(state.nextOffset).toBeNull()
    expect(state.loadingMore).toBe(false)
  })

  it('loadMoreProjects без курсора ничего не грузит', async () => {
    mocks.getProjectsPage.mockResolvedValue(page([project('p1')], null))

    await useProjectsStore.getState().loadProjects()
    mocks.getProjectsPage.mockClear()
    await useProjectsStore.getState().loadMoreProjects()

    expect(mocks.getProjectsPage).not.toHaveBeenCalled()
  })

  it('создание проекта сдвигает курсор страниц на единицу', async () => {
    mocks.getProjectsPage.mockResolvedValue(page([project('p1')], 2, 3))
    mocks.createProject.mockResolvedValue(project('p0'))

    await useProjectsStore.getState().loadProjects()
    await useProjectsStore.getState().createProject({ name: 'p0' })

    const state = useProjectsStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['p0', 'p1'])
    expect(state.nextOffset).toBe(1)
  })

  it('удаление проекта сдвигает курсор страниц на единицу', async () => {
    mocks.getProjectsPage.mockResolvedValue(page([project('p1'), project('p2')], 2, 3))
    mocks.deleteProject.mockResolvedValue(undefined)

    await useProjectsStore.getState().loadProjects()
    await useProjectsStore.getState().deleteProject('p1')

    const state = useProjectsStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['p2'])
    expect(state.nextOffset).toBe(1)
  })
})

describe('projectsStore: offline-деградация гибрида (remote_offline)', () => {
  beforeEach(() => {
    mocks.getProjectsPage.mockReset()
    useHybridStore.setState({ remoteDegraded: false })
  })

  it('remote_offline не затирает ранее загруженные remote-проекты, stale=true', async () => {
    const remoteProject: ProjectData = { ...project('remote:p1'), origin: 'remote' }
    useProjectsStore.setState({ projects: [remoteProject], total: 1, stale: false })
    mocks.getProjectsPage.mockResolvedValue({ ...page([]), remote_offline: true })

    await useProjectsStore.getState().loadProjects()

    const s = useProjectsStore.getState()
    expect(s.projects.map((p) => p.id)).toEqual(['remote:p1'])
    expect(s.total).toBe(1)
    expect(s.stale).toBe(true)
    expect(useHybridStore.getState().remoteDegraded).toBe(true)
  })

  it('обычный ответ принимается, stale=false и флаг деградации снят', async () => {
    useHybridStore.setState({ remoteDegraded: true })
    useProjectsStore.setState({ projects: [project('old')], stale: true })
    mocks.getProjectsPage.mockResolvedValue(page([project('new')]))

    await useProjectsStore.getState().loadProjects()

    const s = useProjectsStore.getState()
    expect(s.projects.map((p) => p.id)).toEqual(['new'])
    expect(s.stale).toBe(false)
    expect(useHybridStore.getState().remoteDegraded).toBe(false)
  })
})
