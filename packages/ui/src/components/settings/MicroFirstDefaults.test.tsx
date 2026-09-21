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

const providersStore = vi.hoisted(() => ({
  providers: [] as Array<{ name: string; enabled: boolean }>,
  models: [] as Array<{ name: string; provider: string; enabled: boolean }>,
}))

vi.mock('@/stores/providersStore', () => ({
  useProvidersStore: (selector: (s: typeof providersStore) => unknown) => selector(providersStore),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MicroFirstDefaults } from './MicroFirstDefaults'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STORAGE_KEY = 'synth-microfirst-defaults'

const DEFAULTS = {
  microFirst: false,
  microConfidenceThreshold: 0.8,
  embeddingEnabled: false,
  embedProvider: 'ollama',
  embedModel: 'local.nomic-embed-text:latest',
}

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
        <MicroFirstDefaults />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  localStorage.removeItem(STORAGE_KEY)
  document.body.innerHTML = ''
})

describe('MicroFirstDefaults — миграция на Settings UI Kit (AD-072)', () => {
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

  it('черновик сохраняется по Save, то есть через SettingsActions', async () => {
    const container = await renderSettings()

    const toggle = container.querySelector('[aria-label="Quick answers"]') as HTMLButtonElement
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const save = container.querySelector('[data-testid="microfirst-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.microFirst).toBe(true)
  })

  it('Reset возвращает дефолтные значения', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULTS, microFirst: true, microConfidenceThreshold: 0.95 }),
    )
    const container = await renderSettings()

    const reset = container.querySelector('[data-testid="microfirst-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    await act(async () => {
      reset.click()
    })

    // После сброса появляется бейдж «по умолчанию», Save доступен.
    expect(container.textContent).toContain('Default')
    const save = container.querySelector('[data-testid="microfirst-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored).toEqual(DEFAULTS)
  })
})
