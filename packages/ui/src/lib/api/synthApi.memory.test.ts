import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `memory` (`lib/api/memory.ts`, ADR-107 / PROP-047): портал памяти —
 * состояние, факты и индексы плюс операции с индексами. Ценно — пути, дефолты
 * выборки (статус `active`, страница 50), тела мутаций и 204 без тела.
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

describe('memoryApi — портал памяти (ADR-107)', () => {
  it('getMemoryStatus: GET /memory/status', async () => {
    const status = {
      provider: { id: 'plugin:memory:rag', mode: 'inline' as const, active: true },
      readiness: 'ready' as const,
      namespace: 'plugin:synth-plugin-memory',
      facts: { total: 12, active: 9 },
      indexes: { total: 4, ready: 2, stale: 1, failed: 1, building: 0 },
    }
    fetchMock.mockResolvedValue(jsonResponse(status))

    await expect(synthApi.getMemoryStatus()).resolves.toEqual(status)
    expect(urlOf(0)).toBe('/api/v2/memory/status')
  })

  it('listMemoryFacts: дефолты — status=active, limit=50, offset=0', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }))

    await synthApi.listMemoryFacts()

    expect(urlOf(0)).toBe('/api/v2/memory/facts?status=active&limit=50&offset=0')
  })

  it('listMemoryFacts: фильтры уходят в query-строку', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0, limit: 50, offset: 50 }))

    await synthApi.listMemoryFacts({
      query: 'Fleet',
      kind: 'decision',
      status: 'superseded',
      projectId: 'project-1',
      limit: 50,
      offset: 50,
    })

    const url = urlOf(0)
    expect(url.startsWith('/api/v2/memory/facts?')).toBe(true)
    expect(url).toContain('query=Fleet')
    expect(url).toContain('kind=decision')
    expect(url).toContain('status=superseded')
    expect(url).toContain('projectId=project-1')
    expect(url).toContain('limit=50')
    expect(url).toContain('offset=50')
  })

  it('getMemoryFact: GET /memory/facts/:id, id кодируется', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'fact/1' }))

    await synthApi.getMemoryFact('fact/1')

    expect(urlOf(0)).toBe('/api/v2/memory/facts/fact%2F1')
  })

  it('listMemoryIndexes: GET /memory/indexes, фильтры опциональны', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0 }))

    await synthApi.listMemoryIndexes()
    expect(urlOf(0)).toBe('/api/v2/memory/indexes')

    await synthApi.listMemoryIndexes({ projectId: 'project-1', state: 'failed' })
    expect(urlOf(1)).toBe('/api/v2/memory/indexes?projectId=project-1&state=failed')
  })

  it('404 по факту: ошибка несёт status и code для UI', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'MEMORY_FACT_NOT_FOUND', message: 'fact not found' } }, 404),
    )

    await expect(synthApi.getMemoryFact('missing')).rejects.toMatchObject({
      status: 404,
      code: 'MEMORY_FACT_NOT_FOUND',
    })
  })
})

describe('memoryApi — операции с индексами', () => {
  const index = { id: 'index-1', name: 'project', state: 'building' }

  it('createMemoryIndex: POST /memory/indexes с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ index }, 202))

    await expect(
      synthApi.createMemoryIndex({
        name: 'project',
        source: { kind: 'files' },
        projectId: 'project-1',
      }),
    ).resolves.toEqual({ index })

    expect(urlOf(0)).toBe('/api/v2/memory/indexes')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'project',
      source: { kind: 'files' },
      projectId: 'project-1',
    })
  })

  it('rebuildMemoryIndex: POST /memory/indexes/:id/rebuild, id кодируется', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ index }, 202))

    await synthApi.rebuildMemoryIndex('index 1')
    expect(urlOf(0)).toBe('/api/v2/memory/indexes/index%201/rebuild')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({})

    await synthApi.rebuildMemoryIndex('index-1', { force: true })
    expect(urlOf(1)).toBe('/api/v2/memory/indexes/index-1/rebuild')
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      force: true,
    })
  })

  it('deleteMemoryIndex: DELETE /memory/indexes/:id — 204 без тела', async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined, 204))

    await expect(synthApi.deleteMemoryIndex('index 1')).resolves.toBeUndefined()

    expect(urlOf(0)).toBe('/api/v2/memory/indexes/index%201')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE')
  })

  it('409 по провайдеру: ошибка несёт status и code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'MEMORY_PROVIDER_UNAVAILABLE', message: 'provider is not active' } },
        409,
      ),
    )

    await expect(synthApi.rebuildMemoryIndex('index-1')).rejects.toMatchObject({
      status: 409,
      code: 'MEMORY_PROVIDER_UNAVAILABLE',
      message: 'provider is not active',
    })
  })

  it('422 по сборке: ошибка несёт status и текст сервера', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'MEMORY_INDEX_FAILED', message: 'embedding provider is not configured' } },
        422,
      ),
    )

    await expect(synthApi.createMemoryIndex({ name: 'project' })).rejects.toMatchObject({
      status: 422,
      code: 'MEMORY_INDEX_FAILED',
      message: 'embedding provider is not configured',
    })
  })
})
