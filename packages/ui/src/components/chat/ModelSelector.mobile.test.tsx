/**
 * ModelSelector на телефоне.
 *
 * Симптом из баг-репорта: при открытой экранной клавиатуре панель списка моделей
 * накрывала поле ввода, а при клике по кнопке тулбара клавиатура скрывалась уже
 * после расчёта позиции — панель «прыгала» под палец. Теперь на мобильном список
 * живёт в общем мобильном листе (`MobileMenuSheet`): панель растёт **вверх от
 * кнопки** (зазор над кнопкой = зазору под кнопкой), ширина — на всю ширину поля
 * ввода, фокус снимается до открытия, панель видна с первого кадра и следит за
 * кнопкой, пока композер едет; переключение — по `pointerdown` (эхо `click`
 * подавлено, иначе после закрытия панель открывалась заново — «моргание»),
 * триггер подсвечен. На десктопе — прежний Radix-дропдаун с виртуализацией.
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
import { SHEET_OPEN_QUARANTINE_MS } from '../ui/MobileMenuSheet'
import { useProvidersStore } from '@/stores/providersStore'
import type { ModelInfo, ProviderInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Как на живом стенде: телефон 412×915. */
const VIEWPORT_WIDTH = 412
const VIEWPORT_HEIGHT = 915
const COMPOSER_TOP = 700
const COMPOSER_LEFT = 12
const COMPOSER_RIGHT = 400
const COMPOSER_WIDTH = COMPOSER_RIGHT - COMPOSER_LEFT
const COMPOSER_HEIGHT = 76
/** Кнопка в тулбаре — от её верха отсчитывается низ панели. */
const TRIGGER_TOP = 740
const TRIGGER_HEIGHT = 28
/** Зазор под кнопкой внутри композера: 776 − 768 = 8px. */
const GAP_BELOW = COMPOSER_TOP + COMPOSER_HEIGHT - (TRIGGER_TOP + TRIGGER_HEIGHT)

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
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')

/** Кадры под ручным управлением: слежение за кнопкой после открытия. */
let rafSeq = 0
let rafQueue = new Map<number, FrameRequestCallback>()

function installFrames(): void {
  rafSeq = 0
  rafQueue = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++rafSeq
    rafQueue.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id)
  })
}

async function flushFrames(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const pending = Array.from(rafQueue.values())
    rafQueue.clear()
    await act(async () => {
      for (const callback of pending) callback(0)
    })
  }
}

interface StubRect {
  top: number
  left?: number
  right?: number
  height?: number
}

function stubRect(element: HTMLElement, rect: StubRect): void {
  const left = rect.left ?? 0
  const right = rect.right ?? 400
  const height = rect.height ?? 120
  element.getBoundingClientRect = () =>
    ({
      x: left,
      y: rect.top,
      top: rect.top,
      left,
      right,
      bottom: rect.top + height,
      width: right - left,
      height,
      toJSON: () => ({}),
    }) as DOMRect
}

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
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth)
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/**
 * Композер с полем ввода и кнопкой модели. Кнопка — якорь панели: её верх
 * задаёт низ панели, композер — ширину и зазор.
 */
async function mount(): Promise<{ container: HTMLElement; composer: HTMLElement; trigger: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <div className="chat-composer">
        <textarea data-testid="composer-input" />
        <div className="chat-toolbar">
          <ModelSelector />
        </div>
      </div>,
    )
  })
  await flush()
  const composer = container.querySelector('.chat-composer') as HTMLElement
  stubRect(composer, {
    top: COMPOSER_TOP,
    left: COMPOSER_LEFT,
    right: COMPOSER_RIGHT,
    height: COMPOSER_HEIGHT,
  })
  stubRect(trigger(container), {
    top: TRIGGER_TOP,
    left: COMPOSER_LEFT + 8,
    right: COMPOSER_LEFT + 40,
    height: TRIGGER_HEIGHT,
  })
  return { container, composer, trigger: trigger(container) }
}

