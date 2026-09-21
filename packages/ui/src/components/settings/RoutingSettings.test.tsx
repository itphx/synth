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
  providers: [{ name: 'ollama', enabled: true }],
  models: [{ name: 'llama3', provider: 'ollama', enabled: true }],
}))

vi.mock('@/stores/providersStore', () => ({
  useProvidersStore: (selector: (s: typeof providersStore) => unknown) => selector(providersStore),
}))

const apiMocks = vi.hoisted(() => ({
  getDictionaries: vi.fn(),
  getDictionary: vi.fn(),
  saveDictionary: vi.fn(),
  resetDictionary: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { RoutingSettings } from './RoutingSettings'

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
        <RoutingSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function buttonsByText(container: ParentNode, text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (b) => b.textContent?.trim() === text,
  )
}

beforeEach(() => {
  apiMocks.getDictionaries.mockResolvedValue({
    dictionaries: [
      { category: 'coding', language: 'ru', source: 'system', size: 10 },
      { category: 'research', language: 'ru', source: 'user', size: 20 },
    ],
  })
  apiMocks.getDictionary.mockResolvedValue({
    dictionary: { category: 'coding', language: 'ru', source: 'system', size: 10, content: 'hello' },
  })
  apiMocks.saveDictionary.mockResolvedValue({ status: 'ok' })
  apiMocks.resetDictionary.mockResolvedValue({ status: 'ok' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('RoutingSettings — миграция на Settings UI Kit (AD-072)', () => {
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

  it('раздел словарей рендерится и умеет сбрасывать пользовательский словарь', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Classification dictionaries')
    expect(container.textContent).toContain('Coding')

    const resetButtons = buttonsByText(container, 'Reset to system dictionary')
    expect(resetButtons).toHaveLength(1)

    await act(async () => {
      resetButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(apiMocks.resetDictionary).toHaveBeenCalledWith('research', 'ru')
  })

  it('редактор словаря сохраняет контент через SettingsActions', async () => {
    const container = await renderSettings()

    const editButtons = buttonsByText(container, 'Edit')
    expect(editButtons.length).toBeGreaterThanOrEqual(1)
    await act(async () => {
      editButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, 'changed')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const save = container.querySelector('[data-testid="routing-dictionary-save-coding"]') as HTMLButtonElement
    expect(save).not.toBeNull()
    await act(async () => {
      save.click()
    })

    expect(apiMocks.saveDictionary).toHaveBeenCalledWith('coding', 'ru', { content: 'changed' })
  })
})
