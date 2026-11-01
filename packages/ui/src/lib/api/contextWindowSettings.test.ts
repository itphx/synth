import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import {
  DEFAULT_CONTEXT_WINDOW_POLICY,
  deleteContextWindowPolicy,
  getContextWindowPolicy,
  getContextWindowSettings,
  loadContextWindowPolicy,
  putContextWindowPolicy,
  resetContextWindowPolicyCache,
} from './contextWindowSettings'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  resetContextWindowPolicyCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetContextWindowPolicyCache()
})

describe('getContextWindowSettings', () => {
  it('читает policy из ответа и ходит в /settings/context-window', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ policy: 'off' }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = await getContextWindowSettings()
    expect(settings?.policy).toBe('off')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v2/settings/context-window')
  })

  it('понимает вложенную форму {settings:{policy}}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ settings: { policy: 'enforce' } })))
    const settings = await getContextWindowSettings()
    expect(settings?.policy).toBe('enforce')
  })

  it('неизвестное значение → дефолт warn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ policy: 'strict' })))
    const settings = await getContextWindowSettings()
    expect(settings?.policy).toBe(DEFAULT_CONTEXT_WINDOW_POLICY)
  })

  it('404 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'not found' }, 404)))
    await expect(getContextWindowSettings()).resolves.toBeNull()
  })

  it('сетевая ошибка → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))
    await expect(getContextWindowSettings()).resolves.toBeNull()
  })
})

describe('useContextWindowPolicy — кэш и деградация', () => {
  it('дефолт warn, пока политика не загружена', () => {
    expect(getContextWindowPolicy()).toBe('warn')
  })

  it('ошибка API → warn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'boom' }, 500)))
    await expect(loadContextWindowPolicy()).resolves.toBe('warn')
    expect(getContextWindowPolicy()).toBe('warn')
  })

  it('кэш на модуль: второй вызов не ходит в сеть', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ policy: 'off' }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await loadContextWindowPolicy()).toBe('off')
    expect(await loadContextWindowPolicy()).toBe('off')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getContextWindowPolicy()).toBe('off')
  })

  it('parallel-вызовы делят один запрос', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ policy: 'enforce' }))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([loadContextWindowPolicy(), loadContextWindowPolicy()])
    expect(a).toBe('enforce')
    expect(b).toBe('enforce')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('мутации политики', () => {
  it('PUT отправляет {policy} и обновляет кэш хука', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ policy: 'enforce', defaults: 'warn', source: 'runtime' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const settings = await putContextWindowPolicy('enforce')
    expect(settings.policy).toBe('enforce')
    expect(settings.source).toBe('runtime')
    expect(getContextWindowPolicy()).toBe('enforce')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ policy: 'enforce' })
  })

  it('DELETE сбрасывает кэш к эффективному значению', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ policy: 'warn', saved: null, defaults: 'warn', source: 'default' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    resetContextWindowPolicyCache('enforce')

    const settings = await deleteContextWindowPolicy()
    expect(settings.saved).toBeNull()
    expect(getContextWindowPolicy()).toBe('warn')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
  })

  it('ошибка PUT пробрасывается с HTTP-статусом (409 — env)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'CONFLICT', message: 'env' } }, 409)),
    )
    await expect(putContextWindowPolicy('off')).rejects.toMatchObject({ status: 409 })
    expect(getContextWindowPolicy()).toBe('warn')
  })
})
