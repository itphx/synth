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
  initialize: vi.fn(),
  retry: vi.fn(),
  isLoading: false,
  error: null as string | null,
  clearError: vi.fn(),
  oidcEnabled: false,
  debugMode: false,
  deployment: null as 'standalone' | 'managed' | null,
  authPhase: 'guest' as 'checking' | 'authenticated' | 'guest' | 'unreachable',
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
import { AuthGate } from './AuthGate'

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
  authState.authPhase = 'guest'
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

  it('AuthGate в фазе unreachable не показывает форму входа', async () => {
    authState.authPhase = 'unreachable'
    authState.oidcEnabled = true
    authState.deployment = 'managed'

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
    await act(async () => {})

    expect(host.querySelector('[data-testid="auth-unreachable"]')).toBeTruthy()
    expect(host.querySelector('form')).toBeNull()
    expect(host.querySelector('#synth-login-apikey')).toBeNull()
    expect(host.querySelector('[data-testid="app-content"]')).toBeNull()
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

describe('LoginForm: клавиатура на мобильном', () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo
  let scrollToMock: ReturnType<typeof vi.fn>

  /**
   * Видимая область экрана. `setHeight` имитирует открытие/закрытие клавиатуры:
   * Android (interactive-widget=resizes-content) и iOS уменьшают visualViewport.
   */
  function installViewport(height: number): { setHeight: (next: number) => void } {
    vi.stubGlobal('innerHeight', height)
    const viewport = {
      width: 400,
      height,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as unknown as VisualViewport
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    return {
      setHeight: (next: number) => {
        ;(viewport as unknown as { height: number }).height = next
      },
    }
  }

  function screenEl(host: HTMLElement): HTMLElement {
    const el = host.querySelector('.login-screen')
    expect(el).toBeTruthy()
    return el as HTMLElement
  }

  beforeEach(() => {
    // Фейковые таймеры — только таймеры: React-шедулер на MessageChannel не трогаем.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    scrollToMock = vi.fn()
    // В jsdom нет Element.prototype.scrollTo — стаб нужен, чтобы проверить прокрутку.
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollToMock,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>).visualViewport
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value: originalScrollTo,
      })
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo
    }
  })

  it('видимая область уменьшилась: резерв не включается и прокрутки нет', async () => {
    const viewport = installViewport(800)
    const host = await renderLoginForm()
    const input = getInput(host, '#synth-login-apikey')

    act(() => {
      input.focus()
    })
    // Браузер «сообщает» клавиатуру: видимая область уменьшилась.
    viewport.setHeight(500)

    await act(async () => {
      vi.advanceTimersByTime(600)
      vi.advanceTimersByTime(400)
    })

    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(false)
    expect(scrollToMock).not.toHaveBeenCalled()
  })

  it('видимая область не изменилась: включается фоллбек (резерв + прокрутка)', async () => {
    installViewport(800)
    const host = await renderLoginForm()
    const input = getInput(host, '#synth-login-apikey')

    act(() => {
      input.focus()
    })

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(true)
    // Прокрутка отложена: сначала клавиатуре/лейауту дают раскрыться.
    expect(scrollToMock).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('blur снимает резерв и сбрасывает состояние', async () => {
    installViewport(800)
    const host = await renderLoginForm()
    const input = getInput(host, '#synth-login-apikey')

    act(() => {
      input.focus()
    })
    await act(async () => {
      vi.advanceTimersByTime(900)
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(true)

    act(() => {
      input.blur()
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(false)
    // Возврат формы наверх после снятия резерва.
    expect(scrollToMock).toHaveBeenCalledTimes(2)
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('переход фокуса между полями не сбрасывает и не пересчитывает резерв', async () => {
    authState.oidcEnabled = true
    authState.deployment = 'managed'
    installViewport(800)
    const host = await renderLoginForm()
    const username = getInput(host, '#synth-login-username')
    const password = getInput(host, '#synth-login-password')

    act(() => {
      username.focus()
    })
    await act(async () => {
      vi.advanceTimersByTime(900)
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(true)
    expect(scrollToMock).toHaveBeenCalledTimes(1)

    // Уход фокуса с первого поля и приход на второе внутри blur-задержки (200 мс).
    act(() => {
      username.blur()
    })
    act(() => {
      vi.advanceTimersByTime(100)
      password.focus()
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(true)
    // Повторного фокуса/прокрутки нет — резерв уже включён.
    expect(scrollToMock).toHaveBeenCalledTimes(1)
  })

  it('первый фокус сообщил клавиатуру: второе поле после blur не включает резерв повторно', async () => {
    authState.oidcEnabled = true
    authState.deployment = 'managed'
    const viewport = installViewport(800)
    const host = await renderLoginForm()
    const username = getInput(host, '#synth-login-username')
    const password = getInput(host, '#synth-login-password')

    act(() => {
      username.focus()
    })
    viewport.setHeight(500)
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    // Браузер сообщил клавиатуру — резерв не нужен.
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(false)

    // Полный уход фокуса позже blur-задержки: визуальный резерв снят,
    // но вердикт «клавиатура сообщается» должен сохраниться.
    act(() => {
      username.blur()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(false)

    // Второе поле при уже уменьшенной области: базовая высота маленькая,
    // уменьшения нет — но детект запускаться не должен.
    act(() => {
      password.focus()
    })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(false)
    // Единственный scrollTo — возврат наверх после blur (top: 0), прокрутки вниз нет.
    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('после фоллбека повторный фокус включает резерв сразу, без нового окна детекта', async () => {
    authState.oidcEnabled = true
    authState.deployment = 'managed'
    installViewport(800)
    const host = await renderLoginForm()
    const username = getInput(host, '#synth-login-username')
    const password = getInput(host, '#synth-login-password')

    act(() => {
      username.focus()
    })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(scrollToMock).toHaveBeenCalledTimes(1)

    act(() => {
      username.blur()
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(false)
    expect(scrollToMock).toHaveBeenCalledTimes(2)

    // Режим fallback запомнен: класс возвращается сразу, не через 600 мс детекта.
    act(() => {
      password.focus()
    })
    expect(screenEl(host).classList.contains('login-screen--keyboard')).toBe(true)
    expect(scrollToMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(scrollToMock).toHaveBeenCalledTimes(3)
  })
})
