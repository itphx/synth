import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from './client'

/**
 * `lib/api/client.ts` — отдельный HTTP-клиент аутентификации (`/auth`, ADR-043).
 * У него свой `fetchJSON` с иным приоритетом полей ошибки (`error.message` → `detail`),
 * поэтому пути/методы/тела проверяются собственным тестом.
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

describe('client.api — /auth (ADR-043)', () => {
  it('getStatus: GET /auth/status', async () => {
    const status = { oidc_enabled: false, debug_mode: true, authenticated: false, user: null }
    fetchMock.mockResolvedValue(jsonResponse(status))

    await expect(api.getStatus()).resolves.toEqual(status)
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/status',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('getUsers: GET /auth/users', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'u1', username: 'admin' }] }))

    await expect(api.getUsers()).resolves.toEqual({ users: [{ id: 'u1', username: 'admin' }] })
    expect(fetchMock).toHaveBeenCalledWith('/auth/users', expect.objectContaining({}))
  })

  it('spaLogin: POST /auth/spa-login с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'u1' }, token: 't' }))

    await api.spaLogin({ api_key: 'k', username: 'admin' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/spa-login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ api_key: 'k', username: 'admin' }),
      }),
    )
  })

  it('loginWithPassword: пустой server отбрасывается из тела', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deployment: 'standalone' }))

    await api.loginWithPassword(undefined, 'u', 'p')

    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ server: undefined, username: 'u', password: 'p' }),
      }),
    )
    // JSON.stringify отбрасывает undefined — в тело уходит только логин/пароль.
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toEqual({ username: 'u', password: 'p' })
  })

  it('loginWithPassword: переданный server попадает в тело', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await api.loginWithPassword('https://srv', 'u', 'p')

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toEqual({ server: 'https://srv', username: 'u', password: 'p' })
  })

  it('getProfile: GET /auth/profile', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1', username: 'admin', roles: ['ADMIN'] }))

    const profile = await api.getProfile()

    expect(fetchMock).toHaveBeenCalledWith('/auth/profile', expect.objectContaining({}))
    expect(profile.id).toBe('u1')
  })

  it('updateProfile: PUT /auth/profile и разворачивает {profile}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', profile: { id: 'u1', display_name: 'X' } }))

    const profile = await api.updateProfile({ display_name: 'X' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/profile',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ display_name: 'X' }) }),
    )
    expect(profile).toEqual({ id: 'u1', display_name: 'X' })
  })

  it('updatePreferences: PATCH /auth/profile/preferences, возвращает обёртку целиком', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', preferences: { locale: 'ru' } }))

    const result = await api.updatePreferences({ locale: 'ru' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/profile/preferences',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(result).toEqual({ status: 'ok', preferences: { locale: 'ru' } })
  })

  it('deletePreferences: DELETE /auth/profile/preferences', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', preferences: {} }))

    await api.deletePreferences()

    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/profile/preferences',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('updateDefaults: PUT /auth/defaults, возвращает обёртку', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', defaults: { locale: 'ru' } }))

    await expect(api.updateDefaults({ locale: 'ru' })).resolves.toEqual({
      status: 'ok',
      defaults: { locale: 'ru' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/defaults',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('getDefaults / getLocales: GET-пути', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ locale: 'ru' }))
    await api.getDefaults()
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/defaults', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ locales: [], default: 'ru' }))
    await api.getLocales()
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/locales', expect.objectContaining({}))
  })

  it('logout: прямой POST /auth/logout с credentials', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)

    await api.logout()

    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
  })

  it('getMe / getSession: GET-пути', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1' }))
    await api.getMe()
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/me', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'u1' }, token: 't' }))
    await api.getSession()
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/session', expect.objectContaining({}))
  })
})

describe('client.api — разбор ошибок (приоритет error.message → detail)', () => {
  it('body.error.message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Неверный ключ' } }, 401))

    await expect(api.getStatus()).rejects.toThrow('Неверный ключ')
  })

  it('body.detail, если нет error.message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'нет доступа' }, 403))

    await expect(api.getStatus()).rejects.toThrow('нет доступа')
  })

  it('фоллбек HTTP <status>', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503))

    await expect(api.getStatus()).rejects.toThrow('HTTP 503')
  })
})
