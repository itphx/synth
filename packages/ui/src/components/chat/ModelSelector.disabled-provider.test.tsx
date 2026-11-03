/**
 * ModelSelector: списки выбора не показывают модели отключённых провайдеров.
 *
 * Данные стора остаются полными, поэтому выбранная отключённая пара остаётся
 * в триггере (не сбрасываем выбор), а фильтр действует только на рендер списка
 * (обычный список, compact, избранное/недавние, локальный поиск).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ModelSelector } from './ModelSelector'
import { useProvidersStore } from '@/stores/providersStore'
import type { ModelInfo, ProviderInfo } from '@/lib/api/synthApi'
import type { ModelsPage } from '@/lib/api/models'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
      getModelGroups: vi.fn(async () => ({
        groups: [],
        page: { models: [], total: 0, offset: 0, limit: 100, next_offset: null } satisfies ModelsPage,
      })),
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
  return {
    id: `${providerName}/${name}`,
    name,
    provider: providerName,
    enabled: true,
    isDefault: false,
  }
}

const MODELS: ModelInfo[] = [model('on', 'm-on'), model('off', 'm-off')]

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
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

beforeEach(() => {
  useProvidersStore.setState({
    providers: PROVIDERS,
    models: MODELS,
    catalogModels: MODELS,
    catalogLoaded: true,
    catalogLoading: false,
    modelsError: null,
    modelGroups: [],
    favorites: [],
    recents: [],
    selectedProviderName: 'on',
    selectedModelName: 'm-on',
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

describe('ModelSelector: отключённый провайдер', () => {
  it('обычный список и grouped-секции не содержат моделей отключённого провайдера', async () => {
    const container = await mount()
    await openMenu(container)

    const text = document.body.textContent ?? ''
    expect(text).toContain('m-on')
    expect(text).not.toContain('m-off')
    // Провайдер без моделей не рисуется отдельной группой.
    expect(text).not.toContain('off')
  })

  it('compact-список не содержит моделей отключённого провайдера', async () => {
    const container = await mount(true)
    await openMenu(container)

    const text = document.body.textContent ?? ''
    expect(text).toContain('m-on')
    expect(text).not.toContain('m-off')
  })

  it('избранное и недавние не показывают отключённую пару', async () => {
    useProvidersStore.setState({ favorites: ['off:m-off'], recents: ['off:m-off'] })
    const container = await mount()
    await openMenu(container)

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('m-off')
  })

  it('локальный поиск не находит модель отключённого провайдера', async () => {
    const container = await mount()
    await openMenu(container)

    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'm-off')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('m-off')
  })

  it('выбранная отключённая пара остаётся в триггере (обычный и compact)', async () => {
    useProvidersStore.setState({ selectedProviderName: 'off', selectedModelName: 'm-off' })

    const normal = await mount()
    const normalTrigger = normal.querySelector('.model-selector-trigger') as HTMLElement
    expect(normalTrigger.textContent).toContain('m-off')

    const compact = await mount(true)
    const compactTrigger = compact.querySelector('.model-selector-trigger') as HTMLElement
    expect(compactTrigger.textContent).toContain('m-off')
  })
})
