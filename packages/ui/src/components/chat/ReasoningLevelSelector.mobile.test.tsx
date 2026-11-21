/**
 * ReasoningLevelSelector на телефоне.
 *
 * Раньше это был Radix-поппер `side="top"`, и на мобильном он вёл себя плохо:
 * при открытой клавиатуре тап по кнопке скрывал её, поле ввода уезжало вниз, а
 * список «повисал посреди экрана». Теперь мобильная ветка идёт через **тот же**
 * мобильный лист (`MobileMenuSheet`), что модель и агент, но в компактном режиме
 * ширины: `widthMode="content"` — по содержимому (минимум 140px) с выравниванием
 * по правому краю кнопки, как у прежнего поппера, а не на всю ширину композера.
 * Панель растёт вверх от кнопки (зазор над кнопкой = зазору под кнопкой),
 * переключается по `pointerdown` (без «моргания» от эха `click`), триггер
 * подсвечен. Десктопная ветка остаётся прежним поппером.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const device = vi.hoisted(() => ({ type: 'phone' as 'desktop' | 'phone' | 'tablet' }))

vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: device.type, isTouch: device.type !== 'desktop' }),
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { updateSession: vi.fn(async () => ({ id: 's1', settings: {} })) },
}))

import { ReasoningLevelSelector } from './ReasoningLevelSelector'
import { SHEET_OPEN_QUARANTINE_MS } from '../ui/MobileMenuSheet'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { synthApi } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Как на живом стенде: телефон 412×915. */
const VIEWPORT_WIDTH = 412
const VIEWPORT_HEIGHT = 915
const COMPOSER_TOP = 700
const COMPOSER_LEFT = 12
const COMPOSER_RIGHT = 400
const COMPOSER_WIDTH = COMPOSER_RIGHT - COMPOSER_LEFT
const COMPOSER_HEIGHT = 56
/** Рамка кнопки размышлений в тулбаре (правая часть) — якорь панели. */
const FRAME_TOP = 720
const FRAME_LEFT = 250
const FRAME_RIGHT = 282
const FRAME_HEIGHT = 28
/** Зазор под кнопкой внутри композера: 756 − 748 = 8px. */
const GAP_BELOW = COMPOSER_TOP + COMPOSER_HEIGHT - (FRAME_TOP + FRAME_HEIGHT)

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
const roots: Array<{ root: Root; container: HTMLElement }> = []

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

async function renderSelector(): Promise<{ container: HTMLElement; trigger: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <div className="chat-composer">
        <div className="chat-toolbar">
          <ReasoningLevelSelector sessionId="s1" />
        </div>
      </div>,
    )
  })
  const composer = container.querySelector('.chat-composer') as HTMLElement
  stubRect(composer, {
    top: COMPOSER_TOP,
    left: COMPOSER_LEFT,
    right: COMPOSER_RIGHT,
    height: COMPOSER_HEIGHT,
  })
  const button = trigger(container)
  // Панель встаёт над РАМКОЙ кнопки (как поппер), поэтому рамку тоже замеряем.
  stubRect(button.parentElement as HTMLElement, {
    top: FRAME_TOP,
    left: FRAME_LEFT,
    right: FRAME_RIGHT,
    height: FRAME_HEIGHT,
  })
  return { container, trigger: button }
}

function trigger(container: HTMLElement): HTMLElement {
  return container.querySelector('button[aria-haspopup="menu"]') as HTMLElement
}

function sheet(): HTMLElement | null {
  return document.body.querySelector('[data-testid="mobile-menu-sheet"]')
}

/** Тап по кнопке как на устройстве: `pointerdown` (браузер добавит и `click`). */
async function pressTrigger(trigger: HTMLElement): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
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
  await flushFrames(1)
}

function panelLow(sheet: HTMLElement): number {
  return VIEWPORT_HEIGHT - parseFloat(sheet.style.bottom)
}

beforeEach(() => {
  device.type = 'phone'
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH })
  installFrames()
  vi.mocked(synthApi.updateSession).mockClear()
  useProvidersStore.setState({
    providers: [{ name: 'on', type: 'openai', icon: '', url: '', model: '', enabled: true }],
    selectedProviderName: 'on',
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'Сессия', settings: {} } as never],
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
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth)
  vi.unstubAllGlobals()
})

