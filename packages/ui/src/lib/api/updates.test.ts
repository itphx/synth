import { describe, it, expect, afterEach, vi } from 'vitest'

import {
  isUpdateUnsupported,
  updatesApi,
  updateErrorMessage,
  updateErrorStatus,
  type UpdateApplyEvent,
} from './updates'

/** Потоковый ответ с SSE-кадрами, разрезанными на произвольные куски. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    body: stream,
    json: async () => ({}),
  } as unknown as Response
}

/** Ошибка ответа: `{error:{code,message}}` → понятный текст и машиночитаемый код. */
function errorResponse(status: number, code: string, message: string): Response {
  return {
    ok: false,
    status,
    body: null,
    json: async () => ({ error: { code, message } }),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('updatesApi.applyUpdate (ADR-133)', () => {
  it('читает SSE построчно, склеивает разрезанные кадры и отдаёт события по порядку', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"start","message":"npm ins',
        'tall"}\n\ndata: {"type":"progress","data":"added 1 package"}\n',
        '\ndata: {"type":"done","version":"0.20.0","restartScheduled":true,"message":"ok"}',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const events: UpdateApplyEvent[] = []
    await updatesApi.applyUpdate(
      { version: '0.20.0', channel: 'stable', restart: true },
      (event) => events.push(event),
    )

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/updates/apply',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ version: '0.20.0', channel: 'stable', restart: true }),
      }),
    )
    expect(events).toEqual([
      { type: 'start', message: 'npm install' },
      { type: 'progress', data: 'added 1 package' },
      { type: 'done', version: '0.20.0', restartScheduled: true, message: 'ok' },
    ])
  })

  it('отменяет чтение по AbortSignal — поток закрывается, ошибка не бросается', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'))
        // Поток не закрывается: отмена должна прервать чтение.
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
        json: async () => ({}),
      } as unknown as Response),
    )

    const controller = new AbortController()
    const events: UpdateApplyEvent[] = []
    const promise = updatesApi.applyUpdate({ restart: false }, (event) => events.push(event), controller.signal)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    controller.abort()
    await promise

    expect(cancelled).toBe(true)
    expect(events).toEqual([{ type: 'start' }])
  })

  it('409 UPDATE_UNSUPPORTED разбирается в понятную ошибку с кодом и статусом', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(409, 'UPDATE_UNSUPPORTED', 'instance is managed by Helm'),
      ),
    )

    const error = await updatesApi.applyUpdate({ restart: false }, () => undefined).catch((err: unknown) => err)

    expect(isUpdateUnsupported(error)).toBe(true)
    expect(updateErrorStatus(error)).toBe(409)
    expect(updateErrorMessage(error, 'fallback')).toBe('instance is managed by Helm')
  })

  it('текст ошибки не подменяется «сырым» JSON и имеет фоллбек', () => {
    expect(updateErrorMessage(new Error('boom'), 'fallback')).toBe('boom')
    expect(updateErrorMessage('not-an-error', 'fallback')).toBe('fallback')
    expect(updateErrorMessage(new Error('  '), 'fallback')).toBe('fallback')
  })
})

describe('updatesApi.getUpdatesSettings — lastCheck (ADR-133)', () => {
  const LAST_CHECK = {
    checkedAt: '2026-11-11T10:00:00.000Z',
    channel: 'stable',
    currentVersion: '0.19.0',
    latestVersion: '0.20.0',
    hasUpdate: true,
    stale: false,
  }

  /** Успешный JSON-ответ сервера настроек. */
  function stubSettings(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as unknown as Response),
    )
  }

  it('разбирает lastCheck', async () => {
    stubSettings({ check: true, lastCheck: LAST_CHECK })
    expect((await updatesApi.getUpdatesSettings()).lastCheck).toEqual(LAST_CHECK)
  })

  it('нет поля — null (старый сервер)', async () => {
    stubSettings({ check: false })
    expect((await updatesApi.getUpdatesSettings()).lastCheck).toBeNull()
  })

  it('битая запись — null, остальные поля целы', async () => {
    stubSettings({
      check: true,
      intervalHours: 12,
      lastCheck: { checkedAt: 42, latestVersion: '0.20.0' },
    })
    const settings = await updatesApi.getUpdatesSettings()
    expect(settings.lastCheck).toBeNull()
    expect(settings.check).toBe(true)
    expect(settings.intervalHours).toBe(12)
  })

  it('неизвестный канал в записи → stable; флаги — строго boolean', async () => {
    stubSettings({ lastCheck: { ...LAST_CHECK, channel: 'gamma', hasUpdate: 'yes' } })
    expect((await updatesApi.getUpdatesSettings()).lastCheck).toMatchObject({
      channel: 'stable',
      hasUpdate: false,
      stale: false,
    })
  })

  it('error сохраняется строкой', async () => {
    stubSettings({ lastCheck: { ...LAST_CHECK, error: 'ETIMEDOUT' } })
    expect((await updatesApi.getUpdatesSettings()).lastCheck?.error).toBe('ETIMEDOUT')
  })
})
