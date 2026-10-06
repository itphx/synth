import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

/** Мутабельное состояние authStore: компонент читает возможности сервера (oidc/debug/deployment) из стора. */
const authState = vi.hoisted(() => ({
  login: vi.fn(),
  loginWithPassword: vi.fn(),
  isLoading: false,
  error: null as string | null,
  clearError: vi.fn(),
  oidcEnabled: false,
  debugMode: false,
  deployment: null as 'standalone' | 'managed' | null,
}))

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}))

vi.mock('@/lib/api/client', () => ({
  api: {
    getUsers: vi.fn(),
  },
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getHybridStatus: vi.fn(),
  },
}))

import { api } from '@/lib/api/client'
import { synthApi } from '@/lib/api/synthApi'
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
  // эффекты (debug-users / hybrid) асинхронные — даём микротаскам завершиться
  await act(async () => {})
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
  // Дефолт: возможности сервера пусты, LoginForm рендерится в API-key ветке.
  authState.oidcEnabled = false
  authState.debugMode = false
  authState.deployment = null
  authState.error = null
  authState.isLoading = false
  vi.mocked(api.getUsers).mockResolvedValue({ users: [] })
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
    authState.oidcEnabled = true
    authState.deployment = 'managed'

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

    // Managed-сервер: /hybrid/status не запрашиваем (эндпоинта нет → без 404-шума).
    expect(synthApi.getHybridStatus).not.toHaveBeenCalled()
  })

  it('managed + oidcEnabled: с первого кадра есть И логин, И пароль (нет password-only формы)', async () => {
    authState.oidcEnabled = true
    authState.deployment = 'managed'

    const host = await renderLoginForm()

    // Оба поля присутствуют сразу — менеджер паролей не увидит промежуточную форму
    // с одиноким полем пароля и не перепутает слоты логина/пароля.
    const username = getInput(host, '#synth-login-username')
    const password = getInput(host, '#synth-login-password')
    expect(username.getAttribute('type')).toBe('text')
    expect(username.getAttribute('autocomplete')).toBe('username')
    expect(password.getAttribute('type')).toBe('password')
    expect(host.querySelector('#synth-login-apikey')).toBeNull()
  })

  it('режим API-ключа: поле не выглядит как пароль учётной записи', async () => {
    authState.oidcEnabled = false
    authState.deployment = 'managed'

    const host = await renderLoginForm()

    const apiKey = getInput(host, '#synth-login-apikey')
    expect(apiKey.getAttribute('type')).toBe('password')
    expect(apiKey.getAttribute('name')).toBe('apiKey')
    expect(apiKey.getAttribute('autocomplete')).toBe('off')
    expect(getLabel(host, 'synth-login-apikey').htmlFor).toBe(apiKey.id)

    // name не подсказывает браузеру, что это логин/пароль учётной записи
    const name = apiKey.getAttribute('name') ?? ''
    expect(name).not.toMatch(/username|password/i)

    // В API-key ветке поля логина учётной записи нет
    expect(host.querySelector('#synth-login-username')).toBeNull()
  })

  it('debug-режим: триггер выбора пользователя размечен id и связан с label', async () => {
    authState.oidcEnabled = false
    authState.debugMode = true
    authState.deployment = 'managed'
    vi.mocked(api.getUsers).mockResolvedValue({
      users: [{ id: 'u1', username: 'admin' }],
    })

    const host = await renderLoginForm()

    // Нативный <select> заменён китовым Base UI Select: триггер — кнопка с ролью combobox.
    const trigger = host.querySelector('#synth-login-username')
    expect(trigger).toBeTruthy()
    expect(trigger!.getAttribute('role')).toBe('combobox')
    expect(getLabel(host, 'synth-login-username').htmlFor).toBe(trigger!.id)
  })
})
