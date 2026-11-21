/**
 * AgentModeSelector на телефоне.
 *
 * Симптом из баг-репорта: список агентов открывался только вверх и не помещался
 * (верхние пункты за краем экрана, внутреннего скролла нет, панель перекрывала
 * поле ввода). Теперь на мобильном список живёт в общем мобильном листе
 * (`MobileMenuSheet`) — панель растёт **вверх от кнопки** (зазор над кнопкой =
 * зазору под кнопкой), ширина — на всю ширину поля ввода, панель видна с первого
 * кадра и следит за кнопкой; переключение — по `pointerdown` с подавлением эха
 * `click` (иначе закрытие оборачивалось повторным открытием), триггер подсвечен.
 * На десктопе остаётся Radix-дропдаун.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
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

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getAgents: vi.fn(),
    updateSession: vi.fn(),
  },
}))

import { AgentModeSelector } from './AgentModeSelector'
import { SHEET_OPEN_QUARANTINE_MS } from '../ui/MobileMenuSheet'
import { useAgentsStore } from '@/stores/agentsStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

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

function makeAgent(id: string, display_name: string): AgentInfo {
  return {
    id,
    display_name,
    capabilities: [],
    enabled: true,
    icon: null,
    color: null,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: null,
    max_steps: null,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: true,
    is_overridden: false,
  }
}

const AGENTS: AgentInfo[] = [
  makeAgent('developer', 'Разработчик'),
  makeAgent('alistent', 'Алистент'),
  makeAgent('tester', 'Тестировщик'),
]

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

/** jsdom не считает layout: прямоугольник задаётся точечно на элементе. */
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

async function renderSelector(): Promise<{
  container: HTMLElement
  composer: HTMLElement
  trigger: HTMLElement
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <div className="chat-composer">
        <textarea data-testid="composer-input" />
        <div className="chat-toolbar">
          <AgentModeSelector sessionId="s1" />
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

beforeAll(() => {
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })
})

beforeEach(() => {
  device.type = 'phone'
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH })
  installFrames()
  vi.mocked(synthApi.updateSession).mockReset().mockResolvedValue({} as never)
  useAgentsStore.setState({
    agents: AGENTS,
    activeAgentId: 'developer',
    defaultAgentId: 'developer',
    loading: false,
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
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  vi.unstubAllGlobals()
})

describe('AgentModeSelector на телефоне: мобильный лист', () => {
  it('список рендерится в портале панелью с внутренним скроллом', async () => {
    const { container } = await renderSelector()
    expect(sheet()).toBeNull()

    await pressTrigger(container)

    const panel = sheet()!
    expect(panel).not.toBeNull()
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
    expect(panel.style.position).toBe('fixed')
    expect(panel.getAttribute('role')).toBe('menu')
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')
    expect(trigger(container).getAttribute('aria-haspopup')).toBe('menu')

    const scroll = panel.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    expect(scroll).not.toBeNull()
    expect(scroll.className).toContain('overflow-y-auto')
    // Весь список в DOM — при переполнении скроллится контейнер, а не обрезается.
    expect(scroll.textContent).toContain('Алистент')
    expect(scroll.textContent).toContain('Тестировщик')
  })

  it('панель растёт вверх от кнопки (зазор как под кнопкой) и на всю ширину композера', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)

    const panel = sheet()!
    expect(GAP_BELOW).toBe(8)
    expect(panelLow(panel)).toBe(TRIGGER_TOP - GAP_BELOW)
    expect(panel.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)
    // Низ панели выше верхней кромки кнопки (а не верха композера).
    expect(panelLow(panel)).toBeLessThan(TRIGGER_TOP)
    expect(panel.dataset.widthMode).toBe('composer')
    expect(panel.style.left).toBe(`${COMPOSER_LEFT + 8}px`)
    expect(panel.style.right).toBe(`${VIEWPORT_WIDTH - COMPOSER_RIGHT + 8}px`)
    const panelWidth = VIEWPORT_WIDTH - parseFloat(panel.style.left) - parseFloat(panel.style.right)
    expect(panelWidth).toBe(COMPOSER_WIDTH - 16)
    expect(panelLow(panel) - parseFloat(panel.style.maxHeight)).toBeGreaterThanOrEqual(0)
  })

  it('панель видна на первом кадре (без visibility: hidden)', async () => {
    const { container } = await renderSelector()
    await act(async () => {
      trigger(container).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    const panel = sheet()!
    expect(panel.dataset.revealed).toBe('true')
    expect(panel.style.visibility).toBe('')
    expect(panel.style.opacity).toBe('')
    expect(panelLow(panel)).toBe(TRIGGER_TOP - GAP_BELOW)
  })

  it('повторное нажатие закрывает список, подсветка триггера снимается', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)
    expect(sheet()).not.toBeNull()

    const button = trigger(container)
    expect(button.getAttribute('data-sheet-open')).toBe('true')
    expect(button.className).toContain('text-primary')

    await pressTrigger(container)
    expect(sheet()).toBeNull()
    expect(button.getAttribute('data-sheet-open')).toBeNull()
    expect(button.className).not.toContain('text-primary')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('клик по триггеру не даёт «моргания»: после закрытия панель не открывается', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)
    expect(sheet()).not.toBeNull()

    const button = trigger(container)
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

  it('клик без pointerdown (клавиатура/скринридер) переключает список', async () => {
    const { container } = await renderSelector()
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
    // Второй путь закрытия — тот же `closeMenu`, что и у остальных (сброс поиска).
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('blur на pointerdown снимает фокус до открытия, поиск не автофокусится', async () => {
    const { container } = await renderSelector()
    const textarea = container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement
    await act(async () => {
      textarea.focus()
    })
    expect(document.activeElement).toBe(textarea)

    const button = trigger(container)
    // До открытия панели фокус уже снят — клавиатура начнёт скрываться раньше.
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(document.activeElement).not.toBe(textarea)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushFrames(1)
    const search = sheet()!.querySelector('input[type="text"]') as HTMLInputElement
    expect(search).not.toBeNull()
    expect(document.activeElement).not.toBe(search)
  })

  it('выбор агента сохраняет его в сессию и закрывает панель', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)

    const item = Array.from(sheet()!.querySelectorAll('button[role="menuitem"]')).find((button) =>
      button.textContent?.includes('Алистент'),
    ) as HTMLButtonElement
    expect(item).toBeDefined()

    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(synthApi.updateSession).toHaveBeenCalledWith('s1', { settings: { agentRole: 'alistent' } })
    expect(useAgentsStore.getState().activeAgentId).toBe('alistent')
    expect(sheet()).toBeNull()
  })

  it('тап вне панели и Escape закрывают её', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)
    expect(sheet()).not.toBeNull()
    await expireOpenQuarantine()

    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
    })
    expect(sheet()).toBeNull()

    await pressTrigger(container)
    expect(sheet()).not.toBeNull()
    await expireOpenQuarantine()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(sheet()).toBeNull()
  })

  it('пока показывает панель, триггер остаётся подсвеченным (aria-expanded + маркер)', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)

    const button = trigger(container)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('data-sheet-open')).toBe('true')
    expect(button.className).toContain('bg-primary/10')
  })

  it('на десктопе остаётся прежний Radix-дропдаун', async () => {
    device.type = 'desktop'
    const { container } = await renderSelector()

    const button = trigger(container)
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    // Мобильной панели нет, меню рисует Radix.
    expect(sheet()).toBeNull()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('data-sheet-open')).toBeNull()
  })
})
