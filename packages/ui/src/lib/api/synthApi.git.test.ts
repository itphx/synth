import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `git` (`lib/api/git.ts`, ADR-076): реестр репозиториев и история коммитов.
 * Ценно — точные пути/тела и отбрасывание `undefined` в опциональных полях,
 * а также всегда присутствующий `repo_path` в истории коммитов.
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

describe('gitApi — реестр репозиториев', () => {
  it('scanGitRepos: POST /git/scan {projectId}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ repos: [] }))

    await synthApi.scanGitRepos('p1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/git/scan',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'p1' }) }),
    )
  })

  it('initGitRepo: POST /git/repos/init, undefined-поля отброшены', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: '.' }))

    await synthApi.initGitRepo('p1', '.')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/git/repos/init',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', path: '.' }),
      }),
    )
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      projectId: 'p1',
      path: '.',
    })
  })

  it('cloneGitRepo: POST /git/repos/clone со всеми заполненными полями', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'lib' }))

    await synthApi.cloneGitRepo('p1', 'git@x:l.git', 'lib', 'main', 'Lib', 'k1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/git/repos/clone',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectId: 'p1',
          url: 'git@x:l.git',
          path: 'lib',
          branch: 'main',
          name: 'Lib',
          sshKeyId: 'k1',
        }),
      }),
    )
  })

  it('registerGitRepo: POST /git/repos/register, запись спредится рядом с projectId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'a' }))

    await synthApi.registerGitRepo('p1', { path: 'a', name: 'A' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/git/repos/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', path: 'a', name: 'A' }),
      }),
    )
  })

  it('removeGitRepo / fetchGitRepo: опции спредится рядом с projectId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deletedLocal: false }))
    await synthApi.removeGitRepo('p1', { id: 'r1', deleteLocal: true })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/git/repos/remove',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', id: 'r1', deleteLocal: true }),
      }),
    )

    fetchMock.mockResolvedValue(jsonResponse({ path: 'a', lastFetch: 'x' }))
    await synthApi.fetchGitRepo('p1', { path: 'a' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/git/repos/fetch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', path: 'a' }),
      }),
    )
  })
})

describe('gitApi — история и детали коммитов', () => {
  it('getCommitLog: repo_path передаётся всегда (в т.ч. пустым), max_count — опционально', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ commits: [] }))

    await synthApi.getCommitLog('p1')

    const url = fetchMock.mock.calls[0]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/api/v2/git/log?')).toBe(true)
    expect(params.get('project_id')).toBe('p1')
    expect(params.has('repo_path')).toBe(true)
    expect(params.get('repo_path')).toBe('')
    expect(params.has('max_count')).toBe(false)

    await synthApi.getCommitLog('p1', 'vendor/lib', 25)
    const params2 = new URLSearchParams((fetchMock.mock.calls[1]![0] as string).split('?')[1])
    expect(params2.get('repo_path')).toBe('vendor/lib')
    expect(params2.get('max_count')).toBe('25')
  })

  it('getCommitDetail: GET /git/commit с project_id/repo_path/hash', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ commit: {} }))

    await synthApi.getCommitDetail('p1', 'lib', 'abc123')

    const url = fetchMock.mock.calls[0]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/api/v2/git/commit?')).toBe(true)
    expect(params.get('project_id')).toBe('p1')
    expect(params.get('repo_path')).toBe('lib')
    expect(params.get('hash')).toBe('abc123')
  })
})
