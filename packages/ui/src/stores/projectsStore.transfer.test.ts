/**
 * ADR-140 Ф3: передача владения проектом — стор `projectsStore`.
 *
 * Передача — мутация с побочным эффектом в списке (новый владелец), поэтому
 * запись в сторе обновляется сразу. Ошибка **пробрасывается** вызывающему:
 * UI различает `403` (нет права) и `400` (недопустимый получатель).
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
  getProjectsPage: vi.fn(),
  getProject: vi.fn(),
  transferProject: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    projects: [project()],
    loading: false,
    error: null,
    total: 1,
    nextOffset: null,
    loadingMore: false,
  } as never)
})

describe('projectsStore — передача владения (ADR-140 Ф3)', () => {
  it('вызывает API и обновляет владельца в списке', async () => {
    mocks.transferProject.mockResolvedValue(
      project({ owner_id: 'u2', members: { u2: 'owner', u1: 'editor' } }),
    )

    const updated = await useProjectsStore.getState().transferProject('p1', 'u2')

    expect(mocks.transferProject).toHaveBeenCalledTimes(1)
    expect(mocks.transferProject).toHaveBeenCalledWith('p1', 'u2')
    expect(updated?.owner_id).toBe('u2')
    expect(useProjectsStore.getState().projects[0].owner_id).toBe('u2')
    expect(useProjectsStore.getState().projects[0].members).toEqual({ u2: 'owner', u1: 'editor' })
  })

  it('ошибка пробрасывается вызывающему (403/400 различает UI)', async () => {
    mocks.transferProject.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))

    await expect(useProjectsStore.getState().transferProject('p1', 'u2')).rejects.toThrow('forbidden')
    expect(useProjectsStore.getState().error).toBe('forbidden')
    // Запись в списке не тронута.
    expect(useProjectsStore.getState().projects[0].owner_id).toBe('u1')
  })

  it('уже загруженный план не затирается сводкой ответа', async () => {
    useProjectsStore.setState({
      projects: [project({ plan: { columns: [], items: [] } } as never)],
    } as never)
    mocks.transferProject.mockResolvedValue(project({ owner_id: 'u2', plan: null }))

    await useProjectsStore.getState().transferProject('p1', 'u2')

    expect(useProjectsStore.getState().projects[0].plan).toEqual({ columns: [], items: [] })
    expect(useProjectsStore.getState().projects[0].owner_id).toBe('u2')
  })
})
