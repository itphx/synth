import { create } from 'zustand'
import { api, type User, type Profile, type DeploymentKind } from '@/lib/api/client'
import { profileService } from '@/lib/api/profileService'

interface AuthState {
  user: User | null
  profile: Profile | null
  isAuthenticated: boolean
  isLoading: boolean
  isInitialized: boolean
  error: string | null
  /** Тип развёртывания сервера ('standalone'|'managed') — runtime-детекция. */
  deployment: DeploymentKind | null

  initialize: () => Promise<void>
  reauthenticate: () => Promise<void>
  login: (apiKey: string, username?: string) => Promise<void>
  loginWithPassword: (server: string, username: string, password: string) => Promise<void>
  setUser: (user: User) => Promise<void>
  /** Локальное обновление профиля (после PATCH /profile) без повторной загрузки. */
  setProfile: (profile: Profile | null) => void
  logout: () => Promise<void>
  sessionExpired: () => void
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  error: null,
  deployment: null,

  initialize: async () => {
    if (get().isLoading || get().isInitialized) return
    await get().reauthenticate()
  },

  /**
   * Принудительно перечитать сессию (без guard) — когда cookie уже поставлена
   * (например после server-логина), а состояние UI нужно обновить.
   *
   * Использует только GET /auth/status (200 всегда, в т.ч. для гостя), чтобы не
   * провоцировать ожидаемый, но шумный 401 от GET /auth/session в консоли.
   */
  reauthenticate: async () => {
    set({ isLoading: true, error: null })
    try {
      const status = await api.getStatus()
      set({
        user: status.authenticated ? status.user : null,
        isAuthenticated: status.authenticated,
        isLoading: false,
        deployment: status.deployment ?? null,
      })
      if (status.authenticated) {
        await profileService.initialize()
      }
      set({ isInitialized: true })
    } catch {
      // Сеть/сервер недоступны — безопасно завершаем инициализацию гостем.
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        isInitialized: true,
        deployment: null,
      })
    }
  },

  login: async (apiKey: string, username?: string) => {
    set({ isLoading: true, error: null })
    try {
      const response = await api.spaLogin({ api_key: apiKey, username })
      set({
        user: response.user,
        isAuthenticated: true,
        isLoading: false,
        deployment: response.deployment ?? null,
      })
      await profileService.initialize()
      set({ isInitialized: true })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Login failed',
        isLoading: false,
        isInitialized: true,
      })
    }
  },

  loginWithPassword: async (server: string, username: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      const response = await api.loginWithPassword(server, username, password)
      // Обычный runtime-вход: личность приходит с сервера сразу (без перезапуска
      // процесса/страницы), cookie ставит core.
      set({
        user: response.user ?? null,
        isAuthenticated: true,
        isLoading: false,
        deployment: response.deployment ?? null,
      })
      await profileService.initialize()
      set({ isInitialized: true })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Login failed',
        isLoading: false,
        isInitialized: true,
      })
    }
  },

  /**
   * Установить пользователя после server-логина: cookie уже поставлена core,
   * здесь — только состояние UI (+ профиль).
   */
  setUser: async (user: User) => {
    set({ user, isAuthenticated: true, isLoading: false, error: null })
    await profileService.initialize()
    set({ isInitialized: true })
  },

  setProfile: (profile) => set({ profile }),

  logout: async () => {
    set({ isLoading: true })
    try {
      // Серверная часть: logoutRemote (revoke refresh-токена + удаление credentials
      // активного сервера + runtime disconnect) + очистка cookie. Профиль сервера
      // из реестра не удаляется — сервер остаётся в knownServers/lastServer.
      await api.logout()
    } finally {
      localStorage.removeItem('synth-ui.i18n.v1')
      localStorage.removeItem('synth-ui-settings')
      localStorage.removeItem('theme')
      localStorage.removeItem('themeMode')
      localStorage.removeItem('useSystemTheme')
      localStorage.removeItem('selectedThemeId')
      localStorage.removeItem('selectedThemeVariant')
      set({ user: null, profile: null, isAuthenticated: false, isLoading: false, deployment: null })
    }
  },

  sessionExpired: () =>
    set({ user: null, profile: null, isAuthenticated: false, isLoading: false, deployment: null }),

  clearError: () => set({ error: null }),
}))