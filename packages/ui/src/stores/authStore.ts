import { create } from 'zustand'
import { api, type User, type Profile } from '@/lib/api/client'
import { profileService } from '@/lib/api/profileService'

interface AuthState {
  user: User | null
  profile: Profile | null
  isAuthenticated: boolean
  isLoading: boolean
  isInitialized: boolean
  error: string | null

  initialize: () => Promise<void>
  login: (apiKey: string, username?: string) => Promise<void>
  loginWithPassword: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  error: null,

  initialize: async () => {
    if (get().isLoading || get().isInitialized) return
    set({ isLoading: true, error: null })
    try {
      const session = await api.getSession()
      set({
        user: session.user,
        isAuthenticated: true,
        isLoading: false,
      })
      await profileService.initialize()
      set({ isInitialized: true })
    } catch {
      const status = await api.getStatus()
      set({
        user: status.authenticated ? status.user : null,
        isAuthenticated: status.authenticated,
        isLoading: false,
        isInitialized: true,
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

  loginWithPassword: async (username: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      const response = await api.loginWithPassword(username, password)
      set({
        user: response.user,
        isAuthenticated: true,
        isLoading: false,
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

  logout: async () => {
    set({ isLoading: true })
    try {
      await api.logout()
    } finally {
      localStorage.removeItem('synth-ui.i18n.v1')
      localStorage.removeItem('synth-ui-settings')
      localStorage.removeItem('theme')
      localStorage.removeItem('themeMode')
      localStorage.removeItem('useSystemTheme')
      localStorage.removeItem('selectedThemeId')
      localStorage.removeItem('selectedThemeVariant')
      set({ user: null, profile: null, isAuthenticated: false, isLoading: false })
    }
  },

  clearError: () => set({ error: null }),
}))