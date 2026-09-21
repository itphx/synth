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
import { useAuthStore } from './authStore'

const INITIAL_STATE = {
  user: null,
  profile: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  error: null,
  deployment: null,
}

describe('authStore: loginWithPassword (лёгкий runtime-вход)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    useAuthStore.setState(INITIAL_STATE)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticated=true → user/isAuthenticated/deployment + профиль, getSession не вызывается', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: true,
      debug_mode: false,
      oidc_enabled: false,
      deployment: 'managed',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    await useAuthStore.getState().reauthenticate()

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.user?.username).toBe('dev')
    expect(s.deployment).toBe('managed')
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
    expect(s.user).toBeNull()
    expect(s.isInitialized).toBe(true)
    expect(s.isLoading).toBe(false)
    expect(profileService.initialize).not.toHaveBeenCalled()
    expect(api.getSession).not.toHaveBeenCalled()
  })

  it('getStatus reject → не бросает, инициализация завершается гостем', async () => {
    vi.mocked(api.getStatus).mockRejectedValue(new Error('network'))

    await expect(useAuthStore.getState().reauthenticate()).resolves.toBeUndefined()

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(false)
    expect(s.user).toBeNull()
    expect(s.isInitialized).toBe(true)
    expect(s.isLoading).toBe(false)
    expect(s.deployment).toBeNull()
    expect(profileService.initialize).not.toHaveBeenCalled()
  })
})

describe('authStore: logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    useAuthStore.setState({ ...INITIAL_STATE, user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] }, isAuthenticated: true, isInitialized: true })
  })

  afterEach(async () => {
    await useAuthStore.getState().logout().catch(() => {})
    vi.unstubAllGlobals()
  })

  it('вызывает api.logout и сбрасывает состояние (личность очищена)', async () => {
    await useAuthStore.getState().logout()

    const s = useAuthStore.getState()
    expect(api.logout).toHaveBeenCalledTimes(1)
    expect(s.user).toBeNull()
    expect(s.profile).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.isLoading).toBe(false)
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
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('сбрасывает авторизацию без сетевых вызовов и без очистки localStorage', () => {
    useAuthStore.getState().sessionExpired()

    const s = useAuthStore.getState()
    expect(s.user).toBeNull()
    expect(s.profile).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.isLoading).toBe(false)
    expect(s.deployment).toBeNull()
    expect(api.logout).not.toHaveBeenCalled()
    expect(api.getStatus).not.toHaveBeenCalled()
    expect(localStorage.removeItem).not.toHaveBeenCalled()
  })
})