describe('ReasoningLevelSelector на телефоне: мобильный лист', () => {
  it('открывается мобильным листом над кнопкой, компактным по правому краю кнопки', async () => {
    const { trigger: button } = await renderSelector()
    expect(sheet()).toBeNull()

    await pressTrigger(button)

    const panel = sheet()!
    expect(panel).not.toBeNull()
    expect(panel.parentElement).toBe(document.body)
    expect(panel.style.position).toBe('fixed')
    expect(panel.getAttribute('role')).toBe('menu')
    // Режим ширины — по содержимому, как у прежнего компактного поппера.
    expect(panel.dataset.widthMode).toBe('content')
    // Низ панели = верх рамки кнопки − зазор под кнопкой (8px).
    expect(GAP_BELOW).toBe(8)
    expect(panelLow(panel)).toBe(FRAME_TOP - GAP_BELOW)
    expect(panel.style.bottom).toBe(`${VIEWPORT_HEIGHT - (FRAME_TOP - GAP_BELOW)}px`)
    // Правый край панели — по правому краю кнопки (412 − 282 = 130).
    expect(panel.style.right).toBe(`${VIEWPORT_WIDTH - FRAME_RIGHT}px`)
    expect(panel.style.left).toBe('')
    // Минимум 140px, потолок — не шире композера − 16px.
    expect(parseFloat(panel.style.minWidth)).toBe(140)
    expect(parseFloat(panel.style.maxWidth)).toBeLessThanOrEqual(COMPOSER_WIDTH - 16)
    expect(parseFloat(panel.style.maxWidth)).toBe(VIEWPORT_WIDTH - (VIEWPORT_WIDTH - FRAME_RIGHT) - 8)
    // Все уровни провайдера в списке.
    expect(panel.textContent).toContain('chat.reasoning.high')
    expect(panel.textContent).toContain('chat.reasoning.none')
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('панель видна на первом кадре (без visibility: hidden)', async () => {
    const { trigger: button } = await renderSelector()
    // Открываем только pointerdown — кадры не прогоняем.
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    const panel = sheet()!
    expect(panel.dataset.revealed).toBe('true')
    expect(panel.style.visibility).toBe('')
    expect(panel.style.opacity).toBe('')
    expect(panelLow(panel)).toBe(FRAME_TOP - GAP_BELOW)
  })

  it('повторное нажатие закрывает список, подсветка снимается', async () => {
    const { trigger: button } = await renderSelector()
    await pressTrigger(button)
    expect(sheet()).not.toBeNull()
    expect(button.getAttribute('data-sheet-open')).toBe('true')
    expect(button.className).toContain('text-primary')

    await pressTrigger(button)
    expect(sheet()).toBeNull()
    expect(button.getAttribute('data-sheet-open')).toBeNull()
    expect(button.className).not.toContain('text-primary')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('клик по триггеру не даёт «моргания»: после закрытия панель не открывается', async () => {
    const { trigger: button } = await renderSelector()
    await pressTrigger(button)
    expect(sheet()).not.toBeNull()

    // pointerdown закрывает, а следом пришедший `click` (тот же тап) — эхо,
    // его подавляем, иначе список открылся бы заново.
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
    const { trigger: button } = await renderSelector()
    await pressTrigger(button)
    expect(sheet()).not.toBeNull()
    await expireOpenQuarantine()

    // Якорь у размышлений — рамка вокруг кнопки, а backdrop лежит поверх неё:
    // тап по центру кнопки приходит в backdrop и трактуется как тап по триггеру.
    const rect = (button.parentElement as HTMLElement).getBoundingClientRect()
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

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sheet()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('клик без pointerdown (клавиатура/скринридер) переключает список', async () => {
    const { trigger: button } = await renderSelector()

    // `Enter`/`Space` на кнопке дают click без pointerdown — toggle-фолбэк.
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

  it('выбор уровня записывает его в сессию и закрывает список', async () => {
    const { trigger: button } = await renderSelector()
    await pressTrigger(button)

    const item = Array.from(sheet()!.querySelectorAll('button[role="menuitem"]')).find((element) =>
      element.textContent?.includes('chat.reasoning.high'),
    ) as HTMLButtonElement
    expect(item).toBeDefined()

    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(synthApi.updateSession).toHaveBeenCalledWith('s1', {
      settings: { reasoningLevel: 'high' },
    })
    expect(sheet()).toBeNull()
  })

  it('выбор текущего уровня просто закрывает список, без записи', async () => {
    const { trigger: button } = await renderSelector()
    await pressTrigger(button)

    const item = Array.from(sheet()!.querySelectorAll('button[role="menuitem"]')).find((element) =>
      element.textContent?.includes('chat.reasoning.default'),
    ) as HTMLButtonElement
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(synthApi.updateSession).not.toHaveBeenCalled()
    expect(sheet()).toBeNull()
  })

  it('тап вне панели и Escape закрывают список', async () => {
    const { trigger: button } = await renderSelector()
    await pressTrigger(button)
    expect(sheet()).not.toBeNull()
    await expireOpenQuarantine()

    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
    })
    expect(sheet()).toBeNull()

    await pressTrigger(button)
    expect(sheet()).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(sheet()).toBeNull()
  })

  it('на десктопе остаётся прежний поппер side="top"', async () => {
    device.type = 'desktop'
    const { trigger: button } = await renderSelector()

    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await flushFrames(1)

    expect(sheet()).toBeNull()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('data-sheet-open')).toBeNull()
  })
})
