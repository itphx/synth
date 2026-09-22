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
import { useNotificationStore, type NotifyCategory } from '@/stores/notificationStore'
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

async function unmountOne(container: HTMLElement) {
  const idx = roots.findIndex((r) => r.container === container)
  if (idx < 0) return
  const [{ root, container: c }] = roots.splice(idx, 1)
  await act(async () => {
    root.unmount()
  })
  c.remove()
}

const DEFAULTS: Record<NotifyCategory, boolean> = {
  connection: true,
  streaming: false,
  queue: true,
  message: false,
  error: true,
  system: true,
}

beforeEach(() => {
  useNotificationStore.setState({
    prefs: { enabledCategories: { ...DEFAULTS } },
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

const switchByLabel = (container: HTMLElement, label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

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

  it('все категории — ToggleField-переключатели', async () => {
    const container = await renderSettings()
    const switches = Array.from(container.querySelectorAll('[role="switch"]')) as HTMLButtonElement[]
    expect(switches).toHaveLength(6)
    expect(switchByLabel(container, 'Streaming').getAttribute('aria-checked')).toBe('false')
  })

  it('тумблер меняет черновик, но не пишет в стор до Save', async () => {
    const container = await renderSettings()

    const streaming = switchByLabel(container, 'Streaming')
    await act(async () => {
      streaming.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Черновик изменился, стор — нет.
    expect(switchByLabel(container, 'Streaming').getAttribute('aria-checked')).toBe('true')
    expect(useNotificationStore.getState().prefs.enabledCategories.streaming).toBe(false)

    await act(async () => {
      byTestId(container, 'notifications-save')!.click()
    })
    expect(useNotificationStore.getState().prefs.enabledCategories.streaming).toBe(true)
  })

  it('Cancel возвращает черновик к сохранённому состоянию', async () => {
    const container = await renderSettings()

    await act(async () => {
      switchByLabel(container, 'Streaming').click()
      switchByLabel(container, 'Messages').click()
    })
    await act(async () => {
      byTestId(container, 'notifications-cancel')!.click()
    })

    expect(switchByLabel(container, 'Streaming').getAttribute('aria-checked')).toBe('false')
    expect(switchByLabel(container, 'Messages').getAttribute('aria-checked')).toBe('false')
    expect(useNotificationStore.getState().prefs.enabledCategories).toEqual(DEFAULTS)
  })

  it('закрытие панели (unmount) не персистит черновик', async () => {
    const container = await renderSettings()

    await act(async () => {
      switchByLabel(container, 'Streaming').click()
    })
    expect(useNotificationStore.getState().prefs.enabledCategories.streaming).toBe(false)

    await unmountOne(container)
    expect(useNotificationStore.getState().prefs.enabledCategories.streaming).toBe(false)
  })

  it('Reset сбрасывает черновик к дефолтам, персист — только по Save', async () => {
    // Сохранённое состояние уведено от дефолта.
    useNotificationStore.setState({
      prefs: {
        enabledCategories: {
          connection: false,
          streaming: false,
          queue: false,
          message: false,
          error: false,
          system: false,
        },
      },
    })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'notifications-reset')!.click()
    })

    expect(switchByLabel(container, 'Connection (WS/SSE)').getAttribute('aria-checked')).toBe('true')
    expect(switchByLabel(container, 'System').getAttribute('aria-checked')).toBe('true')
    // Стор всё ещё у дефолта-дефолта (всё false) — Reset не персистит.
    expect(useNotificationStore.getState().prefs.enabledCategories.connection).toBe(false)

    await act(async () => {
      byTestId(container, 'notifications-save')!.click()
    })
    expect(useNotificationStore.getState().prefs.enabledCategories).toEqual(DEFAULTS)
  })

  it('Reset серый/неактивен на дефолте и активен при изменениях', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'notifications-reset')!.disabled).toBe(true)
    expect(byTestId(container, 'notifications-reset')!.className).toContain('border-muted-foreground')

    await act(async () => {
      switchByLabel(container, 'Streaming').click()
    })

    expect(byTestId(container, 'notifications-reset')!.disabled).toBe(false)
    expect(byTestId(container, 'notifications-reset')!.className).toContain('border-primary')
  })
})
