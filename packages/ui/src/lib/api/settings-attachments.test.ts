import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `settings-attachments` (`lib/api/settings-attachments.ts`, ADR-115):
 * runtime-настройки вложений. Ценно — пути/методы/тело запроса: настройки
 * вложений редактируются черновиком и должны уходить частичным патчем.
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

const ATTACHMENTS = {
  enabled: true,
  modalities: { image: true, pdf: true, audio: false, video: false },
  maxBytesPerFile: 10 * 1024 * 1024,
  maxFilesPerMessage: 5,
  maxBytesPerSession: 100 * 1024 * 1024,
  gcDays: 7,
  workspaceFallback: false,
  allowedMimePrefixes: ['image/', 'application/pdf'],
}

const INFO = {
  attachments: ATTACHMENTS,
  defaults: ATTACHMENTS,
  isOverridden: false,
  source: 'default' as const,
  envLocked: [] as string[],
  restartRequired: false,
  running: ATTACHMENTS,
}

describe('attachmentsApi — runtime-настройки вложений (ADR-115)', () => {
  it('getAttachmentsSettings: GET /settings/attachments', async () => {
    fetchMock.mockResolvedValue(jsonResponse(INFO))

    await expect(synthApi.getAttachmentsSettings()).resolves.toEqual(INFO)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/attachments',
      expect.objectContaining({}),
    )
  })

  it('updateAttachmentsSettings: PUT с телом {attachments: patch}', async () => {
    const body = { ...INFO, isOverridden: true, source: 'runtime' as const }
    fetchMock.mockResolvedValue(jsonResponse(body))

    const patch = { enabled: false, modalities: ATTACHMENTS.modalities }
    await expect(synthApi.updateAttachmentsSettings(patch)).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/attachments',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ attachments: patch }),
      }),
    )
  })

  it('resetAttachmentsSettings: DELETE /settings/attachments', async () => {
    fetchMock.mockResolvedValue(jsonResponse(INFO))

    await expect(synthApi.resetAttachmentsSettings()).resolves.toEqual(INFO)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/settings/attachments',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('прокидывает сообщение и статус ошибки API', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'admin only' } }, 403),
    )

    await expect(synthApi.getAttachmentsSettings()).rejects.toMatchObject({
      message: 'admin only',
      status: 403,
      code: 'FORBIDDEN',
    })
  })
})
