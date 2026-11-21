/**
 * ModelSelector: кнопка «сбросить на модель по умолчанию» в строке поиска.
 *
 * Требование владельца: строка поиска и кнопки в селекторах модели и агента
 * должны выглядеть одинаково; сброс на умолчание — кнопка-иконка в этой строке
 * (у агента она уже была пунктом списка и переехала в строку).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const api = vi.hoisted(() => ({
  getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
  getModelGroups: vi.fn(async () => ({ groups: [], page: { models: [], total: 0, offset: 0, limit: 500, next_offset: null } })),
  updateSession: vi.fn(async () => ({})),
}))

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ deviceType: 'desktop', isTouch: false }) }))
vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return { ...actual, synthApi: { ...actual.synthApi, ...api } }
})

if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {}
if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ModelSelector } from './ModelSelector'
import { useProvidersStore } from '@/stores/providersStore'
import type { ModelInfo } from '@/lib/api/synthApi'

const PROVIDER = { name: 'on', type: 'openai', icon: '', url: '', model: '', enabled: true }

function model(name: string, isDefault: boolean): ModelInfo {
  return { id: `on/${name}`, name, provider: 'on', enabled: true, isDefault }
}

const DEFAULT_MODEL = model('default-model', true)
const OTHER_MODEL = model('other-model', false)

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mountAndOpen(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<ModelSelector sessionId="s1" />)
  })
  await flush()
  const trigger = container.querySelector('.model-selector-trigger') as HTMLElement
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 560, width: 600, height: 560, toJSON: () => ({}) } as DOMRect
  }
  useProvidersStore.setState({
    providers: [PROVIDER],
    catalogModels: [DEFAULT_MODEL, OTHER_MODEL],
    catalogLoaded: true,
    catalogLoading: false,
    selectedProviderName: 'on',
    selectedModelName: 'other-model',
    loading: false,
    error: null,
    modelsError: null,
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

describe('ModelSelector: сброс на модель по умолчанию', () => {
  it('показывает кнопку, когда выбрана не дефолтная модель, и возвращает дефолтную', async () => {
    await mountAndOpen()

    const reset = document.querySelector('[data-testid="models-reset-default"]') as HTMLButtonElement | null
    expect(reset).not.toBeNull()

    await act(async () => {
      reset!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const state = useProvidersStore.getState()
    expect(state.selectedModelName).toBe(DEFAULT_MODEL.name)
    expect(state.selectedProviderName).toBe(DEFAULT_MODEL.provider)
    expect(api.updateSession).toHaveBeenCalledWith('s1', {
      settings: { provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.name },
    })
    // Сброс закрывает список (на мобильном панель иначе остаётся открытой).
    expect(document.querySelector('[data-radix-menu-content], [role="menu"]')).toBeNull()
  })

  it('не показывает кнопку, когда выбрана сама дефолтная модель', async () => {
    useProvidersStore.setState({ selectedModelName: DEFAULT_MODEL.name })
    await mountAndOpen()

    expect(document.querySelector('[data-testid="models-reset-default"]')).toBeNull()
  })

  it('строка поиска содержит кнопки обновить/свернуть в той же оболочке, что у агента', async () => {
    await mountAndOpen()

    expect(document.querySelector('[data-testid="models-refresh"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="models-collapse-toggle"]')).not.toBeNull()
    // Поле поиска и группа действий — один флекс-ряд (общий `SelectorSearchRow`).
    const input = document.querySelector('[data-radix-menu-content] input, [role="menu"] input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    const row = input!.closest('.flex.items-center.gap-1')
    expect(row?.querySelector('[data-testid="models-refresh"]')).not.toBeNull()
  })
})
