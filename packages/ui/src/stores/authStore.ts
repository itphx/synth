import { create } from 'zustand'
import { api, type User, type Profile, type DeploymentKind } from '@/lib/api/client'
import { profileService } from '@/lib/api/profileService'

/**
 * Фаза гейта входа. `unreachable` — сервер/сеть недоступны: это **не гость**,
 * форму входа показывать нельзя (на managed/OIDC она выбрала бы ветку «API
 * ключ»). `isAuthenticated`/`isInitialized` сохранены для совместимости.
 */
export type AuthPhase = 'checking' | 'authenticated' | 'guest' | 'unreachable'

interface RememberedServerCaps {
  deployment: DeploymentKind | null
  oidcEnabled: boolean
  debugMode: boolean
}

const SERVER_CAPS_STORAGE_KEY = 'synth-ui.server-caps.v1'
/** Клиентские backoff-задержки автоповтора при недоступном сервере (мс). */
const RETRY_DELAYS = [2_500, 5_000, 10_000, 20_000, 30_000] as const
/** Минимальный интервал между событийными попытками (`online`/`visibilitychange`). */
const EVENT_RETRY_MIN_INTERVAL_MS = 2_500

let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryIndex = 0
let retryListenersAttached = false
/** Время последней событийной попытки — анти-шторм при флапающей сети. */
let lastEventRetryAt = 0

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function resetRetry(): void {
  clearRetryTimer()
  retryIndex = 0
  lastEventRetryAt = 0
}

/** Запомненные возможности сервера: холодный старт не должен терять managed/OIDC. */
function readRememberedCaps(): RememberedServerCaps | null {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return null
    const raw = localStorage.getItem(SERVER_CAPS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedServerCaps> | null
    if (!parsed || typeof parsed !== 'object') return null
    return {
      deployment: parsed.deployment === 'standalone' || parsed.deployment === 'managed' ? parsed.deployment : null,
      oidcEnabled: parsed.oidcEnabled === true,
      debugMode: parsed.debugMode === true,
    }
  } catch {
    return null
  }
}

function writeRememberedCaps(caps: RememberedServerCaps): void {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') return
    localStorage.setItem(SERVER_CAPS_STORAGE_KEY, JSON.stringify(caps))
  } catch {
    // приватный режим/квота — работаем без запоминания
  }
}

/** Следующая попытка `retry()` с нарастающей задержкой (2.5/5/10/20/30 с). */
function scheduleAuthRetry(): void {
  if (retryTimer) return
  attachRetryListeners()
  const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)]!
  retryIndex++
  retryTimer = setTimeout(() => {
    retryTimer = null
    void useAuthStore.getState().retry()
  }, delay)
}

/**
 * Разбудить гейт при возврате сети/вкладки: ждать backoff не нужно, но частые
 * переключения сети не должны превращаться в поток запросов — не чаще, чем раз
 * в `EVENT_RETRY_MIN_INTERVAL_MS`. Плановый `retry()` по таймеру это не трогает.
 */
function tryRetryNow(): void {
  if (useAuthStore.getState().authPhase !== 'unreachable') return
  const now = Date.now()
  if (now - lastEventRetryAt < EVENT_RETRY_MIN_INTERVAL_MS) return
  lastEventRetryAt = now
  clearRetryTimer()
  void useAuthStore.getState().retry()
}

function onAuthOnline(): void {
  tryRetryNow()
}

function onAuthVisibilityChange(): void {
  if (document.visibilityState === 'visible') tryRetryNow()
}

function attachRetryListeners(): void {
  if (retryListenersAttached || typeof window === 'undefined') return
  retryListenersAttached = true
  window.addEventListener('online', onAuthOnline)
  document.addEventListener('visibilitychange', onAuthVisibilityChange)
}

function detachRetryListeners(): void {
  if (!retryListenersAttached || typeof window === 'undefined') return
  window.removeEventListener('online', onAuthOnline)
  document.removeEventListener('visibilitychange', onAuthVisibilityChange)
  retryListenersAttached = false
}

// HMR: при перезагрузке модуля снимаем слушатели и таймер, иначе они дублируются.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetRetry()
    detachRetryListeners()
  })
}

interface AuthState {
  user: User | null
  profile: Profile | null
  isAuthenticated: boolean
  isLoading: boolean
  isInitialized: boolean
  error: string | null
  /** Машинный код последней ошибки входа (`OFFLINE`, `UNAUTHORIZED`, …). */
  errorCode: string | null
  /** Фаза гейта входа (источник истины для `AuthGate`). */
  authPhase: AuthPhase
  /** Тип развёртывания сервера ('standalone'|'managed') — runtime-детекция. */
  deployment: DeploymentKind | null
  /** OIDC-вход включён на сервере (GET /auth/status.oidc_enabled). Нужен логин-форме
   *  для выбора ветки полей (username+password vs apiKey) без «мигающей» промежуточной формы. */
  oidcEnabled: boolean
  /** Debug-режим сервера (GET /auth/status.debug_mode) — список тестовых пользователей. */
  debugMode: boolean

