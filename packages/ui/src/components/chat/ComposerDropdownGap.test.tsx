/**
 * Десктопные дропдауны композера: `sideOffset` = зазор под кнопкой.
 *
 * Замечание владельца: на десктопе у списков модели и агента (`side="top"`)
 * интервала между кнопкой тулбара и панелью не было — `sideOffset={4}` жёстко,
 * а от низа кнопки до низа `.chat-composer` на живом замере 14px. Теперь
 * десктопные ветки берут **тот же** зазор, что и мобильный лист
 * (`measureTriggerGap`: `composer.bottom − anchor.bottom`, clamp 4…16px), через
 * `useTriggerGap` — интервал над кнопкой равен интервалу под ней.
 *
 * Проверяется не проп поппера, а фактический сдвиг панели: Radix/floating-ui
 * ставит `transform: translate(x, y)` на обёртку контента, и при нулевых
 * прямоугольниках jsdom `y` равен `−sideOffset` (ровно та величина, которая в
 * браузере отодвигает панель от кнопки).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const device = vi.hoisted(() => ({ type: 'desktop' as 'desktop' | 'phone' | 'tablet' }))

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
  getModelGroups: vi.fn(async () => ({
    groups: [],
    page: { models: [], total: 0, offset: 0, limit: 500, next_offset: null },
  })),
  getAgents: vi.fn(async () => ({
    agents: [
      {
        id: 'developer',
        display_name: 'Разработчик',
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
      },
    ],
    default_agent: 'developer',
  })),
  updateSession: vi.fn(async () => ({})),
  updatePreferences: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: api }))

import { ModelSelector } from './ModelSelector'
import { AgentModeSelector } from './AgentModeSelector'
import { ReasoningLevelSelector } from './ReasoningLevelSelector'
import { useProvidersStore } from '@/stores/providersStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Живой замер десктопа 1440×900: под кнопкой до низа композера 14px. */
const COMPOSER_TOP = 400
const COMPOSER_HEIGHT = 76
const COMPOSER_LEFT = 300
const COMPOSER_RIGHT = 1100
const BUTTON_TOP = 440
const BUTTON_HEIGHT = 22
const GAP_BELOW = COMPOSER_TOP + COMPOSER_HEIGHT - (BUTTON_TOP + BUTTON_HEIGHT)

interface StubRect {
  top: number
  left?: number
  right?: number
  height?: number
}

/** jsdom не считает layout: прямоугольник задаётся точечно на элементе. */
function stubRect(element: HTMLElement, rect: StubRect): void {
  const left = rect.left ?? COMPOSER_LEFT
  const right = rect.right ?? COMPOSER_RIGHT
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

/**
 * Сдвиг панели поппера по вертикали. Radix кладёт `transform: translate(x, y)`
 * на обёртку контента, а `y` — абсолютная координата низа панели от верха
 * viewport (у панели в jsdom нулевая высота, поэтому её низ = `y`).
 */
function popperBottom(): number | null {
  const menu = document.body.querySelector('[role="menu"]') as HTMLElement | null
  const wrapper = menu?.parentElement as HTMLElement | null
  const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(wrapper?.style.transform ?? '')
  return match ? Number(match[2]) : null
}

/** Зазор над кнопкой: верх кнопки − низ панели (то, что владелец видит глазами). */
function popperGapAbove(buttonTop: number): number | null {
  const bottom = popperBottom()
  return bottom === null ? null : buttonTop - bottom
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
 * Смонтировать селектор в композер, замерить кнопку и открыть поппер.
 * `extraAnchorOf` — дополнительный якорь замера зазора: у размышлений это
 * рамка-обёртка кнопки (её низ ближе к низу композера, чем у внутренней кнопки).
 */
async function openDropdown(
  node: React.ReactElement,
  options: { extraAnchorOf?: (button: HTMLElement) => HTMLElement } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<div className="chat-composer">{node}</div>)
  })
  await flush(2)

  const composer = container.querySelector('.chat-composer') as HTMLElement
  stubRect(composer, {
    top: COMPOSER_TOP,
    left: COMPOSER_LEFT,
    right: COMPOSER_RIGHT,
    height: COMPOSER_HEIGHT,
  })
  const button = container.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  stubRect(button, {
    top: BUTTON_TOP,
    left: COMPOSER_LEFT + 8,
    right: COMPOSER_LEFT + 60,
    height: BUTTON_HEIGHT,
  })
  if (options.extraAnchorOf) {
    stubRect(options.extraAnchorOf(button), {
      top: BUTTON_TOP - 2,
      left: COMPOSER_LEFT + 6,
      right: COMPOSER_LEFT + 62,
      height: BUTTON_HEIGHT + 4,
    })
  }

  await act(async () => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await flush()
  return container
}

