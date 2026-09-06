export interface User {
  id: string
  username: string
  email: string | null
  roles: string[]
  preferred_language?: string
  team_role?: string
  notes?: string
  created_at?: string
  interview_completed?: boolean
}

export interface UserPreferences {
  locale?: 'en' | 'ru'
  themeMode?: 'system' | 'light' | 'dark'
  theme?: string
  transportMode?: 'auto' | 'ws' | 'sse'
  avatar?: string | null
  favoriteModels?: string[]
  recentModels?: string[]
  intermediateTextDisplay?: 'inline' | 'bottom'
  [key: string]: unknown
}

export interface Profile extends User {
  team_roles?: string[]
  is_active?: boolean
  preferences?: UserPreferences
  display_name?: string | null
  created_at?: string
  updated_at?: string
  last_login?: string | null
}

export interface AuthStatus {
  oidc_enabled: boolean
  debug_mode: boolean
  authenticated: boolean
  /** Тип развёртывания: 'standalone' (synth-core) | 'managed' (synth-backend). Runtime-детекция. */
  deployment?: DeploymentKind
  user: User | null
}

/** Тип развёртывания сервера. 'standalone' — synth-core (имеет /api/v2/hybrid/status). */
export type DeploymentKind = 'standalone' | 'managed'

export interface AuthUsers {
  users: Array<{
    id: string
    username: string
  }>
}

export interface SPALoginRequest {
  api_key: string
  username?: string
}

export interface SPALoginResponse {
  deployment?: DeploymentKind
  user: User
  token: string
}

/** Ответ POST /auth/login (парольный вход/переход в профиль сервера). */
export interface PasswordLoginResponse {
  deployment?: DeploymentKind
  user?: User
  token?: string
  /** Переход в профиль: процесс перезапускается обёрткой (user/token отсутствуют). */
  action?: 'switch-profile'
  server?: string
  message?: string
}

const BASE_URL = '/auth'

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = body as { error?: { message?: string }; detail?: string }
    throw new Error(error.error?.message || error.detail || `HTTP ${response.status}`)
  }
  return response.json()
}

export const api = {
  async getStatus(): Promise<AuthStatus> {
    return fetchJSON<AuthStatus>(`${BASE_URL}/status`)
  },

  async getUsers(): Promise<AuthUsers> {
    return fetchJSON<AuthUsers>(`${BASE_URL}/users`)
  },

  async spaLogin(request: SPALoginRequest): Promise<SPALoginResponse> {
    return fetchJSON<SPALoginResponse>(`${BASE_URL}/spa-login`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  },

  async loginWithPassword(
    server: string | undefined,
    username: string,
    password: string,
  ): Promise<PasswordLoginResponse> {
    return fetchJSON<PasswordLoginResponse>(`${BASE_URL}/login`, {
      method: 'POST',
      body: JSON.stringify({ server: server || undefined, username, password }),
    })
  },

  async logout(): Promise<void> {
    await fetch(`${BASE_URL}/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  },

  async getMe(): Promise<User> {
    return fetchJSON<User>(`${BASE_URL}/me`)
  },

  async getSession(): Promise<SPALoginResponse> {
    return fetchJSON<SPALoginResponse>(`${BASE_URL}/session`)
  },

  async getProfile(): Promise<Profile> {
    return fetchJSON<Profile>(`${BASE_URL}/profile`)
  },

  async updateProfile(data: Partial<Profile>): Promise<Profile> {
    const res = await fetchJSON<{ status: string; profile: Profile }>(`${BASE_URL}/profile`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
    return res.profile
  },

  async updatePreferences(data: Partial<UserPreferences>): Promise<{ status: string; preferences: UserPreferences }> {
    return fetchJSON<{ status: string; preferences: UserPreferences }>(`${BASE_URL}/profile/preferences`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async deletePreferences(): Promise<{ status: string; preferences: UserPreferences }> {
    return fetchJSON<{ status: string; preferences: UserPreferences }>(`${BASE_URL}/profile/preferences`, {
      method: 'DELETE',
    })
  },

  async getDefaults(): Promise<UserPreferences> {
    return fetchJSON<UserPreferences>(`${BASE_URL}/defaults`)
  },

  async updateDefaults(data: Partial<UserPreferences>): Promise<{ status: string; defaults: UserPreferences }> {
    return fetchJSON<{ status: string; defaults: UserPreferences }>(`${BASE_URL}/defaults`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async getLocales(): Promise<{ locales: Array<{ code: string; name: string; native_name: string }>; default: string }> {
    return fetchJSON<{ locales: Array<{ code: string; name: string; native_name: string }>; default: string }>(`${BASE_URL}/locales`)
  },
}