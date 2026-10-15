import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домены `messages` (`lib/api/messages.ts`) и `queue` (`lib/api/queue.ts`, API v2).
 * Ценно — условное поле `state` в batch-операции и опциональный `index` в return.
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

describe('messagesApi — сообщения сессии (путь /messages/:sessionId/:index)', () => {
  it('getSessionMessages: GET /sessions/:id/messages с кодированием', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [], session_id: 'a b' }))
    await synthApi.getSessionMessages('a b')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/a%20b/messages',
      expect.objectContaining({}),
    )
  })

  it('toggleMessage / pinMessage: PATCH .../toggle и .../pin', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ disabled: true, success: true }))
    await synthApi.toggleMessage('s1', 3)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/3/toggle',
      expect.objectContaining({ method: 'PATCH' }),
    )

    await synthApi.pinMessage('s1', 3)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/3/pin',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('deleteMessage / retryMessage: DELETE и POST на /:index[/retry]', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }))
    await synthApi.deleteMessage('s1', 2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/2',
      expect.objectContaining({ method: 'DELETE' }),
    )

    await synthApi.retryMessage('s1', 2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/2/retry',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('batchMessages: POST /batch без state, если state не задан', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))

    await synthApi.batchMessages('s1', 'pin', [1, 2])

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/messages/s1/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'pin', indices: [1, 2] }),
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect('state' in body).toBe(false)
  })

  it('batchMessages: state (в т.ч. false) попадает в тело', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))

    await synthApi.batchMessages('s1', 'toggle', [4], false)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/messages/s1/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'toggle', indices: [4], state: false }),
      }),
    )
  })
})

describe('queueApi — очередь сессии (путь /queue/:sessionId)', () => {
  it('clearQueue / resumeQueue: POST /clear и /resume', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)

    await synthApi.clearQueue('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/clear',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.resumeQueue('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/resume',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returnQueue: index добавляется в query только при задании', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ texts: [] }))

    await synthApi.returnQueue('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/return',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.returnQueue('s1', 0)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/return?index=0',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('retryQueueNow / cancelQueueRetry: POST-подпути', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)

    await synthApi.retryQueueNow('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/retry-now',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.cancelQueueRetry('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/cancel-retry',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
