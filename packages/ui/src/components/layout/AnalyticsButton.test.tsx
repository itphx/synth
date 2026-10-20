import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useUIStore } from '@/stores/useUIStore'
import { AnalyticsButton } from './AnalyticsButton'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

/** Заглушка matchMedia: телефон + coarse pointer, иначе — всё false (десктоп). */
function stubPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 768px)' || query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

async function renderButton(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AnalyticsButton />
      </I18nProvider>,
    )
  })
  return host
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ isAnalyticsDialogOpen: false })
})

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AnalyticsButton (PROP-102)', () => {
  it('открывает модалку аналитики и сохраняет подпись/иконку', async () => {
    const host = await renderButton()
    const button = host.querySelector('[data-testid="header-analytics"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.getAttribute('aria-label')).toBe(enDict['analytics.title'])
    expect(button.getAttribute('title')).toBe(enDict['analytics.title'])
    expect(button.querySelector('svg')).toBeTruthy()

    await act(async () => {
      button.click()
    })

    expect(useUIStore.getState().isAnalyticsDialogOpen).toBe(true)
  })

  it('на touch-устройствах таргет ≥ 40px (ADR-044)', async () => {
    stubPhone()
    const host = await renderButton()
    const button = host.querySelector('[data-testid="header-analytics"]') as HTMLButtonElement
    expect(button.className).toContain('h-10')
    expect(button.className).toContain('w-10')
  })

  it('на десктопе — компактная иконка', async () => {
    const host = await renderButton()
    const button = host.querySelector('[data-testid="header-analytics"]') as HTMLButtonElement
    expect(button.className).toContain('h-8')
    expect(button.className).toContain('w-8')
  })
})
