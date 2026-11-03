/**
 * ModelSelector: селектор чата работает по **полному каталогу**.
 *
 * Пагинации и серверного поиска в селекторе нет: каталог грузится лениво при
 * первом открытии (`loadCatalogModels`), поиск/фильтр — локальные, поэтому
 * модель со «второй страницы» каталога находится сразу. Кнопки «Показать ещё»
 * в меню больше нет.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ModelSelector } from './ModelSelector'
import { useProvidersStore } from '@/stores/providersStore'
import type { ModelInfo, ProviderInfo } from '@/lib/api/synthApi'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const getModelGroups = vi.hoisted(() =>
  vi.fn(async (query?: { offset?: number; limit?: number }) => {
    const offset = query?.offset ?? 0
    const models =
      offset === 0
        ? Array.from({ length: 100 }, (_, i) => ({
            id: `on/bulk-${i}`,
            name: `bulk-${i}`,
            provider: 'on',
            enabled: true,
            isDefault: false,
          }))
        : [
            {
              id: 'on/target-model',
              name: 'target-model',
              provider: 'on',
              enabled: true,
              isDefault: false,
            },
          ]
    return {
      groups: [
        {
          provider: { name: 'on', type: 'openai', icon: '', defaultModel: '' },
          models,
        },
      ],
      page: {
        models,
        total: 101,
        offset,
        limit: query?.limit ?? 100,
        next_offset: (offset === 0 ? 100 : null) as number | null,
      },
    }
  }),
)

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
      getModelGroups,
      updateSession: vi.fn(async () => ({})),
    },
  }
})

if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {}
}
if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROVIDERS: ProviderInfo[] = [
  { name: 'on', type: 'openai', icon: '', url: '', model: '', enabled: true },
  { name: 'off', type: 'openai', icon: '', url: '', model: '', enabled: false },
]

function model(providerName: string, name: string): ModelInfo {
  return { id: `${providerName}/${name}`, name, provider: providerName, enabled: true, isDefault: false }
}

// jsdom не считает layout (offsetHeight = 0), а виртуализатор списка измеряет
// именно скролл-контейнер. Мокаем размеры, чтобы строки реально рендерились.
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

function mockLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 560, width: 600, height: 560,
      toJSON: () => ({}),
    } as unknown as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 560 },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return 600 },
  })
}

function restoreLayout(): void {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(compact = false): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<ModelSelector compact={compact} />)
  })
  await flush()
  return container
}

async function openMenu(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector('.model-selector-trigger') as HTMLElement
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await flush()
}

async function typeSearch(value: string): Promise<void> {
  const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
  expect(input).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  mockLayout()
  getModelGroups.mockClear()
  useProvidersStore.setState({
    providers: PROVIDERS,
    models: [],
    catalogModels: [],
    catalogLoaded: false,
    catalogLoading: false,
    modelsError: null,
    modelGroups: [],
    favorites: [],
    recents: [],
    selectedProviderName: 'on',
    selectedModelName: 'bulk-0',
  })
})

afterEach(async () => {
  restoreLayout()
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('ModelSelector: полный каталог без пагинации', () => {
  it('каталог грузится при первом открытии; модель со второй страницы находится локальным поиском', async () => {
    const container = await mount()
    // На монтировании модели не грузятся — только провайдеры.
    expect(getModelGroups).not.toHaveBeenCalled()

    await openMenu(container)
    // Две страницы по 500/…: каталог собран целиком.
    expect(getModelGroups).toHaveBeenCalledTimes(2)

    await typeSearch('target-model')
    expect(document.body.textContent).toContain('target-model')
    // Кнопки «Показать ещё» в меню нет.
    expect(document.querySelector('[data-testid="model-selector-load-more"]')).toBeNull()
  })

  it('повторное открытие не грузит каталог заново', async () => {
    const container = await mount()
    await openMenu(container)
    expect(getModelGroups).toHaveBeenCalledTimes(2)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    await openMenu(container)
    expect(getModelGroups).toHaveBeenCalledTimes(2)
  })

  it('выбранная отключённая пара остаётся в триггере (обычный и compact)', async () => {
    useProvidersStore.setState({
      catalogModels: [model('on', 'm-on'), model('off', 'm-off')],
      catalogLoaded: true,
      selectedProviderName: 'off',
      selectedModelName: 'm-off',
    })

    const normal = await mount()
    expect(normal.querySelector('.model-selector-trigger')!.textContent).toContain('m-off')

    const compact = await mount(true)
    expect(compact.querySelector('.model-selector-trigger')!.textContent).toContain('m-off')
  })

  it('полный каталог: локальный фильтр отключённого провайдера действует на рендере списка', async () => {
    useProvidersStore.setState({
      catalogModels: [model('on', 'm-on'), model('off', 'm-off')],
      catalogLoaded: true,
    })
    const container = await mount()
    await openMenu(container)

    const text = document.body.textContent ?? ''
    expect(text).toContain('m-on')
    // Отключённый провайдер отфильтрован на рендере списка.
    expect(text).not.toContain('m-off')
  })
})
