import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { worktreesApi } from './worktrees'

/**
 * Домен `worktrees` (`lib/api/worktrees.ts`, ADR-114): инвентарь git-worktree'ов
 * проекта. Ценно — пути и методы, тело мутаций, `?force=true` при снятии
 * грязного worktree'а и разбор `409 WORKTREE_DIRTY` (`forceRequired`).
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

describe('worktreesApi — инвентарь worktree' + "'ов (ADR-114)", () => {
  it('listWorktrees: GET /projects/:id/worktrees, id кодируется', async () => {
    const worktrees = [{ id: 'wkt_1', projectId: 'p1', name: 'wt', branch: 'feature/x' }]
    fetchMock.mockResolvedValue(jsonResponse({ worktrees }))

    await expect(worktreesApi.listWorktrees('p 1')).resolves.toEqual(worktrees)

    expect(urlOf(0)).toBe('/api/v2/projects/p%201/worktrees')
    expect(methodOf(0)).toBe('GET')
  })

  it('listWorktrees: без поля worktrees отдаёт пустой список', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await expect(worktreesApi.listWorktrees('p1')).resolves.toEqual([])
  })

  it('createWorktree: POST /projects/:id/worktrees с телом', async () => {
    const created = { id: 'wkt_1', projectId: 'p1', name: 'wt', branch: 'feature/x' }
    fetchMock.mockResolvedValue(jsonResponse({ worktree: created, setup: { ok: true } }, 201))

    await expect(
      worktreesApi.createWorktree('p1', { branch: 'feature/x', name: 'wt' }),
    ).resolves.toEqual({ worktree: created, setup: { ok: true } })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/worktrees')
    expect(methodOf(0)).toBe('POST')
    expect(bodyOf(0)).toEqual({ branch: 'feature/x', name: 'wt' })
  })

  it('createWorktree: без полей уходит пустой объект', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ worktree: { id: 'wkt_1' } }, 201))

    await worktreesApi.createWorktree('p1')

    expect(bodyOf(0)).toEqual({})
  })

  it('removeWorktree: DELETE /projects/:id/worktrees/:wid без query', async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined, 204))

    await worktreesApi.removeWorktree('p1', 'wkt 1')

    expect(urlOf(0)).toBe('/api/v2/projects/p1/worktrees/wkt%201')
    expect(methodOf(0)).toBe('DELETE')
    expect(urlOf(0)).not.toContain('force')
  })

  it('removeWorktree: force добавляет ?force=true', async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined, 204))

    await worktreesApi.removeWorktree('p1', 'wkt_1', { force: true })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/worktrees/wkt_1?force=true')
    expect(methodOf(0)).toBe('DELETE')
  })

  it('pruneWorktrees: POST /projects/:id/worktrees/prune', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recordsRemoved: 2, gitPruned: true }))

    await expect(worktreesApi.pruneWorktrees('p1')).resolves.toEqual({
      recordsRemoved: 2,
      gitPruned: true,
    })

    expect(urlOf(0)).toBe('/api/v2/projects/p1/worktrees/prune')
    expect(methodOf(0)).toBe('POST')
  })

  it('bindWorktree: PATCH /sessions/:id с worktreeId', async () => {
    const session = { id: 's1', worktree: { worktree_id: 'wkt_1' } }
    fetchMock.mockResolvedValue(jsonResponse(session))

    await expect(worktreesApi.bindWorktree('s1', 'wkt_1')).resolves.toEqual(session)

    expect(urlOf(0)).toBe('/api/v2/sessions/s1')
    expect(methodOf(0)).toBe('PATCH')
    expect(bodyOf(0)).toEqual({ worktreeId: 'wkt_1' })
  })

  it('bindWorktree: null снимает привязку', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's1', worktree: null }))

    await worktreesApi.bindWorktree('s1', null)

    expect(bodyOf(0)).toEqual({ worktreeId: null })
  })

  it('409 WORKTREE_DIRTY: ошибка несёт status/code/forceRequired', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'WORKTREE_DIRTY', message: 'dirty', forceRequired: true } }, 409),
    )

    const err = await worktreesApi
      .removeWorktree('p1', 'wkt_1')
      .then(() => null)
      .catch((e: unknown) => e as Error & { status?: number; code?: string; forceRequired?: boolean })

    expect(err).toBeTruthy()
    expect(err!.message).toBe('dirty')
    expect(err!.status).toBe(409)
    expect(err!.code).toBe('WORKTREE_DIRTY')
    expect(err!.forceRequired).toBe(true)
  })

  it('прочие 409 без forceRequired: признак остаётся false', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'WORKTREE_BUSY', message: 'busy' } }, 409),
    )

    const err = await worktreesApi
      .removeWorktree('p1', 'wkt_1')
      .then(() => null)
      .catch((e: unknown) => e as Error & { status?: number; code?: string; forceRequired?: boolean })

    expect(err!.status).toBe(409)
    expect(err!.code).toBe('WORKTREE_BUSY')
    expect(err!.forceRequired).toBe(false)
  })
})
