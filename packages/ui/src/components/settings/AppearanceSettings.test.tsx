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

function dialogButtonByText(text: string): HTMLButtonElement | undefined {
  const dialog = document.querySelector('[data-slot="dialog-content"]')
  if (!dialog) return undefined
  return Array.from(dialog.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  profileMock.resetPreferences.mockResolvedValue({
    themeMode: 'system',
    theme: 'flexoki',
    locale: 'ru',
  })
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

  it('сброс визуальных настроек оформлен SettingsActions и подтверждается', async () => {
    const container = await renderSettings()

    const reset = container.querySelector('[data-testid="appearance-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()

    await act(async () => {
      reset.click()
    })

    const confirm = dialogButtonByText('Reset to defaults')
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm!.click()
    })

    expect(profileMock.resetPreferences).toHaveBeenCalledTimes(1)
  })

  it('действия рендерятся внутри scroll-тела, а не fixed-футером', async () => {
    const container = await renderSettings()

    const scroll = container.querySelector('.overflow-y-auto')!
    const reset = container.querySelector('[data-testid="appearance-reset"]')!
    expect(scroll.contains(reset)).toBe(true)
  })
})
