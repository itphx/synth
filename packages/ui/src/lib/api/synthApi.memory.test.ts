import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `memory` (`lib/api/memory.ts`, ADR-107 / PROP-047): портал памяти —
 * read-only просмотр состояния, фактов и индексов. Ценно — пути, дефолты
 * выборки (статус `active`, страница 50) и отсутствие мутаций.
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
