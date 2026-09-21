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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useNotificationStore } from '@/stores/notificationStore'
import { NotificationSettings } from './NotificationSettings'

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
        <NotificationSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  useNotificationStore.setState({
    prefs: {
      enabledCategories: {
        connection: true,
        streaming: false,
        queue: true,
        message: false,
        error: true,
        system: true,
      },
    },
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
  document.body.innerHTML = ''
})

describe('NotificationSettings — миграция на Settings UI Kit (AD-072)', () => {
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

  it('все категории — ToggleField-переключатели, тоггл меняет настройку', async () => {
    const container = await renderSettings()

    const switches = Array.from(container.querySelectorAll('[role="switch"]')) as HTMLButtonElement[]
    expect(switches).toHaveLength(6)

    const streaming = container.querySelector('[aria-label="Streaming"]') as HTMLButtonElement
    expect(streaming.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      streaming.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useNotificationStore.getState().prefs.enabledCategories.streaming).toBe(true)
  })

  it('кнопка сброса возвращает все категории к дефолту', async () => {
    const container = await renderSettings()

    // Уводим категории от дефолта: system (true) → false, message (false) → true.
    const system = container.querySelector('[aria-label="System"]') as HTMLButtonElement
    const message = container.querySelector('[aria-label="Messages"]') as HTMLButtonElement
    await act(async () => {
      system.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      message.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useNotificationStore.getState().prefs.enabledCategories).toMatchObject({
      system: false,
      message: true,
    })

    const reset = container.querySelector('[data-testid="notifications-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    await act(async () => {
      reset.click()
    })

    expect(useNotificationStore.getState().prefs.enabledCategories).toEqual({
      connection: true,
      streaming: false,
      queue: true,
      message: false,
      error: true,
      system: true,
    })
  })
})
