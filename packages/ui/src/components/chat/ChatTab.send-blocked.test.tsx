/**
 * ChatTab: плашка «провайдер/модель отключены» над композером.
 *
 * `POST /prompt` отвечает `400 PROVIDER_DISABLED`/`MODEL_DISABLED` — вместо
 * общего тоста показывается понятная плашка; снимается при успешной отправке,
 * смене модели/провайдера и переключении сессии. Прочие ошибки — прежний тост.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { resetChatStore } from '@/stores/testUtils'
import { useProvidersStore } from '@/stores/providersStore'
import { synthApi, type AgentInfo, type ProviderInfo } from '@/lib/api/synthApi'
import type { CenterTab } from '@/stores/useUIStore'

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getSessionMessages: vi.fn(),
      getAgents: vi.fn(),
      getSession: vi.fn(),
      enqueueMessage: vi.fn(),
    },
  }
})

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
  useNotification: () => ({ notify }),
}))
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))
vi.mock('@/components/ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./AgentModeSelector', () => ({ AgentModeSelector: () => null }))
vi.mock('./PlanActModeToggle', () => ({ PlanActModeToggle: () => null }))
vi.mock('./ReasoningLevelSelector', () => ({ ReasoningLevelSelector: () => null }))

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

const SESSION = 's1'
const TAB: CenterTab = { id: 'chat-s1', type: 'chat', title: 'Сессия', data: { sessionId: SESSION } }
const TAB_2: CenterTab = { id: 'chat-s2', type: 'chat', title: 'Сессия 2', data: { sessionId: 's2' } }

const provider: ProviderInfo = {
  name: 'on',
  type: 'openai',
  icon: '',
  url: '',
  model: '',
  enabled: true,
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(tab: CenterTab = TAB): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatTab tab={tab} />
      </I18nProvider>,
    )
  })
  await flush()
  return { container, root }
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

async function send(container: HTMLElement, text = 'привет'): Promise<void> {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  expect(textarea).toBeTruthy()
  await act(async () => {
    setTextareaValue(textarea, text)
  })
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.getAttribute('title') === enDict['chat.input.send'],
  ) as HTMLButtonElement | undefined
  expect(button).toBeTruthy()
  await act(async () => {
    button!.click()
  })
  await flush()
}

function blockedError(code: 'PROVIDER_DISABLED' | 'MODEL_DISABLED') {
  return Object.assign(new Error(`${code} message`), {
    status: 400,
    code,
    details: code === 'PROVIDER_DISABLED' ? { provider: 'off' } : { provider: 'p', model: 'm' },
  })
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  useProvidersStore.setState({
    providers: [provider],
    selectedProviderName: 'on',
    selectedModelName: 'good',
  })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({ messages: [], session_id: SESSION } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [] as AgentInfo[], default_agent: 'assistant' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
  } as never)
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

describe('ChatTab: отключённый провайдер/модель при отправке', () => {
  it('PROVIDER_DISABLED → плашка с провайдером, без тоста об ошибке отправки', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(blockedError('PROVIDER_DISABLED'))
    const { container } = await mount()

    await send(container)

    const panel = container.querySelector('[data-testid="send-blocked-panel"]')
    expect(panel).toBeTruthy()
    expect(panel!.textContent).toContain('off')
    // Общий тост «Ошибка отправки» не дублируется.
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(enDict['chat.error.sendFailed']) }),
    )
  })

  it('MODEL_DISABLED → плашка с provider/model', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(blockedError('MODEL_DISABLED'))
    const { container } = await mount()

    await send(container)

    const panel = container.querySelector('[data-testid="send-blocked-panel"]')
    expect(panel).toBeTruthy()
    expect(panel!.textContent).toContain('p/m')
  })

  it('снимается при успешной отправке', async () => {
    vi.mocked(synthApi.enqueueMessage)
      .mockRejectedValueOnce(blockedError('PROVIDER_DISABLED'))
      .mockResolvedValueOnce({ messageId: 'm1', mode: 'queue', position: 1 })
    const { container } = await mount()

    await send(container)
    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeTruthy()

    await send(container)
    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeNull()
  })

  it('снимается при смене модели', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(blockedError('MODEL_DISABLED'))
    const { container } = await mount()

    await send(container)
    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeTruthy()

    await act(async () => {
      useProvidersStore.setState({ selectedModelName: 'other' })
    })
    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeNull()
  })

  it('снимается при переключении сессии', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(blockedError('PROVIDER_DISABLED'))
    const { container, root } = await mount()

    await send(container)
    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeTruthy()

    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({ messages: [], session_id: 's2' } as never)
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: 's2',
      settings: {},
      session_origin: null,
      pending_messages: [],
      sticky_notes: [],
    } as never)
    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatTab tab={TAB_2} />
        </I18nProvider>,
      )
    })
    await flush()

    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeNull()
  })

  it('прочие ошибки — только тост, плашки нет', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(new Error('network down'))
    const { container } = await mount()

    await send(container)

    expect(container.querySelector('[data-testid="send-blocked-panel"]')).toBeNull()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(enDict['chat.error.sendFailed']) }),
    )
  })
})
