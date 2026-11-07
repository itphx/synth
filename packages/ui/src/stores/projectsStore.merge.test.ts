/**
 * Слияние сводки списка проектов с уже загруженной деталью (PROP-054).
 *
 * Список проектов — **сводки** (ADR-118 §4): тяжёлых полей `plan` в них нет.
 * Если деталь проекта уже загружена (вкладка «Проект» открыта), `loadProjects()`
 * не должна затирать её план — иначе панель показывала бы пустой план.
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

const PLAN = {
  version: 2,
  updatedAt: '2026-01-01T00:00:00.000Z',
  columns: [{ id: 'c1', name: 'Backlog', order: 0 }],
  items: [
    {
      id: 'i1',
      title: 'Пункт',
      columnId: 'c1',
      priority: 'medium' as const,
      order: 0,
      dependsOn: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
}

function project(id: string, plan?: ProjectData['plan']): ProjectData {
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
    ...(plan !== undefined ? { plan } : {}),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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

describe('projectsStore — слияние сводки с деталью (PROP-054)', () => {
  it('loadProjects не обнуляет уже загруженный план', async () => {
    // В сторе — деталь проекта (план загружен).
    useProjectsStore.setState({ projects: [project('p1', PLAN)] } as never)
    // Сервер отдаёт сводку — без плана.
    mocks.getProjectsPage.mockResolvedValue(page([project('p1')]))

    await useProjectsStore.getState().loadProjects()

    const loaded = useProjectsStore.getState().projects[0]
    expect(loaded.id).toBe('p1')
    expect(loaded.plan).toEqual(PLAN)
  })

  it('сводка обновляет обычные поля, но не стирает план', async () => {
    useProjectsStore.setState({ projects: [project('p1', PLAN)] } as never)
    mocks.getProjectsPage.mockResolvedValue(page([{ ...project('p1'), name: 'Переименован' }]))

    await useProjectsStore.getState().loadProjects()

    const loaded = useProjectsStore.getState().projects[0]
    expect(loaded.name).toBe('Переименован')
    expect(loaded.plan).toEqual(PLAN)
  })

  it('пришедшая с планом сводка авторитетна', async () => {
    const newer = { ...PLAN, version: 5 }
    useProjectsStore.setState({ projects: [project('p1', PLAN)] } as never)
    mocks.getProjectsPage.mockResolvedValue(page([project('p1', newer)]))

    await useProjectsStore.getState().loadProjects()

    expect(useProjectsStore.getState().projects[0].plan?.version).toBe(5)
  })

  it('состав и порядок проектов — как в ответе сервера', async () => {
    useProjectsStore.setState({ projects: [project('p1', PLAN)] } as never)
    mocks.getProjectsPage.mockResolvedValue(page([project('p2'), project('p1')]))

    await useProjectsStore.getState().loadProjects()

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(['p2', 'p1'])
  })
})
