import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import {
  DEFAULT_STICKY_NOTES_LIMITS,
  deleteStickyNotesLimits,
  fetchStickyNotesLimits,
  getStickyNotesLimits,
  getStickyNotesLimitsState,
  loadStickyNotesLimits,
  putStickyNotesLimits,
  resetStickyNotesLimitsCache,
  stickyNoteErrorKey,
} from './stickyNotesLimits'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  resetStickyNotesLimitsCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetStickyNotesLimitsCache()
})

describe('fetchStickyNotesLimits / деградация', () => {
  it('читает limits и источник из ответа', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => jsonResponse({
      limits: { maxCount: 25, maxChars: 500 },
      saved: { maxCount: 25 },
      defaults: { maxCount: 50, maxChars: 2000 },
      source: 'runtime',
      restartRequired: false,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = await fetchStickyNotesLimits()
    expect(settings.limits).toEqual({ maxCount: 25, maxChars: 500 })
    expect(settings.saved).toEqual({ maxCount: 25 })
    expect(settings.source).toBe('runtime')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v2/settings/sticky-notes')
  })

  it('пустой/битый ответ → дефолты 50/2000', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}) ))
    const settings = await fetchStickyNotesLimits()
    expect(settings.limits).toEqual(DEFAULT_STICKY_NOTES_LIMITS)
    expect(settings.defaults).toEqual(DEFAULT_STICKY_NOTES_LIMITS)
  })

  it('понимает плоскую форму без обёртки limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ maxCount: 7, maxChars: 100 })))
    const settings = await fetchStickyNotesLimits()
    expect(settings.limits).toEqual({ maxCount: 7, maxChars: 100 })
  })

  it('404/сеть → дефолты, строгий вызов бросает', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND' } }, 404)))
    await expect(fetchStickyNotesLimits()).rejects.toMatchObject({ status: 404 })

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))
    await expect(fetchStickyNotesLimits()).rejects.toBeInstanceOf(TypeError)
  })
})

describe('кэш на модуль', () => {
  it('до загрузки — дефолт и loaded=false', () => {
    expect(getStickyNotesLimits()).toEqual(DEFAULT_STICKY_NOTES_LIMITS)
    expect(getStickyNotesLimitsState().loaded).toBe(false)
  })

  it('успешная загрузка кэшируется: второй вызов не ходит в сеть', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ limits: { maxCount: 10, maxChars: 300 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadStickyNotesLimits()).resolves.toEqual({ maxCount: 10, maxChars: 300 })
    await expect(loadStickyNotesLimits()).resolves.toEqual({ maxCount: 10, maxChars: 300 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getStickyNotesLimitsState().loaded).toBe(true)
  })

  it('параллельные вызовы делят один запрос', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ limits: { maxCount: 5, maxChars: 200 } }))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([loadStickyNotesLimits(), loadStickyNotesLimits()])
    expect(a).toEqual({ maxCount: 5, maxChars: 200 })
    expect(b).toEqual({ maxCount: 5, maxChars: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('сеть/500 → дефолты и loaded=false (доля в UI не показывается)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'boom' }, 500)))
    await expect(loadStickyNotesLimits()).resolves.toEqual(DEFAULT_STICKY_NOTES_LIMITS)
    expect(getStickyNotesLimits()).toEqual(DEFAULT_STICKY_NOTES_LIMITS)
    expect(getStickyNotesLimitsState().loaded).toBe(false)
  })

  it('resetStickyNotesLimitsCache(limits) задаёт значение без API', () => {
    resetStickyNotesLimitsCache({ maxCount: 3, maxChars: 40 })
    expect(getStickyNotesLimits()).toEqual({ maxCount: 3, maxChars: 40 })
    expect(getStickyNotesLimitsState().loaded).toBe(true)
  })
})

describe('мутации', () => {
  it('PUT отправляет {limits: patch} и синхронизирует кэш', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        limits: { maxCount: 60, maxChars: 1500 },
        saved: { maxCount: 60 },
        defaults: DEFAULT_STICKY_NOTES_LIMITS,
        source: 'runtime',
      }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = await putStickyNotesLimits({ maxCount: 60 })
    expect(settings.limits.maxCount).toBe(60)
    expect(getStickyNotesLimits()).toEqual({ maxCount: 60, maxChars: 1500 })
    expect(getStickyNotesLimitsState().source).toBe('runtime')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ limits: { maxCount: 60 } })
  })

  it('DELETE сбрасывает кэш к эффективному значению', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        limits: DEFAULT_STICKY_NOTES_LIMITS,
        saved: null,
        defaults: DEFAULT_STICKY_NOTES_LIMITS,
        source: 'default',
      }))
    vi.stubGlobal('fetch', fetchMock)
    resetStickyNotesLimitsCache({ maxCount: 9, maxChars: 99 })

    const settings = await deleteStickyNotesLimits()
    expect(settings.saved).toBeNull()
    expect(getStickyNotesLimits()).toEqual(DEFAULT_STICKY_NOTES_LIMITS)
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
  })

  it('ошибка PUT пробрасывается с HTTP-статусом и не портит кэш', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'bad' } }, 400)),
    )
    resetStickyNotesLimitsCache({ maxCount: 11, maxChars: 111 })

    await expect(putStickyNotesLimits({ maxChars: 0 })).rejects.toMatchObject({ status: 400 })
    expect(getStickyNotesLimits()).toEqual({ maxCount: 11, maxChars: 111 })
  })
})

describe('stickyNoteErrorKey', () => {
  it('код LIMIT_EXCEEDED → лимит количества, VALIDATION_ERROR → длина', () => {
    expect(stickyNoteErrorKey({ code: 'LIMIT_EXCEEDED' })).toBe('chat.notes.limitReached')
    expect(stickyNoteErrorKey({ code: 'VALIDATION_ERROR' })).toBe('chat.notes.invalid')
  })

  it('фоллбек по HTTP-статусу: 409 → лимит, 400 → длина', () => {
    expect(stickyNoteErrorKey({ status: 409 })).toBe('chat.notes.limitReached')
    expect(stickyNoteErrorKey({ status: 400 })).toBe('chat.notes.invalid')
  })

  it('прочие ошибки — null (общий текст)', () => {
    expect(stickyNoteErrorKey(new Error('boom'))).toBeNull()
    expect(stickyNoteErrorKey({ status: 500 })).toBeNull()
  })
})