beforeEach(() => {
  device.type = 'desktop'
  useProvidersStore.setState({
    providers: [{ name: 'on', type: 'openai', icon: '', url: '', model: '', enabled: true }],
    models: [],
    catalogModels: [],
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
  useAgentsStore.setState({ agents: [], activeAgentId: 'developer', defaultAgentId: 'developer', loading: false })
  useSessionsStore.setState({ sessions: [{ id: 's1', name: 'Сессия', settings: {} } as never] })
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

describe('Десктопные дропдауны композера: sideOffset = зазор под кнопкой', () => {
  it('зазор под кнопкой на живом десктопе — 14px', () => {
    expect(GAP_BELOW).toBe(14)
  })

  it('дропдаун модели отодвинут от кнопки на 14px (а не на прежние 4)', async () => {
    await openDropdown(<ModelSelector sessionId="s1" />)

    const menu = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(menu).not.toBeNull()
    expect(menu.dataset.side).toBe('top')
    expect(popperGapAbove(BUTTON_TOP)).toBe(GAP_BELOW)
  })

  it('дропдаун агента отодвинут от кнопки на 14px', async () => {
    await openDropdown(<AgentModeSelector sessionId="s1" />)

    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(popperGapAbove(BUTTON_TOP)).toBe(GAP_BELOW)
  })

  it('поппер размышлений берёт зазор по рамке кнопки (как в мобильном листе)', async () => {
    // Якорь зазора у размышлений — рамка вокруг кнопки: она на 2px выше и на 2px
    // ниже внутренней кнопки (p-0.5 + рамка), поэтому её отрезок под кнопкой
    // короче на 2px — панель встаёт ровно на зазор своего якоря.
    const frameTop = BUTTON_TOP - 2
    const frameHeight = BUTTON_HEIGHT + 4
    const frameGap = COMPOSER_TOP + COMPOSER_HEIGHT - (frameTop + frameHeight)
    expect(frameGap).toBe(GAP_BELOW - 2)

    await openDropdown(<ReasoningLevelSelector sessionId="s1" />, {
      extraAnchorOf: (button) => button.parentElement as HTMLElement,
    })

    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(popperGapAbove(BUTTON_TOP)).toBe(frameGap)
  })

  it('без зазора под кнопкой поппер не прилипает: минимум 4px', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })
    await act(async () => {
      root.render(
        <div className="chat-composer">
          <ModelSelector sessionId="s1" />
        </div>,
      )
    })
    await flush(2)

    // Кнопка стоит вплотную к низу композера — под ней 0px.
    const composer = container.querySelector('.chat-composer') as HTMLElement
    stubRect(composer, { top: COMPOSER_TOP, height: COMPOSER_HEIGHT })
    const buttonTop = COMPOSER_TOP + COMPOSER_HEIGHT - BUTTON_HEIGHT
    const button = container.querySelector('button[aria-haspopup="menu"]') as HTMLElement
    stubRect(button, { top: buttonTop, height: BUTTON_HEIGHT })

    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(popperGapAbove(buttonTop)).toBe(4)
  })
})
