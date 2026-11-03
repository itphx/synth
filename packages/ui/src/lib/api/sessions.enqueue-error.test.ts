/**
 * `sessionsApi.enqueueMessage` — ошибки приёма сообщения не теряют машинный код.
 *
 * После перевода на `fetchJSON` `PROVIDER_DISABLED`/`MODEL_DISABLED` приходят
 * с `status`/`code`/`details`, а успешный `202 {messageId, mode, position}`
 * разбирается как раньше (старый сервер без этих полей — мягкий фоллбек).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sessionsApi } from './sessions'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('sessionsApi.enqueueMessage', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('400 PROVIDER_DISABLED доносит status/code/details', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error: {
        code: 'PROVIDER_DISABLED',
        message: 'Провайдер «off» отключён — выберите другую модель',
        details: { provider: 'off' },
      },
    }))

    const promise = sessionsApi.enqueueMessage('s1', 'привет')
    await expect(promise).rejects.toMatchObject({
      message: 'Провайдер «off» отключён — выберите другую модель',
      status: 400,
      code: 'PROVIDER_DISABLED',
      details: { provider: 'off' },
    })
  })

  it('400 MODEL_DISABLED доносит provider+model в details', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error: {
        code: 'MODEL_DISABLED',
        message: 'Модель p/m отключена — выберите другую модель',
        details: { provider: 'p', model: 'm' },
      },
    }))

    await expect(sessionsApi.enqueueMessage('s1', 'привет')).rejects.toMatchObject({
      status: 400,
      code: 'MODEL_DISABLED',
      details: { provider: 'p', model: 'm' },
    })
  })

  it('202 {messageId, mode, position} разбирается как контракт приёма', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      messageId: 'srv-1',
      mode: 'steer',
      position: null,
    }))

    await expect(sessionsApi.enqueueMessage('s1', 'привет', { mode: 'steer' })).resolves.toEqual({
      messageId: 'srv-1',
      mode: 'steer',
      position: null,
    })
  })

  it('старый сервер (2xx без полей) → queue с клиентским messageId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    const result = await sessionsApi.enqueueMessage('s1', 'привет', { streamId: 'client-1' })
    expect(result).toEqual({ messageId: 'client-1', mode: 'queue', position: null })
  })
})