  initialize: () => Promise<void>
  reauthenticate: () => Promise<void>
  /** Повтор проверки входа после `unreachable` (кнопка баннера/экрана). */
  retry: () => Promise<void>
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
  errorCode: null,
  authPhase: 'checking',
  deployment: null,
  oidcEnabled: false,
  debugMode: false,

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
      // `deployment` приходит не во всех режимах — не теряем ранее известное.
      const deployment = status.deployment ?? get().deployment ?? readRememberedCaps()?.deployment ?? null
      const caps: RememberedServerCaps = {
        deployment,
        oidcEnabled: status.oidc_enabled,
        debugMode: status.debug_mode,
      }
      writeRememberedCaps(caps)
      set({
        user: status.authenticated ? status.user : null,
        isAuthenticated: status.authenticated,
        isLoading: false,
        authPhase: status.authenticated ? 'authenticated' : 'guest',
        deployment,
        oidcEnabled: status.oidc_enabled,
        debugMode: status.debug_mode,
      })
      if (status.authenticated) {
        await profileService.initialize()
      }
      set({ isInitialized: true })
      resetRetry()
    } catch {
      // Сеть/таймаут — это НЕ «гость»: показываем экран «Сервер недоступен»,
      // сохраняя известные возможности сервера (managed/OIDC) и личность, если
      // она уже была. Сетевой сбой не должен разлогинивать.
      const remembered = readRememberedCaps()
      const current = get()
      // Индекс backoff сбрасывается только при успехе (`resetRetry` в try-ветке):
      // иначе серия 5xx от `/auth/status` повторялась бы каждые 2.5 с штормом.
      set({
        user: current.user,
        isAuthenticated: current.isAuthenticated,
        isLoading: false,
        isInitialized: true,
        authPhase: 'unreachable',
        deployment: current.deployment ?? remembered?.deployment ?? null,
        oidcEnabled: current.oidcEnabled || remembered?.oidcEnabled === true,
        debugMode: current.debugMode || remembered?.debugMode === true,
      })
      scheduleAuthRetry()
    }
  },

  retry: async () => {
    if (get().isLoading) return
    if (get().authPhase !== 'unreachable') {
      resetRetry()
      return
    }
    // Снимаем запланированный таймер: попытка одна, параллельных запросов нет.
    clearRetryTimer()
    await get().reauthenticate()
  },

  login: async (apiKey: string, username?: string) => {
    set({ isLoading: true, error: null, errorCode: null })
    try {
      const response = await api.spaLogin({ api_key: apiKey, username })
      set({
        user: response.user,
        isAuthenticated: true,
        isLoading: false,
        authPhase: 'authenticated',
        deployment: response.deployment ?? get().deployment ?? null,
      })
      await profileService.initialize()
      set({ isInitialized: true })
      resetRetry()
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Login failed',
        errorCode: (err as { code?: string }).code ?? null,
        isLoading: false,
        isInitialized: true,
        authPhase: 'guest',
      })
    }
  },

  loginWithPassword: async (server: string, username: string, password: string) => {
    set({ isLoading: true, error: null, errorCode: null })
    try {
      const response = await api.loginWithPassword(server, username, password)
      // Обычный runtime-вход: личность приходит с сервера сразу (без перезапуска
      // процесса/страницы), cookie ставит core.
      set({
        user: response.user ?? null,
        isAuthenticated: true,
        isLoading: false,
        authPhase: 'authenticated',
        deployment: response.deployment ?? get().deployment ?? null,
      })
      await profileService.initialize()
      set({ isInitialized: true })
      resetRetry()
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Login failed',
        errorCode: (err as { code?: string }).code ?? null,
        isLoading: false,
        isInitialized: true,
        authPhase: 'guest',
      })
    }
  },

  /**
   * Установить пользователя после server-логина: cookie уже поставлена core,
   * здесь — только состояние UI (+ профиль).
   */
  setUser: async (user: User) => {
    set({ user, isAuthenticated: true, isLoading: false, error: null, authPhase: 'authenticated' })
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
      // Тема — браузерная настройка, а не часть личности пользователя: она
      // переживает выход, чтобы экран входа был в последней использованной
      // теме (cookie + localStorage, см. lib/theme/theme-persistence).
      // deployment/oidcEnabled/debugMode описывают сервер, а не сессию, и после
      // выхода нужны LoginForm для корректной ветки полей. Сбрасывать их нельзя:
      // reauthenticate() здесь не вызывается (isInitialized остаётся true), и при
      // сбросе логин-форма снова показала бы промежуточную password-only форму
      // (managed OIDC) либо спрятала поле «Сервер» (гибрид).
      resetRetry()
      set({ user: null, profile: null, isAuthenticated: false, isLoading: false, authPhase: 'guest' })
    }
  },

  sessionExpired: () => {
    resetRetry()
    set({ user: null, profile: null, isAuthenticated: false, isLoading: false, authPhase: 'guest' })
  },

  clearError: () => set({ error: null, errorCode: null }),
}))

/** Сброс модульных таймеров автоповтора (тесты). */
export function __resetAuthRetryForTests(): void {
  resetRetry()
}
