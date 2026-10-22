import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'
import { filenameFromContentDisposition } from './analytics'

/**
 * Домен `analytics` (ADR-102 §4/§6): пути/query отчётов и выгрузки, разбор
 * `Content-Disposition` и контракт ошибок (403 `FORBIDDEN` без особого типа).
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

const REPORT = {
  report: 'usage',
  from: '2026-09-19',
  to: '2026-10-18',
  groupBy: ['model', 'agent'],
  rows: [],
}

describe('analyticsApi — отчёты', () => {
  it('getAnalyticsUsage: from/to/groupBy через запятую, пустые фильтры не отправляются', async () => {
    fetchMock.mockResolvedValue(jsonResponse(REPORT))

    const result = await synthApi.getAnalyticsUsage({
      from: '2026-09-19',
      to: '2026-10-18',
      groupBy: ['model', 'agent'],
      userId: '',
      projectId: 'p1',
    })

    expect(result).toEqual(REPORT)
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      '/api/v2/analytics/usage?from=2026-09-19&to=2026-10-18&groupBy=model%2Cagent&projectId=p1',
    )
    expect(options).toEqual(expect.objectContaining({ credentials: 'include' }))
  })

  it('getAnalyticsSummary: только from/to', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...REPORT, usage: {}, activity: {}, decision: {} }))

    await synthApi.getAnalyticsSummary({ from: '2026-09-19', to: '2026-10-18' })

    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/v2/analytics/summary?from=2026-09-19&to=2026-10-18',
    )
  })

  it('getAnalyticsDecision сохраняет 403-контракт (status/code) для UI', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав для отчёта' } }, 403),
    )

    await expect(synthApi.getAnalyticsDecision({ from: '2026-10-01', to: '2026-10-18' })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Недостаточно прав для отчёта',
    })
  })
})

describe('analyticsApi — выгрузка', () => {
  it('getAnalyticsExport: report/format в query, имя файла из Content-Disposition', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-disposition'
            ? 'attachment; filename="analytics-usage-2026-09-19_2026-10-18.csv"'
            : null,
      },
      blob: async () => new Blob(['a,b'], { type: 'text/csv' }),
    } as unknown as Response)

    const file = await synthApi.getAnalyticsExport({
      report: 'usage',
      format: 'csv',
      from: '2026-09-19',
      to: '2026-10-18',
      groupBy: ['day'],
    })

    expect(file.filename).toBe('analytics-usage-2026-09-19_2026-10-18.csv')
    expect(file.blob).toBeInstanceOf(Blob)
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      '/api/v2/analytics/export?from=2026-09-19&to=2026-10-18&groupBy=day&report=usage&format=csv',
    )
  })

  it('getAnalyticsExport: 403 отдаёт ошибку с кодом (без скачивания)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403),
    )

    await expect(
      synthApi.getAnalyticsExport({ report: 'decision', format: 'json' }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })

  it('filenameFromContentDisposition: fallback-имя и RFC 5987', () => {
    expect(filenameFromContentDisposition(null)).toBeUndefined()
    expect(filenameFromContentDisposition('attachment; filename=report.csv')).toBe('report.csv')
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.csv"),
    ).toBe('отчёт.csv')
  })
})
