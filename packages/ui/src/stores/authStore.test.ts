import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/api/client', () => ({
  api: {
    loginWithPassword: vi.fn(),
    spaLogin: vi.fn(),
    logout: vi.fn(),
    getSession: vi.fn(),
    getStatus: vi.fn(),
  },
}))

vi.mock('@/lib/api/profileService', () => ({
  profileService: {
    initialize: vi.fn(),
    getEffectivePreferences: vi.fn(),
  },
}))

import { api } from '@/lib/api/client'
import { profileService } from '@/lib/api/profileService'
import { useAuthStore, __resetAuthRetryForTests } from './authStore'

const INITIAL_STATE = {
  user: null,
  profile: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  error: null,
  authPhase: 'checking' as const,
  deployment: null,
  oidcEnabled: false,
  debugMode: false,
}

describe('authStore: loginWithPassword (лёгкий runtime-вход)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAuthRetryForTests()
    // Node/витeст без --localstorage-file не даёт localStorage — заглушка.
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    useAuthStore.setState(INITIAL_STATE)
  })

  afterEach(async () => {
    await useAuthStore.getState().logout().catch(() => {})
    vi.unstubAllGlobals()
  })

  it('успех → user/isAuthenticated/deployment, профиль инициализирован', async () => {
    vi.mocked(api.loginWithPassword).mockResolvedValue({
      deployment: 'standalone',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    await useAuthStore.getState().loginWithPassword('https://backend.example', 'dev', 'pass')

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.user?.username).toBe('dev')
    expect(s.deployment).toBe('standalone')
    expect(s.error).toBeNull()
    expect(profileService.initialize).toHaveBeenCalledTimes(1)
  })

  it('успех на новом сервере — обычный runtime-вход (без reload/notice)', async () => {
    vi.mocked(api.loginWithPassword).mockResolvedValue({
      deployment: 'standalone',
      user: { id: 'u2', username: 'remote-dev', email: null, roles: ['USER'] },
    })

    await useAuthStore.getState().loginWithPassword('https://new.example.loc', 'dev', 'pass')

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.user?.username).toBe('remote-dev')
    expect(s.error).toBeNull()
  })

  it('ошибка входа → error (не authenticated), профиль не инициализирован', async () => {
    vi.mocked(api.loginWithPassword).mockRejectedValue(
      new Error('Неверный логин или пароль'),
    )

    await useAuthStore.getState().loginWithPassword('https://backend.example', 'dev', 'wrong')

    const s = useAuthStore.getState()
    expect(s.error).toContain('Неверный логин или пароль')
    expect(s.isAuthenticated).toBe(false)
    expect(s.user).toBeNull()
    expect(profileService.initialize).not.toHaveBeenCalled()
  })
})

describe('authStore: reauthenticate (только /auth/status, без 401-шума)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAuthRetryForTests()
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    useAuthStore.setState(INITIAL_STATE)
  })

  afterEach(() => {
    __resetAuthRetryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('authenticated=true → user/isAuthenticated/deployment/oidcEnabled/debugMode + профиль, getSession не вызывается', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: true,
      debug_mode: true,
      oidc_enabled: true,
      deployment: 'managed',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    await useAuthStore.getState().reauthenticate()

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.authPhase).toBe('authenticated')
    expect(s.user?.username).toBe('dev')
    expect(s.deployment).toBe('managed')
    expect(s.oidcEnabled).toBe(true)
    expect(s.debugMode).toBe(true)
    expect(s.isInitialized).toBe(true)
    expect(profileService.initialize).toHaveBeenCalledTimes(1)
    expect(api.getSession).not.toHaveBeenCalled()
  })

  it('authenticated=false → гость, профиль не инициализируется, getSession не вызывается', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: false,
      debug_mode: false,
      oidc_enabled: false,
      deployment: 'managed',
      user: null,
    })

    await useAuthStore.getState().reauthenticate()

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(false)
    expect(s.authPhase).toBe('guest')
    expect(s.user).toBeNull()
    expect(s.isInitialized).toBe(true)
    expect(s.isLoading).toBe(false)
    expect(profileService.initialize).not.toHaveBeenCalled()
    expect(api.getSession).not.toHaveBeenCalled()
  })

  it('сеть/таймаут GET /auth/status → authPhase=unreachable, а не гость', async () => {
    // Возможности сервера уже известны (например, с прошлого успешного старта):
    // сетевая ошибка не должна их сбрасывать и не должна выкидывать на форму входа.
    useAuthStore.setState({ deployment: 'managed', oidcEnabled: true, debugMode: false })
    vi.mocked(api.getStatus).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(useAuthStore.getState().reauthenticate()).resolves.toBeUndefined()

    const s = useAuthStore.getState()
    expect(s.authPhase).toBe('unreachable')
    expect(s.isAuthenticated).toBe(false)
    expect(s.user).toBeNull()
    expect(s.isInitialized).toBe(true)
    expect(s.isLoading).toBe(false)
    // managed/OIDC не потеряны — при восстановлении форма входа будет прежней.
    expect(s.deployment).toBe('managed')
    expect(s.oidcEnabled).toBe(true)
    expect(s.debugMode).toBe(false)
    expect(profileService.initialize).not.toHaveBeenCalled()
  })

  it('retry после unreachable: успешный ответ → authenticated и снятие backoff', async () => {
    vi.mocked(api.getStatus).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await useAuthStore.getState().reauthenticate()
    expect(useAuthStore.getState().authPhase).toBe('unreachable')

    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: true,
      debug_mode: false,
      oidc_enabled: true,
      deployment: 'managed',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    await useAuthStore.getState().retry()

    expect(useAuthStore.getState().authPhase).toBe('authenticated')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })

  it('retry не создаёт параллельных запросов при isLoading', async () => {
    useAuthStore.setState({ authPhase: 'unreachable', isLoading: true })
    await useAuthStore.getState().retry()
    expect(api.getStatus).not.toHaveBeenCalled()
  })

  it('событийные повторы не чаще 2.5 с: два visibilitychange → один запрос', async () => {
    vi.mocked(api.getStatus).mockRejectedValue(new TypeError('Failed to fetch'))
    await useAuthStore.getState().reauthenticate()
    expect(api.getStatus).toHaveBeenCalledTimes(1)

    // Два события подряд (флапающая сеть/частые переключения вкладки).
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(api.getStatus).toHaveBeenCalledTimes(2)
  })

  it('повторные 5xx растят backoff (2.5 → 5 → 10), без шторма каждые 2.5 с', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getStatus).mockRejectedValue(new Error('HTTP 500'))

    await useAuthStore.getState().reauthenticate()
    expect(api.getStatus).toHaveBeenCalledTimes(1)

    // Первая задержка 2.5 с.
    await vi.advanceTimersByTimeAsync(2_499)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getStatus).toHaveBeenCalledTimes(2)

    // Вторая — уже 5 с (индекс не сброшен из-за HTTP-ошибки).
    await vi.advanceTimersByTimeAsync(4_999)
    expect(api.getStatus).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getStatus).toHaveBeenCalledTimes(3)

    // Третья — 10 с.
    await vi.advanceTimersByTimeAsync(9_999)
    expect(api.getStatus).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getStatus).toHaveBeenCalledTimes(4)
  })
})

