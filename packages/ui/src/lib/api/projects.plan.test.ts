import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { projectsApi } from './projects'

/**
 * Домен `projects` — точечные операции с планом, журналом и инвариантами
 * (PROP-054). Ценно — пути/методы, тела мутаций и передача версии плана
 * (оптимистичная блокировка).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const urlOf = (call: number): string => String(fetchMock.mock.calls[call]?.[0])
const initOf = (call: number): RequestInit => (fetchMock.mock.calls[call]?.[1] ?? {}) as RequestInit
const methodOf = (call: number): string => initOf(call).method ?? 'GET'
const bodyOf = (call: number): unknown => JSON.parse(String(initOf(call).body ?? 'null'))

const PLAN = {
  version: 4,
  updatedAt: '2026-11-01T00:00:00.000Z',
  columns: [{ id: 'c1', name: 'Backlog', order: 0 }],
  items: [],
}

describe('projectsApi — план проекта (PROP-054)', () => {
  it('getProjectPlan: GET /projects/:id/plan, id кодируется', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await expect(projectsApi.getProjectPlan('p 1')).resolves.toEqual({ plan: PLAN })

    expect(urlOf(0)).toBe('/api/v2/projects/p%201/plan')
    expect(methodOf(0)).toBe('GET')
  })

  it('createProjectPlanItem: POST .../plan/items с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }, 201))

    await projectsApi.createProjectPlanItem('p1', { title: 'Пункт', columnId: 'c1' })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/items')
    expect(methodOf(0)).toBe('POST')
    expect(bodyOf(0)).toEqual({ title: 'Пункт', columnId: 'c1' })
  })

  it('updateProjectPlanItem: PATCH .../plan/items/:itemId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await projectsApi.updateProjectPlanItem('p1', 'i 1', { title: 'Новый' })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/items/i%201')
    expect(methodOf(0)).toBe('PATCH')
    expect(bodyOf(0)).toEqual({ title: 'Новый' })
  })

  it('moveProjectPlanItem: PATCH .../move с версией плана', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await projectsApi.moveProjectPlanItem('p1', 'i1', { columnId: 'c2', version: 4 })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/items/i1/move')
    expect(methodOf(0)).toBe('PATCH')
    expect(bodyOf(0)).toEqual({ columnId: 'c2', version: 4 })
  })

  it('deleteProjectPlanItem: DELETE .../plan/items/:itemId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await projectsApi.deleteProjectPlanItem('p1', 'i1')

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/items/i1')
    expect(methodOf(0)).toBe('DELETE')
  })

  it('createProjectPlanColumn: POST .../plan/columns', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }, 201))

    await projectsApi.createProjectPlanColumn('p1', { name: 'Doing', wipLimit: 3 })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/columns')
    expect(methodOf(0)).toBe('POST')
    expect(bodyOf(0)).toEqual({ name: 'Doing', wipLimit: 3 })
  })

  it('updateProjectPlanColumn: PATCH .../plan/columns/:columnId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await projectsApi.updateProjectPlanColumn('p1', 'c1', { name: 'Переименовано' })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/columns/c1')
    expect(methodOf(0)).toBe('PATCH')
    expect(bodyOf(0)).toEqual({ name: 'Переименовано' })
  })

  it('deleteProjectPlanColumn: DELETE .../plan/columns/:columnId с moveItemsTo и версией', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await projectsApi.deleteProjectPlanColumn('p1', 'c1', { moveItemsTo: 'c2', version: 4 })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/columns/c1')
    expect(methodOf(0)).toBe('DELETE')
    expect(bodyOf(0)).toEqual({ moveItemsTo: 'c2', version: 4 })
  })

  it('reorderProjectPlanColumns: PUT .../plan/columns/order', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ plan: PLAN }))

    await projectsApi.reorderProjectPlanColumns('p1', { order: ['c2', 'c1'], version: 4 })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/plan/columns/order')
    expect(methodOf(0)).toBe('PUT')
    expect(bodyOf(0)).toEqual({ order: ['c2', 'c1'], version: 4 })
  })
})

describe('projectsApi — журнал проекта (PROP-054)', () => {
  it('getProjectLogPage: GET .../log с параметрами пагинации', async () => {
    const page = { entries: [], total: 0, offset: 0, limit: 50, next_offset: null }
    fetchMock.mockResolvedValue(jsonResponse(page))

    await expect(projectsApi.getProjectLogPage('p1', { limit: 50, offset: 20 })).resolves.toEqual(page)

    expect(urlOf(0)).toBe('/api/v2/projects/p1/log?limit=50&offset=20')
    expect(methodOf(0)).toBe('GET')
  })

  it('getProjectLogPage: без параметров — без query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], total: 0, offset: 0, limit: 50, next_offset: null }))

    await projectsApi.getProjectLogPage('p1')

    expect(urlOf(0)).toBe('/api/v2/projects/p1/log')
  })

  it('createProjectLogEntry: POST .../log с текстом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entry: { id: 'e1' } }, 201))

    await projectsApi.createProjectLogEntry('p1', { text: 'запись' })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/log')
    expect(methodOf(0)).toBe('POST')
    expect(bodyOf(0)).toEqual({ text: 'запись' })
  })

  it('updateProjectLogEntry: PATCH .../log/:entryId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entry: { id: 'e1' } }))

    await projectsApi.updateProjectLogEntry('p1', 'e1', { text: 'правка' })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/log/e1')
    expect(methodOf(0)).toBe('PATCH')
    expect(bodyOf(0)).toEqual({ text: 'правка' })
  })

  it('deleteProjectLogEntry: DELETE .../log/:entryId', async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined, 204))

    await projectsApi.deleteProjectLogEntry('p1', 'e1')

    expect(urlOf(0)).toBe('/api/v2/projects/p1/log/e1')
    expect(methodOf(0)).toBe('DELETE')
  })
})

describe('projectsApi — инварианты проекта (PROP-054)', () => {
  it('getProjectInvariants: GET .../invariants', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invariants: 'правило', updated_at: '2026-11-01T00:00:00.000Z' }))

    await expect(projectsApi.getProjectInvariants('p1')).resolves.toEqual({
      invariants: 'правило',
      updated_at: '2026-11-01T00:00:00.000Z',
    })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/invariants')
    expect(methodOf(0)).toBe('GET')
  })

  it('putProjectInvariants: PUT .../invariants с текстом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invariants: 'правило', updated_at: '2026-11-02T00:00:00.000Z' }))

    await projectsApi.putProjectInvariants('p1', { invariants: 'правило' })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/invariants')
    expect(methodOf(0)).toBe('PUT')
    expect(bodyOf(0)).toEqual({ invariants: 'правило' })
  })
})
