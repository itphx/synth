import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const pwaState = vi.hoisted(() => ({ standalone: false }))
const i18n = vi.hoisted(() => ({ t: (key: string) => key, setLocale: () => {} }))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => i18n,
}))

vi.mock('@/stores/authStore', () => {
  const state = {
    user: { username: 'dev', email: 'dev@example.com', roles: [] },
    profile: { display_name: 'Dev', preferences: {} },
  }
  return {
    useAuthStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => ({ logout: vi.fn() }) },
    ),
  }
})

vi.mock('@/stores/useUIStore', () => {
  const state = {
    themeMode: 'system',
    setThemeMode: vi.fn(),
    locale: 'ru',
    setLocale: vi.fn(),
    setSettingsDialogOpen: vi.fn(),
    setSettingsPage: vi.fn(),
    uiScale: 1,
    setUiScale: vi.fn(),
  }
  return {
    useUIStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  }
})

vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ setThemeMode: vi.fn() }),
}))

vi.mock('@/lib/api/client', () => ({
  api: { getLocales: vi.fn().mockResolvedValue({ locales: [] }) },
}))

vi.mock('@/lib/pwa', () => ({
  isPwaStandalone: () => pwaState.standalone,
}))

vi.mock('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}))

import { QuickSettingsPopup } from './QuickSettingsPopup'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []

async function renderPopup(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<QuickSettingsPopup onSettingsClick={vi.fn()} />)
  })
  await act(async () => {})
  return host
}

async function openMenu(host: HTMLElement): Promise<void> {
  const trigger = host.querySelector('[data-icon="arrow-down-s"]')?.closest('button')
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonsByText(host: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button')).filter((b) => b.textContent?.includes(text))
}

function fullscreenButton(host: HTMLElement): HTMLButtonElement | undefined {
  return buttonsByText(host, 'auth.fullscreen')[0]
}

function defineFullscreen(prop: string, value: unknown): void {
  Object.defineProperty(document, prop, { configurable: true, get: () => value })
}

beforeEach(() => {
  pwaState.standalone = false
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
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled
  delete (document as unknown as Record<string, unknown>).fullscreenElement
  delete (document as unknown as Record<string, unknown>).exitFullscreen
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen
})

describe('QuickSettingsPopup: пункт «Обновить страницу»', () => {
  it('при pwaState.standalone = false пункт отображается (обычный браузер)', async () => {
    pwaState.standalone = false
    const host = await renderPopup()
    await openMenu(host)
    const reloadBtn = buttonsByText(host, 'auth.reloadPage')[0]
    expect(reloadBtn).toBeTruthy()
    expect(reloadBtn!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('refresh')
  })
})

describe('QuickSettingsPopup: пункт «Полный экран»', () => {
  it('без Fullscreen API пункт не отображается (jsdom)', async () => {
    const host = await renderPopup()
    await openMenu(host)
    expect(fullscreenButton(host)).toBeUndefined()
  })

  it('в PWA standalone пункт скрыт даже при поддержке API', async () => {
    defineFullscreen('fullscreenEnabled', true)
    pwaState.standalone = true
    const host = await renderPopup()
    await openMenu(host)
    expect(fullscreenButton(host)).toBeUndefined()
  })

  it('клик вызывает requestFullscreen, fullscreenchange меняет текст и иконку', async () => {
    defineFullscreen('fullscreenEnabled', true)
    defineFullscreen('fullscreenElement', null)
    const request = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: request,
    })
    const exit = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })

    const host = await renderPopup()
    await openMenu(host)

    const btn = fullscreenButton(host)
    expect(btn).toBeTruthy()
    expect(btn!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('fullscreen')

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(request).toHaveBeenCalledTimes(1)

    defineFullscreen('fullscreenElement', document.documentElement)
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    const exitBtn = buttonsByText(host, 'auth.exitFullscreen')[0]
    expect(exitBtn).toBeTruthy()
    expect(exitBtn!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('fullscreen-exit')

    await act(async () => {
      exitBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
