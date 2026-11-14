/**
 * Слияние сводки списка проектов с деталью — состояние доступа (PROP-133).
 *
 * Сводка списка несёт `group_members`/`everyone_role`/`visibility` наравне с
 * деталью. Старый сервер (полей нет) не должен затирать уже загруженное
 * состояние — иначе бейдж режима в дереве «мигал» бы.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProjectData } from '@/lib/api/synthApi'

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
  getProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  publishProject: vi.fn(),
  forkRemoteProject: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))

import { useProjectsStore } from './projectsStore'

function project(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    id: 'p1',
    name: 'p1',
    owner_id: 'u1',
    members: { u1: 'owner' },
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
    ...overrides,
  }
}

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

describe('projectsStore — состояние доступа при слиянии сводки (PROP-133)', () => {
  it('сводка со состоянием доступа обновляет его', async () => {
    mocks.getProjectsPage.mockResolvedValue(
      page([
        project({
          members: { u1: 'owner', u2: 'viewer' },
          group_members: null,
          everyone_role: null,
          visibility: 'selected',
        }),
      ]),
    )

    await useProjectsStore.getState().loadProjects()

    const loaded = useProjectsStore.getState().projects[0]
    expect(loaded.visibility).toBe('selected')
    expect(loaded.everyone_role).toBeNull()
    expect(loaded.group_members).toBeNull()
    expect(loaded.members).toEqual({ u1: 'owner', u2: 'viewer' })
  })

  it('сводка старого сервера (полей нет) не затирает загруженное состояние', async () => {
    useProjectsStore.setState({
      projects: [
        project({
          members: { u1: 'owner', u2: 'editor' },
          group_members: { team: 'viewer' },
          everyone_role: 'viewer',
          visibility: 'all',
        }),
      ],
    } as never)
    // Старый сервер: полей состояния доступа в сводке нет вовсе.
    mocks.getProjectsPage.mockResolvedValue(page([project()]))

    await useProjectsStore.getState().loadProjects()

    const loaded = useProjectsStore.getState().projects[0]
    expect(loaded.visibility).toBe('all')
    expect(loaded.everyone_role).toBe('viewer')
    expect(loaded.group_members).toEqual({ team: 'viewer' })
  })

  it('«не опубликован» (`everyone_role: null`) — авторитетное значение, а не «неизвестно»', async () => {
    useProjectsStore.setState({
      projects: [project({ everyone_role: 'editor', visibility: 'all' })],
    } as never)
    mocks.getProjectsPage.mockResolvedValue(
      page([project({ everyone_role: null, visibility: 'author' })]),
    )

    await useProjectsStore.getState().loadProjects()

    const loaded = useProjectsStore.getState().projects[0]
    expect(loaded.everyone_role).toBeNull()
    expect(loaded.visibility).toBe('author')
  })
})
