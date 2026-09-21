import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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
import { ChatSettings } from './ChatSettings'

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
        <ChatSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  useUIStore.setState({ intermediateTextDisplay: 'inline' })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('ChatSettings — миграция на Settings UI Kit (AD-072)', () => {
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

  it('сохраняет выбор способа отображения промежуточных ответов', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Intermediate responses')
    const radios = Array.from(container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[]
    expect(radios).toHaveLength(2)

    const bottom = radios.find((r) => r.textContent === 'At bottom')!
    await act(async () => {
      bottom.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().intermediateTextDisplay).toBe('bottom')
  })

  it('кнопка сброса возвращает intermediateTextDisplay в inline', async () => {
    const container = await renderSettings()

    const radios = Array.from(container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[]
    const bottom = radios.find((r) => r.textContent === 'At bottom')!
    await act(async () => {
      bottom.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useUIStore.getState().intermediateTextDisplay).toBe('bottom')

    const reset = container.querySelector('[data-testid="chat-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    await act(async () => {
      reset.click()
    })

    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })
})
