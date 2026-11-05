import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/client', () => ({
  api: {
    getStatus: vi.fn(),
    logout: vi.fn(),
  },
}))

vi.mock('@/lib/api/profileService', () => ({
  profileService: {
    initialize: vi.fn().mockResolvedValue(undefined),
  },
}))

import { api } from '@/lib/api/client'
import { useAuthStore, __resetAuthRetryForTests } from '@/stores/authStore'
import { AuthGate } from './AuthGate'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []

function resetAuth(): void {
  __resetAuthRetryForTests()
  useAuthStore.setState({
    user: null,
    profile: null,
    isAuthenticated: false,
    isLoading: false,
    isInitialized: false,
    error: null,
    authPhase: 'checking',
    deployment: null,
    oidcEnabled: false,
    debugMode: false,
  })
}

async function flush(): Promise<void> {
  await act(async () => {})
  await act(async () => {})
}

async function renderGate(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(
      <AuthGate>
        <div data-testid="app-content" />
      </AuthGate>,
    )
  })
  await flush()
  return host
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', { removeItem: vi.fn() })
  resetAuth()
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  __resetAuthRetryForTests()
  vi.unstubAllGlobals()
})

describe('AuthGate: сеть недоступна ≠ гость', () => {
  it('сеть/таймаут → экран «Сервер недоступен», формы входа нет', async () => {
    vi.mocked(api.getStatus).mockRejectedValue(new TypeError('Failed to fetch'))

    const host = await renderGate()

    expect(host.querySelector('[data-testid="auth-unreachable"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="app-content"]')).toBeNull()
    // Ключевой регресс: на managed/OIDC не появляется форма с API-ключом.
    expect(host.querySelector('#synth-login-apikey')).toBeNull()
    expect(useAuthStore.getState().authPhase).toBe('unreachable')
  })

  it('«Повторить» после восстановления связи → приложение', async () => {
    vi.mocked(api.getStatus).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const host = await renderGate()
    expect(host.querySelector('[data-testid="auth-unreachable"]')).toBeTruthy()

    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: true,
      debug_mode: false,
      oidc_enabled: true,
      deployment: 'managed',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    const retryButton = host.querySelector('[data-testid="auth-unreachable"] button')
    expect(retryButton).toBeTruthy()
    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(host.querySelector('[data-testid="app-content"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="auth-unreachable"]')).toBeNull()
  })

  it('успешная проверка → children; гость → форма входа', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: true,
      debug_mode: false,
      oidc_enabled: false,
      deployment: 'managed',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })

    let host = await renderGate()
    expect(host.querySelector('[data-testid="app-content"]')).toBeTruthy()

    // Второй прогон: чистый гость — прежняя форма входа.
    resetAuth()
    vi.mocked(api.getStatus).mockResolvedValue({
      authenticated: false,
      debug_mode: false,
      oidc_enabled: false,
      deployment: 'managed',
      user: null,
    })
    host = await renderGate()
    expect(host.querySelector('form')).toBeTruthy()
    expect(host.querySelector('[data-testid="app-content"]')).toBeNull()
  })
})
