import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const themeSystem = vi.hoisted(() => ({
  themeMode: 'system' as const,
  theme: 'flexoki',
  setThemeMode: vi.fn(),
  setThemePreference: vi.fn(),
}))

vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => themeSystem,
}))

const profileMock = vi.hoisted(() => ({
  resetPreferences: vi.fn(),
  syncThemeModeToProfile: vi.fn(),
  syncThemeToProfile: vi.fn(),
  syncLocaleToProfile: vi.fn(),
  syncIntermediateTextDisplayToProfile: vi.fn(),
  syncTransportModeToProfile: vi.fn(),
}))

vi.mock('@/lib/api/profileService', () => ({ profileService: profileMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUIStore } from '@/stores/useUIStore'
import { CHAT_SCALE_DEFAULT, CHAT_SCALE_STORAGE_KEY, UI_SCALE_STORAGE_KEY } from '@/lib/uiScale'
import { AppearanceSettings } from './AppearanceSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <AppearanceSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

async function unmountOne(container: HTMLElement) {
  const idx = roots.findIndex((r) => r.container === container)
  if (idx < 0) return
  const [{ root, container: c }] = roots.splice(idx, 1)
  await act(async () => {
    root.unmount()
  })
  c.remove()
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

const radioByText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent?.trim() === text,
  ) as HTMLButtonElement

beforeEach(() => {
  themeSystem.themeMode = 'system'
  themeSystem.theme = 'flexoki'
  useUIStore.setState({ theme: 'flexoki', themeMode: 'system' })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('AppearanceSettings — миграция на Settings UI Kit (ADR-072)', () => {
  it('каркас — SettingsPanel с единственным scroll-контейнером и без pr-2', async () => {
    const container = await renderSettings()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
  })

  it('нет grid без базового grid-cols-1', async () => {
    const container = await renderSettings()
    container.querySelectorAll('.grid').forEach((el) => {
      expect(el.classList.contains('grid-cols-1')).toBe(true)
    })
  })

  it('действия Save/Cancel/Reset рендерятся внутри scroll-тела', async () => {
    const container = await renderSettings()

    const scroll = container.querySelector('.overflow-y-auto')!
    for (const id of ['appearance-save', 'appearance-cancel', 'appearance-reset']) {
      const btn = byTestId(container, id)
      expect(btn).not.toBeNull()
      expect(scroll.contains(btn!)).toBe(true)
    }
  })

  it('Save персистит выбранные тему/режим/локаль', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'Dark').click()
    })
    // Preview: стор обновился сразу, профиль ещё нет.
    expect(useUIStore.getState().themeMode).toBe('dark')
    expect(themeSystem.setThemeMode).toHaveBeenCalledWith('dark')
    expect(profileMock.syncThemeModeToProfile).not.toHaveBeenCalled()

    await act(async () => {
      byTestId(container, 'appearance-save')!.click()
    })

    expect(profileMock.syncThemeModeToProfile).toHaveBeenCalledWith('dark')
    expect(profileMock.syncThemeToProfile).toHaveBeenCalledWith('flexoki')
    expect(profileMock.syncLocaleToProfile).toHaveBeenCalledWith('en')
  })

  it('Cancel откатывает live-preview к снапшоту', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'Dark').click()
    })
    expect(useUIStore.getState().themeMode).toBe('dark')

    await act(async () => {
      byTestId(container, 'appearance-cancel')!.click()
    })

    expect(useUIStore.getState().themeMode).toBe('system')
    expect(radioByText(container, 'System').getAttribute('aria-checked')).toBe('true')
    expect(profileMock.syncThemeModeToProfile).not.toHaveBeenCalled()
  })

  it('закрытие (unmount) без Save откатывает live-preview', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'Dark').click()
    })
    expect(useUIStore.getState().themeMode).toBe('dark')

    await unmountOne(container)

    expect(useUIStore.getState().themeMode).toBe('system')
    expect(profileMock.syncThemeModeToProfile).not.toHaveBeenCalled()
  })

  it('Reset сбрасывает черновик к дефолтам без подтверждения и без персиста', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'Dark').click()
    })
    await act(async () => {
      byTestId(container, 'appearance-reset')!.click()
    })

    // После сброса локаль становится ru, поэтому radio ищем по порядку
    // (System / Light / Dark), а не по англоязычной подписи.
    const themeModeRadios = container.querySelectorAll('[role="radio"]')
    expect(themeModeRadios[0]!.getAttribute('aria-checked')).toBe('true')
    expect(useI18nStore.getState().locale).toBe('ru')
    // Сброс — только черновик: без ConfirmDialog и без персиста.
    expect(profileMock.resetPreferences).not.toHaveBeenCalled()
    expect(profileMock.syncLocaleToProfile).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
  })

  it('Reset активен при отличии от дефолта и серый/неактивен после сброса', async () => {
    const container = await renderSettings()
    const reset = () =>
      container.querySelector('[data-testid="appearance-reset"]') as HTMLButtonElement

    // Локаль en, а дефолт appearance — ru → Reset цветная и активна.
    expect(reset().disabled).toBe(false)
    expect(reset().className).toContain('border-primary')

    await act(async () => {
      reset().click()
    })

    // Значения стали дефолтными — Reset серая и disabled.
    expect(reset().disabled).toBe(true)
    expect(reset().className).toContain('border-muted-foreground')
  })
})

