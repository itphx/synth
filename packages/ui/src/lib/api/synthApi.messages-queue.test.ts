import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'
import { isQueueChangedError } from './queue'

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

describe('messagesApi — сообщения сессии (путь /messages/:sessionId/:messageId)', () => {
  it('getSessionMessages: GET /sessions/:id/messages с кодированием', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [], session_id: 'a b' }))
    await synthApi.getSessionMessages('a b')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/sessions/a%20b/messages',
      expect.objectContaining({}),
    )
  })

  it('toggleMessage / pinMessage: PATCH .../toggle и .../pin по id (ADR-118 §7)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ disabled: true, success: true }))
    await synthApi.toggleMessage('s1', 'msg-3')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/msg-3/toggle',
      expect.objectContaining({ method: 'PATCH' }),
    )

    await synthApi.pinMessage('s1', 'msg-3')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/msg-3/pin',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('deleteMessage / retryMessage: DELETE и POST на /:messageId[/retry]', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }))
    await synthApi.deleteMessage('s1', 'msg-2')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/msg-2',
      expect.objectContaining({ method: 'DELETE' }),
    )

    await synthApi.retryMessage('s1', 'msg-2')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/msg-2/retry',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getMessageDebug: GET .../:messageId/debug по id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message_id: 'msg-7', debug_data: {} }))
    await synthApi.getMessageDebug('s1', 'msg-7')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/msg-7/debug',
      expect.objectContaining({}),
    )
  })

  it('id сообщения кодируется в пути (id с `/` и пробелом)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }))
    await synthApi.deleteMessage('s1', 'remote:a b/c')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/messages/s1/remote%3Aa%20b%2Fc',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('getSessionMessage: точечная загрузка одного сообщения по id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { id: 'm1', role: 'user', content: 'привет' } }))
    const resp = await synthApi.getSessionMessage('a b', 'remote:1/2')

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/sessions/a%20b/messages/remote%3A1%2F2',
      expect.objectContaining({}),
    )
    expect(resp.message.id).toBe('m1')
  })

  it('batchMessages: POST /batch без state, если state не задан', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))

    await synthApi.batchMessages('s1', 'pin', ['msg-1', 'msg-2'])

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/messages/s1/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'pin', messageIds: ['msg-1', 'msg-2'] }),
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect('state' in body).toBe(false)
  })

  it('batchMessages: state (в т.ч. false) попадает в тело', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))

    await synthApi.batchMessages('s1', 'toggle', ['msg-4'], false)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/messages/s1/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'toggle', messageIds: ['msg-4'], state: false }),
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

  it('steerQueue: index уходит в тело только при задании', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ steered: true, pending_count: 1 }))

    const resp = await synthApi.steerQueue('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/steer',
      expect.objectContaining({ method: 'POST' }),
    )
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined()
    expect(resp).toEqual({ steered: true, pending_count: 1 })

    await synthApi.steerQueue('s1', 2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/steer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ index: 2 }),
      }),
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

  it('returnQueue: id приоритетнее index (query ?id=)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ texts: [] }))

    await synthApi.returnQueue('s1', { id: 'msg-1', index: 3 })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/return?id=msg-1',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.returnQueue('s1', { index: 3 })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/return?index=3',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('steerQueue: id уходит в тело и приоритетнее index', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ steered: true, pending_count: 0 }))

    await synthApi.steerQueue('s1', { id: 'msg-1', index: 3 })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/steer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'msg-1' }),
      }),
    )

    await synthApi.steerQueue('s1', { index: 3 })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/steer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ index: 3 }),
      }),
    )
  })

  it('reorderQueue: POST /queue/:id/reorder с полным списком id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    await synthApi.reorderQueue('s1', ['m3', 'm1', 'm2'])

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/queue/s1/reorder',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['m3', 'm1', 'm2'] }),
      }),
    )
  })

  it('reorderQueue 409 QUEUE_CHANGED → ошибка с кодом (перечитать очередь)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      { error: { code: 'QUEUE_CHANGED', message: 'queue changed' } },
      409,
    ))

    const err = await synthApi.reorderQueue('s1', ['m1']).catch((e: unknown) => e)

    expect(isQueueChangedError(err)).toBe(true)
    expect((err as { status?: number }).status).toBe(409)
    expect((err as { code?: string }).code).toBe('QUEUE_CHANGED')
  })

  it('reorderQueue 400 → ошибка без признака «очередь изменилась»', async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      { error: { code: 'VALIDATION_ERROR', message: 'ids required' } },
      400,
    ))

    const err = await synthApi.reorderQueue('s1', []).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(isQueueChangedError(err)).toBe(false)
    expect(isQueueChangedError(undefined)).toBe(false)
  })
})
