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
import { useUIStore } from '@/stores/useUIStore'
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
        <AppearanceSettings />
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
  useUIStore.setState({ theme: 'flexoki', themeMode: 'system', locale: 'en' })
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

describe('AppearanceSettings — миграция на Settings UI Kit (AD-072)', () => {
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
})
