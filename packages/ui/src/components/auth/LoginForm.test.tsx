import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/authStore', () => {
  const state = {
    login: vi.fn(),
    loginWithPassword: vi.fn(),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
  }
  return {
    useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  }
})

vi.mock('@/lib/api/client', () => ({
  api: {
    getStatus: vi.fn(),
    getUsers: vi.fn(),
  },
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getHybridStatus: vi.fn(),
  },
}))

import { api } from '@/lib/api/client'
import { LoginForm } from './LoginForm'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []

async function renderLoginForm(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<LoginForm />)
  })
  // эффект checkStatus() асинхронный — даём микротаскам завершиться
  await act(async () => {})
  return host
}

function getInput(host: HTMLElement, selector: string): HTMLInputElement {
  const el = host.querySelector(selector)
  expect(el).toBeTruthy()
  return el as HTMLInputElement
}

function getLabel(host: HTMLElement, id: string): HTMLLabelElement {
  const label = host.querySelector(`label[for="${id}"]`)
  expect(label).toBeTruthy()
  return label as HTMLLabelElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  vi.restoreAllMocks()
})

describe('LoginForm: атрибуты полей для автозаполнения', () => {
  it('OIDC-режим: username/password размечены id/name/autocomplete и связаны с label', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      oidc_enabled: true,
      debug_mode: false,
      authenticated: false,
      user: null,
      deployment: 'managed',
    })

    const host = await renderLoginForm()

    // Форма целиком размечена для менеджеров паролей
    const form = host.querySelector('form')
    expect(form).toBeTruthy()
    expect(form!.getAttribute('name')).toBe('synth-login')
    expect(form!.getAttribute('autocomplete')).toBe('on')

    // Логин
    const username = getInput(host, '#synth-login-username')
    expect(username.tagName).toBe('INPUT')
    expect(username.getAttribute('type')).toBe('text')
    expect(username.getAttribute('name')).toBe('username')
    expect(username.getAttribute('autocomplete')).toBe('username')
    expect(username.getAttribute('id')).toBe('synth-login-username')
    expect(getLabel(host, 'synth-login-username').htmlFor).toBe(username.id)

    // Пароль
    const password = getInput(host, '#synth-login-password')
    expect(password.getAttribute('type')).toBe('password')
    expect(password.getAttribute('name')).toBe('password')
    expect(password.getAttribute('autocomplete')).toBe('current-password')
    expect(password.getAttribute('id')).toBe('synth-login-password')
    expect(getLabel(host, 'synth-login-password').htmlFor).toBe(password.id)
  })

  it('режим API-ключа: поле не выглядит как пароль учётной записи', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      oidc_enabled: false,
      debug_mode: false,
      authenticated: false,
      user: null,
      deployment: 'managed',
    })

    const host = await renderLoginForm()

    const apiKey = getInput(host, '#synth-login-apikey')
    expect(apiKey.getAttribute('type')).toBe('password')
    expect(apiKey.getAttribute('name')).toBe('apiKey')
    expect(apiKey.getAttribute('autocomplete')).toBe('off')
    expect(getLabel(host, 'synth-login-apikey').htmlFor).toBe(apiKey.id)

    // name не подсказывает браузеру, что это логин/пароль учётной записи
    const name = apiKey.getAttribute('name') ?? ''
    expect(name).not.toMatch(/username|password/i)
  })

  it('debug-режим: select выбора пользователя размечен id/name и связан с label', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      oidc_enabled: false,
      debug_mode: true,
      authenticated: false,
      user: null,
      deployment: 'managed',
    })
    vi.mocked(api.getUsers).mockResolvedValue({
      users: [{ id: 'u1', username: 'admin' }],
    })

    const host = await renderLoginForm()

    const select = host.querySelector('#synth-login-username')
    expect(select).toBeTruthy()
    expect(select!.tagName).toBe('SELECT')
    expect(select!.getAttribute('name')).toBe('username')
    expect(getLabel(host, 'synth-login-username').htmlFor).toBe(select!.id)
  })
})
