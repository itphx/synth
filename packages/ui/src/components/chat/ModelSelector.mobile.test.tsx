/**
 * ModelSelector на телефоне.
 *
 * Симптом из баг-репорта: при открытой экранной клавиатуре панель списка моделей
 * накрывала поле ввода, а при клике по кнопке тулбара клавиатура скрывалась уже
 * после расчёта позиции — панель «прыгала» под палец. Теперь на мобильном список
 * живёт в общей фиксированной панели с верхней границей по композеру, фокус
 * снимается до открытия, а на десктопе остаётся прежний Radix-дропдаун с
 * виртуализацией.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// jsdom не даёт matchMedia → useDevice вернул бы desktop; зоной управляем вручную.
const device = vi.hoisted(() => ({ type: 'phone' as 'desktop' | 'phone' | 'tablet' }))

vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: device.type, isTouch: device.type !== 'desktop' }),
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const api = vi.hoisted(() => ({
  getProviders: vi.fn(async () => ({
    providers: [{ name: 'on', type: 'openai', icon: '', url: '', model: '', enabled: true }],
    default_provider: 'on',
  })),
  getModelGroups: vi.fn(async () => ({ groups: [], page: { models: [], total: 0, offset: 0, limit: 500, next_offset: null } })),
  updateSession: vi.fn(async () => ({})),
  updatePreferences: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: api }))

import { ModelSelector } from './ModelSelector'
import { useProvidersStore } from '@/stores/providersStore'
import type { ModelInfo, ProviderInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT_HEIGHT = 800
const COMPOSER_TOP = 600

const PROVIDERS: ProviderInfo[] = [
  { name: 'on', type: 'openai', icon: '', url: '', model: '', enabled: true },
]

function model(name: string): ModelInfo {
  return { id: `on/${name}`, name, provider: 'on', enabled: true, isDefault: false }
}

const MODELS: ModelInfo[] = [model('alpha-model'), model('beta-model')]

// jsdom не считает layout: виртуализатору нужны размеры скролл-контейнера.
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

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
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Композер с полем ввода: его верх — нижняя граница панели. */
async function mount(): Promise<{ container: HTMLElement; composer: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <div className="chat-composer">
        <textarea data-testid="composer-input" />
        <ModelSelector />
      </div>,
    )
  })
  await flush()
  const composer = container.querySelector('.chat-composer') as HTMLElement
  composer.getBoundingClientRect = () =>
    ({
      x: 0, y: COMPOSER_TOP, top: COMPOSER_TOP, left: 0, right: 400,
      bottom: COMPOSER_TOP + 120, width: 400, height: 120, toJSON: () => ({}),
    }) as DOMRect
  return { container, composer }
}

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('.model-selector-trigger') as HTMLButtonElement
}

function sheet(): HTMLElement | null {
  return document.body.querySelector('[data-testid="mobile-menu-sheet"]')
}