describe('AppearanceSettings — масштаб области чата', () => {
  const setSliderValue = async (container: HTMLElement, index: number, value: number) => {
    const slider = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[index]
    expect(slider).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(slider, String(value))
      slider!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    useUIStore.setState({ chatScale: CHAT_SCALE_DEFAULT })
    document.documentElement.style.removeProperty('--chat-scale')
    document.documentElement.style.removeProperty('--ui-scale')
    localStorage.removeItem(CHAT_SCALE_STORAGE_KEY)
  })

  afterEach(() => {
    document.documentElement.style.removeProperty('--chat-scale')
    document.documentElement.style.removeProperty('--ui-scale')
  })

  it('рендерит отдельную секцию с масштабом чата (второй слайдер)', async () => {
    const container = await renderSettings()

    const section = container.querySelector('[data-settings-section="appearance-chat-scale"]')
    expect(section).not.toBeNull()

    const sliders = container.querySelectorAll('input[type="range"]')
    expect(sliders).toHaveLength(2)
    expect(sliders[1]!.getAttribute('aria-label')).toBe('Chat area scale')
    expect(section!.contains(sliders[1]!)).toBe(true)
  })

  it('live-preview: слайдер меняет --chat-scale и стор, но не пишет в localStorage', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1, 1.2)

    expect(useUIStore.getState().chatScale).toBe(1.2)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.2')
    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('Save персистит оба масштаба', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 0, 1.1)
    await setSliderValue(container, 1, 1.2)

    await act(async () => {
      byTestId(container, 'appearance-save')!.click()
    })

    // Оба масштаба пишутся debounce'ом (~300 мс).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.2')
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.1')
    expect(useUIStore.getState().chatScale).toBe(1.2)
  })

  it('Cancel откатывает масштаб чата к снапшоту', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1, 1.35)
    expect(useUIStore.getState().chatScale).toBe(1.35)

    await act(async () => {
      byTestId(container, 'appearance-cancel')!.click()
    })

    expect(useUIStore.getState().chatScale).toBe(CHAT_SCALE_DEFAULT)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1')
    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('закрытие (unmount) без Save откатывает масштаб чата', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1, 1.3)
    expect(useUIStore.getState().chatScale).toBe(1.3)

    await unmountOne(container)

    expect(useUIStore.getState().chatScale).toBe(CHAT_SCALE_DEFAULT)
  })

  it('Reset возвращает дефолтные масштабы', async () => {
    useUIStore.setState({ chatScale: 1.3 })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'appearance-reset')!.click()
    })

    expect(useUIStore.getState().chatScale).toBe(CHAT_SCALE_DEFAULT)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1')
  })
})
