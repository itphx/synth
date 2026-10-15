import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `files` (`lib/api/files.ts`, ADR-095): FS API v2. Ценно — точное
 * формирование query-параметров, тела записи, FormData-загрузки и условного
 * `targetProjectId` переноса между проектами.
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

describe('filesApi — листинг и чтение', () => {
  it('listDirectory: обязательный project_id, опциональные path/includeHidden/maxDepth', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [] }))

    await synthApi.listDirectory('p1')
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/fs?project_id=p1', expect.objectContaining({}))

    await synthApi.listDirectory('p1', 'src/sub', true, 10)
    const url = fetchMock.mock.calls[1]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('project_id')).toBe('p1')
    expect(params.get('path')).toBe('src/sub')
    expect(params.get('includeHidden')).toBe('true')
    expect(params.get('maxDepth')).toBe('10')
  })

  it('listDirectory: скрытые и maxDepth не передаются при false/0/undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [] }))

    await synthApi.listDirectory('p1', '', false, 0)

    const url = fetchMock.mock.calls[0]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.has('path')).toBe(false)
    expect(params.has('includeHidden')).toBe(false)
    expect(params.has('maxDepth')).toBe(false)
  })

  it('readFile: GET /fs/read с project_id и path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: 'x' }))

    await synthApi.readFile('p1', 'a/b.txt')

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url.startsWith('/api/v2/fs/read?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('project_id')).toBe('p1')
    expect(params.get('path')).toBe('a/b.txt')
  })

  it('writeFile: POST /fs/write с телом camelCase', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: 'x' }))

    await synthApi.writeFile('p1', 'a.txt', 'hello')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/fs/write',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', path: 'a.txt', content: 'hello' }),
      }),
    )
  })

  it('uploadFile: FormData с project_id/path/file, credentials=include, без JSON-Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'a/f.txt', name: 'f.txt' }))
    const file = new File(['data'], 'f.txt', { type: 'text/plain' })

    const result = await synthApi.uploadFile('p1', 'a', file)

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('/api/v2/fs/upload')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('project_id')).toBe('p1')
    expect(form.get('path')).toBe('a')
    expect(form.get('file')).toBe(file)
    expect(result).toEqual({ path: 'a/f.txt', name: 'f.txt' })
  })

  it('uploadFile: ошибка → Error из detail/error.error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { error: 'TOO_LARGE' } }, 413))

    await expect(synthApi.uploadFile('p1', '', new File(['x'], 'x'))).rejects.toThrow('TOO_LARGE')
  })
})

describe('filesApi — ссылки, создание, удаление, перенос', () => {
  it('downloadFile: собирает URL, не делает запрос', async () => {
    const url = synthApi.downloadFile('p1', 'a/b.txt')

    expect(fetchMock).not.toHaveBeenCalled()
    const params = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/api/v2/fs/download?')).toBe(true)
    expect(params.get('project_id')).toBe('p1')
    expect(params.get('path')).toBe('a/b.txt')
  })

  it('createDirectory: POST /fs/mkdir с телом camelCase', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ created: true, path: 'a' }))

    await synthApi.createDirectory('p1', 'a')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/fs/mkdir',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'p1', path: 'a' }) }),
    )
  })

  it('deleteEntry: DELETE /fs?project_id=&path=', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: true, path: 'a' }))

    await synthApi.deleteEntry('p1', 'a')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/fs?project_id=p1&path=a',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('moveEntry: POST /fs/move без targetProjectId в теле при same-project переносе', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ moved: true }))

    await synthApi.moveEntry('p1', 'a.txt', 'dir/a.txt')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/fs/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', sourcePath: 'a.txt', targetPath: 'dir/a.txt' }),
      }),
    )
  })

  it('moveEntry: межпроектный перенос добавляет targetProjectId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ moved: true }))

    await synthApi.moveEntry('p1', 'a.txt', 'a.txt', 'p2')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/fs/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', sourcePath: 'a.txt', targetPath: 'a.txt', targetProjectId: 'p2' }),
      }),
    )
  })
})