function trigger(container: HTMLElement): HTMLElement {
  return container.querySelector('.model-selector-trigger') as HTMLElement
}

function sheet(): HTMLElement | null {
  return document.body.querySelector('[data-testid="mobile-menu-sheet"]')
}

function panelLow(panel: HTMLElement): number {
  return VIEWPORT_HEIGHT - parseFloat(panel.style.bottom)
}

/** Тап по кнопке как на устройстве: pointerdown, затем парный click. */
async function pressTrigger(container: HTMLElement): Promise<void> {
  const button = trigger(container)
  await act(async () => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
  await flushFrames(1)
}

/**
 * Переждать карантин открытия.
 *
 * Первые `SHEET_OPEN_QUARANTINE_MS` после открытия панель не закрывается от
 * тапа (защита от дребезга `pointerdown/click` после скрытия клавиатуры на
 * Android), поэтому тесты, которые закрывают панель тапом, ждут этот срок.
 */
async function expireOpenQuarantine(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SHEET_OPEN_QUARANTINE_MS + 40))
  })
  await flush()
  await flushFrames(1)
}

beforeEach(() => {
  device.type = 'phone'
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH })
  mockLayout()
  installFrames()
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
  vi.unstubAllGlobals()
})

describe('ModelSelector на телефоне: мобильный лист', () => {
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

  it('панель растёт вверх от кнопки (зазор как под кнопкой) и на всю ширину композера', async () => {
    const { container } = await mount()
    await pressTrigger(container)

    const panel = sheet()!
    // Низ панели = верх кнопки − зазор под кнопкой (8px), а не верх композера.
    expect(GAP_BELOW).toBe(8)
    expect(panelLow(panel)).toBe(TRIGGER_TOP - GAP_BELOW)
    expect(panel.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)
    // Максимальная высота — всё место от кнопки до safe-area-верха.
    expect(panel.style.maxHeight).toBe(`${TRIGGER_TOP - GAP_BELOW - 8}px`)
    expect(panelLow(panel) - parseFloat(panel.style.maxHeight)).toBeGreaterThanOrEqual(0)
    // Ширина — уже композера ровно на 2×8px, режим по умолчанию.
    expect(panel.dataset.widthMode).toBe('composer')
    expect(panel.style.left).toBe(`${COMPOSER_LEFT + 8}px`)
    expect(panel.style.right).toBe(`${VIEWPORT_WIDTH - COMPOSER_RIGHT + 8}px`)
    const panelWidth = VIEWPORT_WIDTH - parseFloat(panel.style.left) - parseFloat(panel.style.right)
    expect(panelWidth).toBe(COMPOSER_WIDTH - 16)
    expect(panel.style.minWidth).toBe('')
    expect(panel.style.maxWidth).toBe('')
  })

  it('панель видна на первом кадре (без visibility: hidden)', async () => {
    const { container } = await mount()
    // Открываем только pointerdown — кадры не прогоняем.
    await act(async () => {
      trigger(container).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    const panel = sheet()!
    expect(panel.dataset.revealed).toBe('true')
    expect(panel.style.visibility).toBe('')
    expect(panel.style.opacity).toBe('')
    expect(panel.style.pointerEvents).toBe('')
    expect(panelLow(panel)).toBe(TRIGGER_TOP - GAP_BELOW)
  })

  it('повторное нажатие закрывает список, подсветка триггера снимается', async () => {
    const { container } = await mount()
    await pressTrigger(container)
    expect(sheet()).not.toBeNull()

    const button = trigger(container)
    // Подсветка открытого триггера: маркер + класс в стиле проекта.
    expect(button.getAttribute('data-sheet-open')).toBe('true')
    expect(button.className).toContain('text-primary')

    await pressTrigger(container)
    expect(sheet()).toBeNull()
    expect(button.getAttribute('data-sheet-open')).toBeNull()
    expect(button.className).not.toContain('text-primary')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('клик по триггеру не даёт «моргания»: после закрытия панель не открывается', async () => {
    const { container } = await mount()
    await pressTrigger(container)
    expect(sheet()).not.toBeNull()

    const button = trigger(container)
    // pointerdown закрывает, следом приходит «эхо»-click того же тапа — он
    // подавлен, иначе список открылся бы снова (моргание на Android).
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(sheet()).toBeNull()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sheet()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('тап по кнопке при открытой панели закрывает список и не открывает заново', async () => {
    const { container } = await mount()
    await pressTrigger(container)
    const panel = sheet()!
    expect(panel).not.toBeNull()
    await expireOpenQuarantine()

    // Backdrop лежит поверх кнопки: тап по её прямоугольнику приходит в него.
    const button = trigger(container)
    const rect = button.getBoundingClientRect()
    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      )
    })
    expect(sheet()).toBeNull()

    // Парный click того же тапа прилетает уже по кнопке — он подавлен.
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sheet()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('клик без pointerdown (клавиатура/скринридер) переключает список', async () => {
    const { container } = await mount()
    const button = trigger(container)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sheet()).not.toBeNull()
    await flushFrames(1)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sheet()).toBeNull()
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
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    // Клавиатура начинает скрываться ещё до открытия панели.
    expect(document.activeElement).not.toBe(textarea)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    await flushFrames(1)
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
    await expireOpenQuarantine()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(sheet()).toBeNull()

    await pressTrigger(container)
    expect(sheet()).not.toBeNull()
    await expireOpenQuarantine()
    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
    })
    await flush()
    expect(sheet()).toBeNull()
  })

  it('при поднятой клавиатуре панель видна сразу и следит за кнопкой', async () => {
    // Клавиатура открыта: видимая область сжата, композер поднят клавиатурой.
    const viewport = Object.assign(new EventTarget(), { height: 500 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })

    const { container, composer } = await mount()
    const button = trigger(container)
    stubRect(composer, {
      top: 400,
      left: COMPOSER_LEFT,
      right: COMPOSER_RIGHT,
      height: COMPOSER_HEIGHT,
    })
    stubRect(button, {
      top: 440,
      left: COMPOSER_LEFT + 8,
      right: COMPOSER_LEFT + 40,
      height: TRIGGER_HEIGHT,
    })

    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    // Ожидания «стабилизации layout» больше нет: панель видна сразу (первый
    // кадр), а не скрыта до страховочного таймаута.
    const opened = sheet()!
    expect(opened.dataset.revealed).toBe('true')
    expect(opened.style.visibility).toBe('')
    expect(opened.textContent).toContain('alpha-model')
    expect(panelLow(opened)).toBe(440 - GAP_BELOW)

    // Клавиатура закрылась, композер опустился — панель следит за кнопкой.
    stubRect(composer, {
      top: COMPOSER_TOP,
      left: COMPOSER_LEFT,
      right: COMPOSER_RIGHT,
      height: COMPOSER_HEIGHT,
    })
    stubRect(button, {
      top: TRIGGER_TOP,
      left: COMPOSER_LEFT + 8,
      right: COMPOSER_LEFT + 40,
      height: TRIGGER_HEIGHT,
    })
    viewport.height = VIEWPORT_HEIGHT
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
    })
    await flushFrames(2)

    const moved = sheet()!
    expect(moved.dataset.revealed).toBe('true')
    expect(panelLow(moved)).toBe(TRIGGER_TOP - GAP_BELOW)

    // Пункт выбирается — панель интерактивна всё это время.
    const row = Array.from(moved.querySelectorAll('span')).find(
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
      trigger(container).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(sheet()).toBeNull()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')
    // Подсветка открытого листа — только в мобильной ветке.
    expect(trigger(container).getAttribute('data-sheet-open')).toBeNull()
  })
})
