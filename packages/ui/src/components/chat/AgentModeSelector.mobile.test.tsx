/**
 * AgentModeSelector на телефоне.
 *
 * Симптом из баг-репорта: список агентов открывался только вверх и не помещался
 * (верхние пункты за краем экрана, внутреннего скролла нет, панель перекрывала
 * поле ввода). Теперь на мобильном список живёт в общей фиксированной панели,
 * прижатой к верху композера; на десктопе остаётся Radix-дропдаун.
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
import { useAgentsStore } from '@/stores/agentsStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT_HEIGHT = 800
const COMPOSER_TOP = 600

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
const roots: Array<{ root: Root; container: HTMLElement }> = []

/** jsdom не считает layout: прямоугольник композера задаётся точечно. */
function stubComposerRect(composer: HTMLElement, top: number): void {
  composer.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 400,
      bottom: top + 120,
      width: 400,
      height: 120,
      toJSON: () => ({}),
    }) as DOMRect
}

async function renderSelector(): Promise<{ container: HTMLElement; composer: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <div className="chat-composer">
        <textarea data-testid="composer-input" />
        <AgentModeSelector sessionId="s1" />
      </div>,
    )
  })
  const composer = container.querySelector('.chat-composer') as HTMLElement
  stubComposerRect(composer, COMPOSER_TOP)
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
  // На мобильном открытие идёт по click, blur — по pointerdown (как на устройстве).
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeAll(() => {
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })
})

beforeEach(() => {
  device.type = 'phone'
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
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
})

describe('AgentModeSelector на телефоне: фиксированная панель', () => {
  it('список рендерится в портале фиксированной панелью с внутренним скроллом', async () => {
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

  it('панель прижата к верху композера и не выходит за экран', async () => {
    const { container } = await renderSelector()
    await pressTrigger(container)

    const panel = sheet()!
    expect(panel.style.bottom).toBe(`${VIEWPORT_HEIGHT - COMPOSER_TOP}px`)
    expect(panel.style.left).toBe('8px')
    expect(panel.style.right).toBe('8px')
    const top = VIEWPORT_HEIGHT - parseFloat(panel.style.bottom) - parseFloat(panel.style.maxHeight)
    expect(top).toBeGreaterThanOrEqual(0)
    // Панель не перекрывает поле ввода: её низ = верх композера.
    expect(VIEWPORT_HEIGHT - parseFloat(panel.style.bottom)).toBe(COMPOSER_TOP)
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
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(document.activeElement).not.toBe(textarea)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
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

    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(sheet()).toBeNull()

    await pressTrigger(container)
    expect(sheet()).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(sheet()).toBeNull()
  })

  it('на десктопе остаётся прежний Radix-дропдаун', async () => {
    device.type = 'desktop'
    const { container } = await renderSelector()

    const button = trigger(container)
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    // Мобильной панели нет, меню рисует Radix.
    expect(sheet()).toBeNull()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
})
