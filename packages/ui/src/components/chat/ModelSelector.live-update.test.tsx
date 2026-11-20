import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * Селект модели чата и событие шины `models.updated`.
 *
 * Баг: «модель, добавленная в другом клиенте (или тулом из чата), не появляется
 * в дропдауне модели, пока не перезагрузишь страницу». Причина — полный каталог
 * для селектора грузится лениво **один раз** (guard `catalogLoaded` в сторе),
 * а `ModelSelector` запрашивал его только при первом открытии дропдауна.
 */
const apiMock = vi.hoisted(() => ({
  getModelGroups: vi.fn(),
  getProviders: vi.fn(),
  getModels: vi.fn(async () => []),
  updatePreferences: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: apiMock,
  mergeModelGroups: (
    prev: Array<{ provider: { name: string }; models: Array<{ id: string }> }>,
    next: Array<{ provider: { name: string }; models: Array<{ id: string }> }>,
  ) => {
    const byName = new Map(prev.map((g) => [g.provider.name, { ...g, models: [...g.models] }]))
    for (const g of next) {
      const current = byName.get(g.provider.name)
      if (!current) {
        byName.set(g.provider.name, { provider: g.provider, models: [...g.models] })
        continue
      }
      const known = new Set(current.models.map((m) => m.id))
      for (const m of g.models) {
        if (known.has(m.id)) continue
        known.add(m.id)
        current.models.push(m)
      }
    }
    return [...byName.values()]
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ModelSelector } from './ModelSelector'
import { useProvidersStore } from '@/stores/providersStore'
import type { ModelInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function model(id: string, name: string): ModelInfo {
  return { id, name, provider: 'itphx', enabled: true, isDefault: false }
}

function page(models: ModelInfo[]) {
  return {
    groups: models.length > 0
      ? [{
          provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '' },
          models,
        }]
      : [],
    page: { models, total: models.length, offset: 0, limit: 500, next_offset: null },
  }
}

async function renderSelector(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelSelector compact />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getProviders.mockResolvedValue({
    providers: [{ name: 'itphx', type: 'openai', icon: '', url: '', model: '', enabled: true }],
    default_provider: 'itphx',
  })
  apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')]))
  useProvidersStore.setState({
    providers: [],
    modelGroups: [],
    models: [],
    catalogModels: [],
    catalogLoading: false,
    catalogLoaded: false,
    modelsLoading: false,
    modelsError: null,
    loading: false,
    error: null,
    selectedProviderName: null,
    selectedModelName: null,
    favorites: [],
    recents: [],
    revision: 0,
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
  vi.clearAllMocks()
})

describe('ModelSelector — живое обновление каталога', () => {
  it('событие models.updated делает новую модель видимой в дропдауне', async () => {
    const container = await renderSelector()

    // Первое открытие дропдауна — ленивая загрузка каталога.
    const trigger = container.querySelector('.model-selector-trigger') as HTMLElement
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await act(async () => {})
    await vi.waitFor(() => {
      expect(useProvidersStore.getState().catalogLoaded).toBe(true)
    })
    const openMenu = document.body.textContent ?? ''
    expect(openMenu).toContain('m1')

    // Модель добавили в другом клиенте — шина подняла событие.
    apiMock.getModelGroups.mockResolvedValue(
      page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2')]),
    )
    await act(async () => {
      useProvidersStore.getState().applyEvent()
    })
    await act(async () => {})

    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('m2')
    })
  })

  it('событие до открытия дропдауна не тянет каталог заранее', async () => {
    await renderSelector()

    await act(async () => {
      useProvidersStore.getState().applyEvent()
    })
    await act(async () => {})

    expect(useProvidersStore.getState().revision).toBe(1)
    expect(apiMock.getModelGroups).not.toHaveBeenCalled()
    expect(useProvidersStore.getState().catalogLoaded).toBe(false)
  })
})
