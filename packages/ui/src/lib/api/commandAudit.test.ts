import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `commandAudit` (`lib/api/commandAudit.ts`): журнал исполнений команд
 * shell (PROP-136a). Ценно — путь/метод/query (сервер жёстко валидирует
 * `decision`/`limit`/`older_than_days`) и разворачивание ответа.
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

const ENTRY = {
  id: 'exec-1',
  ts: '2026-11-12T10:00:00.000Z',
  sessionId: 'ses-1',
  projectId: 'prj-1',
  tool: 'execute_shell' as const,
  command: 'ls -la',
  commandHash: 'abc',
  cwd: '/work',
  background: false,
  decision: 'allow' as const,
  decidedBy: 'permission' as const,
  phase: 'started' as const,
}

describe('commandAuditApi — чтение журнала', () => {
  it('getCommandAudit: GET /audit/commands с фильтрами (snake_case в query)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [ENTRY], count: 1 }))

    const result = await synthApi.getCommandAudit({
      sessionId: 'ses-1',
      projectId: 'prj-1',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-30T23:59:59.000Z',
      decision: 'deny',
      limit: 50,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/audit/commands?session_id=ses-1&project_id=prj-1&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-30T23%3A59%3A59.000Z&decision=deny&limit=50',
      expect.objectContaining({}),
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.command).toBe('ls -la')
    expect(result.count).toBe(1)
  })

  it('getCommandAudit без фильтров не добавляет query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], count: 0 }))

    await synthApi.getCommandAudit()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/audit/commands', expect.objectContaining({}))
  })

  it('getCommandAudit: пустые строки фильтров не попадают в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], count: 0 }))

    await synthApi.getCommandAudit({ sessionId: '', projectId: '', decision: undefined, limit: 100 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/audit/commands?limit=100',
      expect.objectContaining({}),
    )
  })

  it('getCommandAudit: ошибка 403 пробрасывается с кодом', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403),
    )

    await expect(synthApi.getCommandAudit()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it('getCommandAudit: ошибка 503 пробрасывается с кодом', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: 'no journal' } }, 503),
    )

    await expect(synthApi.getCommandAudit()).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    })
  })
})

describe('commandAuditApi — retention-очистка', () => {
  it('pruneCommandAudit: DELETE /audit/commands?older_than_days=N → {removed}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ removed: 7 }))

    const result = await synthApi.pruneCommandAudit(30)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/audit/commands?older_than_days=30',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(result.removed).toBe(7)
  })

  it('pruneCommandAudit: ошибка 403 (не ADMIN) пробрасывается', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403),
    )

    await expect(synthApi.pruneCommandAudit(30)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })
})
