import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `projectsApi` (`lib/api/projects.ts`): список проектов приходит
 * **страницей** (`GET /projects` → `{projects, total, offset, limit,
 * next_offset}`), а `getProjects()` — обёртка над страницей для потребителей,
 * которым нужен массив.
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

const PROJECT = {
  id: 'p1',
  name: 'Proj',
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

/** URL последнего запроса. */
function lastUrl(): string {
  return String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0])
}

describe('projectsApi — страница списка проектов', () => {
  it('getProjectsPage: GET /projects без параметров — серверный дефолт', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      projects: [PROJECT],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    }))

    const result = await synthApi.getProjectsPage()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/projects', expect.objectContaining({}))
    expect(result.projects).toHaveLength(1)
    expect(result.total).toBe(1)
    expect(result.next_offset).toBeNull()
  })

  it('getProjectsPage: limit/offset уходят в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      projects: [],
      total: 0,
      offset: 100,
      limit: 100,
      next_offset: null,
    }))

    await synthApi.getProjectsPage({ limit: 100, offset: 100 })

    expect(lastUrl()).toContain('/api/v2/projects?')
    expect(lastUrl()).toContain('limit=100')
    expect(lastUrl()).toContain('offset=100')
  })

  it('getProjects: обёртка собирает все страницы в массив', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      projects: [PROJECT],
      total: 2,
      offset: 0,
      limit: 500,
      next_offset: 1,
    }))
    fetchMock.mockResolvedValueOnce(jsonResponse({
      projects: [{ ...PROJECT, id: 'p2' }],
      total: 2,
      offset: 1,
      limit: 500,
      next_offset: null,
    }))

    const projects = await synthApi.getProjects()

    expect(projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('getProjects: пустой ответ — пустой массив', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }))

    await expect(synthApi.getProjects()).resolves.toEqual([])
  })
})