async function pressTrigger(container: HTMLElement): Promise<void> {
  const button = trigger(container)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  device.type = 'phone'
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  mockLayout()
  api.updateSession.mockClear()
  useProvidersStore.setState({
    providers: PROVIDERS,
    models: [],
    catalogModels: MODELS,
    catalogLoaded: true,
    catalogLoading: false,
    modelsError: null,
    modelGroups: [],
    favorites: [],
    recents: [],
    loading: false,
    error: null,
    selectedProviderName: 'on',
    selectedModelName: 'alpha-model',
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
  restoreLayout()
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  document.body.innerHTML = ''
})

describe('ModelSelector на телефоне: фиксированная панель', () => {
  it('список моделей рендерится в портале панелью со скролл-контейнером и виртуализацией', async () => {
    const { container } = await mount()
    expect(sheet()).toBeNull()

    await pressTrigger(container)

    const panel = sheet()!
    expect(panel).not.toBeNull()
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
    expect(panel.style.position).toBe('fixed')
    expect(panel.getAttribute('role')).toBe('menu')
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')

    const scroll = panel.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    expect(scroll).not.toBeNull()
    expect(scroll.className).toContain('overflow-y-auto')
    // Виртуализатор получил именно контейнер панели: строки отрисованы.
    expect(scroll.textContent).toContain('alpha-model')
    expect(scroll.textContent).toContain('beta-model')
  })

  it('панель прижата к верху композера и не выходит за экран', async () => {
    const { container } = await mount()
    await pressTrigger(container)

    const panel = sheet()!
    expect(panel.style.bottom).toBe(`${VIEWPORT_HEIGHT - COMPOSER_TOP}px`)
    // Максимальная высота — всё место над композером (600 - 2*8).
    expect(panel.style.maxHeight).toBe(`${COMPOSER_TOP - 2 * 8}px`)
    expect(panel.style.left).toBe('8px')
    expect(panel.style.right).toBe('8px')
    // Верх панели внутри экрана, низ — ровно на верхе композера.
    expect(VIEWPORT_HEIGHT - parseFloat(panel.style.bottom)).toBe(COMPOSER_TOP)
    expect(VIEWPORT_HEIGHT - parseFloat(panel.style.bottom) - parseFloat(panel.style.maxHeight)).toBeGreaterThanOrEqual(0)
  })

  it('blur на pointerdown снимает фокус до открытия, поиск не автофокусится', async () => {
    const { container } = await mount()
    const textarea = container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement
    await act(async () => {
      textarea.focus()
    })
    expect(document.activeElement).toBe(textarea)

    const button = trigger(container)
    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    // Клавиатура начинает скрываться ещё до открытия панели.
    expect(document.activeElement).not.toBe(textarea)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const search = sheet()!.querySelector('input[type="text"]') as HTMLInputElement
    expect(search).not.toBeNull()
    expect(document.activeElement).not.toBe(search)
  })

  it('выбор модели сохраняет пару и закрывает панель', async () => {
    const { container } = await mount()
    await pressTrigger(container)

    const row = Array.from(sheet()!.querySelectorAll('span')).find(
      (element) => element.textContent === 'beta-model',
    )
    expect(row).toBeDefined()
    await act(async () => {
      row!.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useProvidersStore.getState().selectedModelName).toBe('beta-model')
    expect(sheet()).toBeNull()
  })

  it('Escape и тап вне панели закрывают её', async () => {
    const { container } = await mount()
    await pressTrigger(container)
    expect(sheet()).not.toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(sheet()).toBeNull()

    await pressTrigger(container)
    expect(sheet()).not.toBeNull()
    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    await flush()
    expect(sheet()).toBeNull()
  })

  it('при открытой клавиатуре ждёт стабилизации layout, затем пункты доступны', async () => {
    // Клавиатура открыта: видимая область сжата, layout-окно высокое, композер
    // поднят клавиатурой. Панель не должна показываться в этой позиции.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const viewport = Object.assign(new EventTarget(), { height: 500 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })

    const { container, composer } = await mount()
    composer.getBoundingClientRect = () =>
      ({
        x: 0, y: 400, top: 400, left: 0, right: 400,
        bottom: 520, width: 400, height: 120, toJSON: () => ({}),
      }) as DOMRect
    await pressTrigger(container)

    const waiting = sheet()!
    expect(waiting.dataset.revealed).toBe('false')
    expect(waiting.style.visibility).toBe('hidden')
    expect(waiting.style.pointerEvents).toBe('none')
    // Скрытие — `visibility`, а не `display: none`: виртуализатор уже отрисовал строки.
    expect(waiting.textContent).toContain('alpha-model')

    // Клавиатура закрылась, композер опустился — панель проявляется по новому месту.
    composer.getBoundingClientRect = () =>
      ({
        x: 0, y: 700, top: 700, left: 0, right: 400,
        bottom: 820, width: 400, height: 120, toJSON: () => ({}),
      }) as DOMRect
    viewport.height = 900
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
    })
    await flush()

    const revealed = sheet()!
    expect(revealed.dataset.revealed).toBe('true')
    expect(revealed.style.visibility).toBe('visible')
    expect(revealed.style.bottom).toBe('200px')

    // Пункт выбирается — после показа панель интерактивна.
    const row = Array.from(revealed.querySelectorAll('span')).find(
      (element) => element.textContent === 'beta-model',
    )
    expect(row).toBeDefined()
    await act(async () => {
      row!.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useProvidersStore.getState().selectedModelName).toBe('beta-model')
  })

  it('на десктопе остаётся прежний Radix-дропдаун', async () => {
    device.type = 'desktop'
    const { container } = await mount()

    await act(async () => {
      trigger(container).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(sheet()).toBeNull()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')
  })
})
