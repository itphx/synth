import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const profileMock = vi.hoisted(() => ({ getDefaults: vi.fn() }))
const apiMock = vi.hoisted(() => ({ updateDefaults: vi.fn() }))
const confirmMock = vi.hoisted(() => vi.fn(async () => true))

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

vi.mock('@/lib/api/profileService', () => ({ profileService: profileMock }))
vi.mock('@/lib/api/client', () => ({ api: apiMock }))
vi.mock('@/lib/confirm', () => ({ confirm: confirmMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DefaultsPanel } from './DefaultsPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULTS = {
  locale: 'ru',
  themeMode: 'system',
  theme: 'flexoki',
  uiScaleMobile: null,
  uiScaleDesktop: null,
  chatViewMode: null,
  chatDensity: null,
  chatScaleMobile: null,
  chatScaleDesktop: null,
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <DefaultsPanel />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

const radioByText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined

/** Значение range-слайдера панели умолчаний (0/1 — uiScale, 2/3 — чат-скейл). */
async function setSliderValue(container: HTMLElement, index: number, value: number) {
  const slider = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[index]
  expect(slider).toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(slider, String(value))
    slider!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  profileMock.getDefaults.mockResolvedValue({ ...DEFAULTS })
  apiMock.updateDefaults.mockResolvedValue({ status: 'ok', defaults: {} })
  confirmMock.mockResolvedValue(true)
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

describe('DefaultsPanel — ADR-072: без фиксированного футера, действия в теле', () => {
  it('Save/Reset находятся внутри scroll-тела, Save изначально disabled', async () => {
    const container = await renderPanel()

    const scroller = container.querySelector('.settings-scroll-container')
    const save = byTestId(container, 'defaults-save')
    const reset = byTestId(container, 'defaults-reset')

    expect(scroller).not.toBeNull()
    expect(save).not.toBeNull()
    expect(reset).not.toBeNull()
    expect(byTestId(container, 'defaults-cancel')).not.toBeNull()
    expect(scroller!.contains(save!)).toBe(true)
    expect(scroller!.contains(reset!)).toBe(true)
    expect(save!.disabled).toBe(true)
  })

  it('изменение настройки включает Save и сохраняет через api.updateDefaults', async () => {
    const container = await renderPanel()

    const light = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (b) => b.textContent?.trim() === 'Light',
    ) as HTMLButtonElement
    expect(light).toBeDefined()
    await act(async () => {
      light.click()
    })

    const save = byTestId(container, 'defaults-save')!
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })

    expect(apiMock.updateDefaults).toHaveBeenCalledTimes(1)
    expect(apiMock.updateDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ themeMode: 'light' }),
    )
  })

  it('Cancel откатывает черновик к загруженным дефолтам', async () => {
    const container = await renderPanel()

    const light = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (b) => b.textContent?.trim() === 'Light',
    ) as HTMLButtonElement
    await act(async () => {
      light.click()
    })

    const cancel = byTestId(container, 'defaults-cancel')!
    expect(cancel.disabled).toBe(false)
    await act(async () => {
      cancel.click()
    })

    expect(byTestId(container, 'defaults-save')!.disabled).toBe(true)
    expect(apiMock.updateDefaults).not.toHaveBeenCalled()
  })

  it('Reset подтверждается и перечитывает серверные дефолты', async () => {
    const container = await renderPanel()

    const reset = byTestId(container, 'defaults-reset')!
    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(profileMock.getDefaults).toHaveBeenCalledTimes(2)
  })
})

/**
 * Умолчания отображения чата: вид/плотность (SegmentedControl) и два слайдера
 * масштаба области чата (диапазон 0.75…1.5, не 0.5…1.2).
 */
describe('DefaultsPanel — умолчания отображения чата', () => {
  it('секции вида/плотности и масштаба чата рендерятся', async () => {
    const container = await renderPanel()

    expect(container.querySelector('[data-settings-section="defaults-chat-display"]')).not.toBeNull()
    expect(container.querySelector('[data-settings-section="defaults-chat-scale"]')).not.toBeNull()
    expect(radioByText(container, 'Feed')).toBeDefined()
    expect(radioByText(container, 'Compact')).toBeDefined()

    // Два слайдера uiScale + два слайдера чат-скейла.
    const sliders = container.querySelectorAll<HTMLInputElement>('input[type="range"]')
    expect(sliders).toHaveLength(4)
    expect(sliders[2]!.min).toBe('0.75')
    expect(sliders[2]!.max).toBe('1.5')
    expect(sliders[3]!.min).toBe('0.75')
  })

  it('Save отправляет вид, плотность и оба масштаба чата', async () => {
    const container = await renderPanel()

    await act(async () => {
      radioByText(container, 'Feed')!.click()
    })
    await act(async () => {
      radioByText(container, 'Compact')!.click()
    })
    await setSliderValue(container, 2, 0.9)
    await setSliderValue(container, 3, 1.3)

    const save = byTestId(container, 'defaults-save')!
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })

    expect(apiMock.updateDefaults).toHaveBeenCalledTimes(1)
    expect(apiMock.updateDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        chatViewMode: 'feed',
        chatDensity: 'compact',
        chatScaleMobile: 0.9,
        chatScaleDesktop: 1.3,
      }),
    )
  })

  it('сохранённые значения подхватываются в черновик (в т.ч. масштаб чата)', async () => {
    profileMock.getDefaults.mockResolvedValue({
      ...DEFAULTS,
      chatViewMode: 'feed',
      chatDensity: 'compact',
      chatScaleMobile: 0.9,
      chatScaleDesktop: 1.25,
    })

    const container = await renderPanel()

    expect(radioByText(container, 'Feed')!.getAttribute('aria-checked')).toBe('true')
    expect(radioByText(container, 'Compact')!.getAttribute('aria-checked')).toBe('true')

    const sliders = container.querySelectorAll<HTMLInputElement>('input[type="range"]')
    expect(sliders[2]!.value).toBe('0.9')
    expect(sliders[3]!.value).toBe('1.25')
  })

  it('Reset перечитывает серверные умолчания и сбрасывает черновик', async () => {
    const container = await renderPanel()

    await act(async () => {
      radioByText(container, 'Feed')!.click()
    })
    await act(async () => {
      byTestId(container, 'defaults-reset')!.click()
    })
    await act(async () => {})

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(profileMock.getDefaults).toHaveBeenCalledTimes(2)
    expect(radioByText(container, 'Detailed')!.getAttribute('aria-checked')).toBe('true')
    // Сброс не сохраняет: PUT не вызывался.
    expect(apiMock.updateDefaults).not.toHaveBeenCalled()
  })
})
