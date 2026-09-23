import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getModels: vi.fn(),
  fetchModels: vi.fn(async () => ({ fetched: 0, new: 0, enriched: 0 })),
  saveModel: vi.fn(async () => ({})),
  deleteModel: vi.fn(async () => undefined),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ModelsPanel } from './ModelsPanel'

// Radix Popover внутри использует floating-ui/ResizeObserver — в jsdom его нет.
if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
        <ModelsPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  apiMock.getModels.mockResolvedValue([
    {
      provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '', currency: 'USD' },
      models: [
        {
          id: 'itphx/m1',
          name: 'm1',
          provider: 'itphx',
          enabled: true,
          isDefault: false,
          input_price: 3.28,
          output_price: 1.5,
          cache_read_price: 0.1,
          cache_write_price: 0.2,
          currency: 'USD',
        },
      ],
    },
  ])
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

describe('ModelsPanel: валюта цен и инлайн-инпуты', () => {
  it('value числовых инпутов цен — сырое число без символа валюты (регрессия warning)', async () => {
    const container = await renderPanel()
    const inputs = (['in', 'out', 'cr', 'cw'] as const).map(
      (placeholder) => container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement,
    )
    expect(inputs.every(Boolean)).toBe(true)
    expect(inputs.map((i) => i.value)).toEqual(['3.28', '1.5', '0.1', '0.2'])
    for (const input of inputs) {
      expect(input.value).not.toContain('$')
      expect(input.value).not.toContain('₽')
      expect(input.value).not.toContain('¥')
    }
  })

  it('кнопка валюты открывает поповер и сохраняет выбранную валюту через POST /models', async () => {
    const container = await renderPanel()
    const trigger = container.querySelector('button[aria-label="Price currency"]') as HTMLButtonElement
    expect(trigger).toBeTruthy()

    await act(async () => {
      trigger.click()
    })
    const rubOption = [...document.body.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Ruble'),
    ) as HTMLButtonElement | undefined
    expect(rubOption).toBeTruthy()

    await act(async () => {
      rubOption!.click()
    })
    await act(async () => {})

    expect(apiMock.saveModel).toHaveBeenCalledWith({
      id: 'itphx/m1',
      currency: 'RUB',
    })
  })

  it('символ валюты кнопки наследуется от провайдера, если у модели не задан', async () => {
    apiMock.getModels.mockResolvedValue([
      {
        provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '', currency: 'RUB' },
        models: [
          { id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false },
        ],
      },
    ])
    const container = await renderPanel()
    const trigger = container.querySelector('button[aria-label="Price currency"]') as HTMLButtonElement
    expect(trigger.textContent).toContain('₽')
  })
})
