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

const reloadMock = vi.fn()

const INITIAL_STATE = {
  user: null,
  profile: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  error: null,
  notice: null,
  deployment: null,
}

describe('authStore: switch-profile (переход в профиль сервера)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    reloadMock.mockClear()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { reload: reloadMock },
    })
    useAuthStore.setState(INITIAL_STATE)
  })

  afterEach(async () => {
    // logout сбрасывает состояние и очищает отложенный reload-таймер.
    await useAuthStore.getState().logout().catch(() => {})
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('switch-profile: не ставит user/isAuthenticated, показывает notice и планирует reload', async () => {
    vi.mocked(api.loginWithPassword).mockResolvedValue({
      action: 'switch-profile',
      server: 'https://new.example.loc',
      message: 'Профиль сервера сохранён — процесс перезапускается в новом профиле',
    })

    await useAuthStore.getState().loginWithPassword('https://new.example.loc', 'dev', 'pass')

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(false)
    expect(s.user).toBeNull()
    expect(s.isLoading).toBe(false)
    expect(s.isInitialized).toBe(true)
    expect(s.error).toBeNull()
    expect(s.notice).toBe('Профиль сервера сохранён — процесс перезапускается в новом профиле')
    // Личность/профиль не инициализируются — процесс перезапускается.
    expect(profileService.initialize).not.toHaveBeenCalled()
    // Перезагрузка отложена, а не мгновенная.
    expect(reloadMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_500)
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('switch-profile: notice-fallback, если сервер не прислал message', async () => {
    vi.mocked(api.loginWithPassword).mockResolvedValue({
      action: 'switch-profile',
      server: 'https://new.example.loc',
    })

    await useAuthStore.getState().loginWithPassword('https://new.example.loc', 'dev', 'pass')
    expect(useAuthStore.getState().notice).toBe('Переключаюсь на сервер…')
  })

  it('повторный switch-profile не плодит таймеры reload (один reload)', async () => {
    vi.mocked(api.loginWithPassword).mockResolvedValue({
      action: 'switch-profile',
      server: 'https://new.example.loc',
      message: 'Переключаюсь',
    })

    await useAuthStore.getState().loginWithPassword('https://new.example.loc', 'dev', 'pass')
    await useAuthStore.getState().loginWithPassword('https://new.example.loc', 'dev', 'pass')

    await vi.advanceTimersByTimeAsync(2_500)
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('обычный парольный вход работает как раньше: user/isAuthenticated, notice пуст', async () => {
    vi.mocked(api.loginWithPassword).mockResolvedValue({
      deployment: 'standalone',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    await useAuthStore.getState().loginWithPassword('https://backend.example', 'dev', 'pass')

    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.user?.username).toBe('dev')
    expect(s.deployment).toBe('standalone')
    expect(s.notice).toBeNull()
    expect(profileService.initialize).toHaveBeenCalledTimes(1)
    expect(reloadMock).not.toHaveBeenCalled()
  })

  it('ошибка входа (409 PROFILE_SWITCH_REQUIRED) → error (не notice), без reload', async () => {
    vi.mocked(api.loginWithPassword).mockRejectedValue(
      new Error('Перезапустите с адресом сервера: synth serve --connect https://x.example.loc'),
    )

    await useAuthStore.getState().loginWithPassword('https://x.example.loc', 'dev', 'pass')

    const s = useAuthStore.getState()
    expect(s.error).toContain('Перезапустите с адресом сервера')
    expect(s.notice).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(reloadMock).not.toHaveBeenCalled()
  })
})