describe('authStore: logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    useAuthStore.setState({
      ...INITIAL_STATE,
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
      isAuthenticated: true,
      isInitialized: true,
      deployment: 'managed',
      oidcEnabled: true,
      debugMode: true,
    })
  })

  afterEach(async () => {
    await useAuthStore.getState().logout().catch(() => {})
    vi.unstubAllGlobals()
  })

  it('вызывает api.logout и сбрасывает личность, сохраняя возможности сервера', async () => {
    await useAuthStore.getState().logout()

    const s = useAuthStore.getState()
    expect(api.logout).toHaveBeenCalledTimes(1)
    expect(s.user).toBeNull()
    expect(s.profile).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.isLoading).toBe(false)
    // deployment/oidcEnabled/debugMode описывают сервер, а не сессию: после выхода
    // LoginForm должен сразу показать правильную ветку полей (без повторного /auth/status).
    expect(s.deployment).toBe('managed')
    expect(s.oidcEnabled).toBe(true)
    expect(s.debugMode).toBe(true)
  })

  it('не удаляет ключи темы — экран входа сохраняет последнюю тему', async () => {
    await useAuthStore.getState().logout()

    const removedKeys = vi.mocked(localStorage.removeItem).mock.calls.map(([key]) => key)
    expect(removedKeys).not.toContain('theme')
    expect(removedKeys).not.toContain('themeMode')
    expect(removedKeys).not.toContain('useSystemTheme')
    expect(removedKeys).not.toContain('selectedThemeId')
    expect(removedKeys).not.toContain('selectedThemeVariant')
    // Остальные очистки сохранены.
    expect(removedKeys).toContain('synth-ui.i18n.v1')
    expect(removedKeys).toContain('synth-ui-settings')
  })

  it('api.logout упал → состояние всё равно сбрасывается', async () => {
    vi.mocked(api.logout).mockRejectedValue(new Error('network'))

    await useAuthStore.getState().logout().catch(() => {})

    const s = useAuthStore.getState()
    expect(s.user).toBeNull()
    expect(s.isAuthenticated).toBe(false)
  })
})

describe('authStore: sessionExpired', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    useAuthStore.setState({
      ...INITIAL_STATE,
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
      profile: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
      isAuthenticated: true,
      isInitialized: true,
      deployment: 'managed',
      oidcEnabled: true,
      debugMode: true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('сбрасывает авторизацию, сохраняя возможности сервера, без сети и без очистки localStorage', () => {
    useAuthStore.getState().sessionExpired()

    const s = useAuthStore.getState()
    expect(s.user).toBeNull()
    expect(s.profile).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.isLoading).toBe(false)
    // Возможности сервера сохраняются — LoginForm после истечения сессии сразу
    // рендерит корректную ветку (см. logout).
    expect(s.deployment).toBe('managed')
    expect(s.oidcEnabled).toBe(true)
    expect(s.debugMode).toBe(true)
    expect(api.logout).not.toHaveBeenCalled()
    expect(api.getStatus).not.toHaveBeenCalled()
    expect(localStorage.removeItem).not.toHaveBeenCalled()
  })
})
