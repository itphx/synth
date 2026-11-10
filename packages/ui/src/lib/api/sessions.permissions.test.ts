import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sessionsApi } from './sessions'

/**
 * Домен `sessions` — ожидающие подтверждения прав (`GET /sessions/:id/permissions`).
 *
 * Запрос подтверждения живёт только как live-событие `permission.asked`:
 * после перезагрузки страницы клиент о нём не знает — карточка пропадает, а
 * инструмент висит до ask-таймаута. Снимок с сервера — источник истины для
 * восстановления карточки (ADR-029).
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
const methodOf = (call: number): string => (fetchMock.mock.calls[call]?.[1]?.method ?? 'GET')

describe('sessionsApi — ожидающие подтверждения прав', () => {
  it('listPendingPermissions: GET /sessions/:id/permissions', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ permissions: [] }))

    await expect(sessionsApi.listPendingPermissions('s 1')).resolves.toEqual([])

    expect(urlOf(0)).toBe('/api/v2/sessions/s%201/permissions')
    expect(methodOf(0)).toBe('GET')
  })

  it('разбирает snake_case в запись стора (camelCase)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        permissions: [
          {
            approval_id: 'apr_1',
            tool: 'write_file',
            arguments: { path: '/tmp/a' },
            reason: 'нужно записать',
            asked_at: '2026-01-01T12:00:00.000Z',
            ask_timeout_ms: 30_000,
            held: false,
          },
        ],
      }),
    )

    const [request] = await sessionsApi.listPendingPermissions('s1')

    expect(request).toMatchObject({
      approvalId: 'apr_1',
      toolName: 'write_file',
      params: { path: '/tmp/a' },
      reason: 'нужно записать',
      askedAt: '2026-01-01T12:00:00.000Z',
      timeoutMs: 30_000,
    })
    expect(request!.held).toBeUndefined()
  })

  it('held-запрос помечается: таймер для него не ставится', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        permissions: [
          {
            approval_id: 'apr_1',
            tool: 'execute_shell',
            asked_at: '2026-01-01T12:00:00.000Z',
            ask_timeout_ms: 0,
            held: true,
          },
        ],
      }),
    )

    const [request] = await sessionsApi.listPendingPermissions('s1')

    expect(request!.held).toBe(true)
    // ask_timeout_ms = 0 — «без таймаута»: значение сохраняется как есть.
    expect(request!.timeoutMs).toBe(0)
  })

  it('превью и shell-паттерны переносятся в запись', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        permissions: [
          {
            approval_id: 'apr_1',
            tool: 'execute_shell',
            asked_at: '2026-01-01T12:00:00.000Z',
            ask_timeout_ms: 30_000,
            save: ['git status *'],
            preview: {
              files: [{ path: 'a.txt', diff: '+x', additions: 1, deletions: 0 }],
            },
          },
        ],
      }),
    )

    const [request] = await sessionsApi.listPendingPermissions('s1')

    expect(request!.save).toEqual(['git status *'])
    expect(request!.preview?.files?.[0]?.path).toBe('a.txt')
  })

  it('запись без approval_id пропускается', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ permissions: [{ tool: 'read_file' }, { approval_id: 'apr_1' }] }),
    )

    const requests = await sessionsApi.listPendingPermissions('s1')

    expect(requests.map((r) => r.approvalId)).toEqual(['apr_1'])
  })
})
