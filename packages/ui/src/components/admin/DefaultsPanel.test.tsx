import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const profileMock = vi.hoisted(() => ({ getDefaults: vi.fn() }))
const apiMock = vi.hoisted(() => ({ updateDefaults: vi.fn() }))
const confirmMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/lib/api/profileService', () => ({ profileService: profileMock }))
vi.mock('@/lib/api/client', () => ({ api: apiMock }))
vi.mock('@/lib/confirm', () => ({ confirm: confirmMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { DefaultsPanel } from './DefaultsPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULTS = {
  locale: 'ru',
  themeMode: 'system',
  theme: 'flexoki',
  uiScaleMobile: null,
  uiScaleDesktop: null,
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
        <DefaultsPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

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
