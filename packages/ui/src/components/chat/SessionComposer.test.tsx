/**
 * SessionComposer: общий композер сессии (UI-1).
 *
 * Композер — единый блок «панель очереди + поле ввода» для чата и будущего
 * дока «Спросить агента» в терминале. Проверяем контракт компонента:
 *   - рендерит очередь и ввод, в развёрнутом виде — только ввод;
 *   - отправка уходит в транспорт (`POST /sessions/:id/prompt`);
 *   - «Вклинить» в очереди уходит в разрыв хода (`POST /queue/:id/steer`);
 *   - отказ отправки по коду `PROVIDER_DISABLED` даёт плашку, а не тост.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionComposer, type SessionComposerProps } from './SessionComposer'
import { useSessionComposer } from './useSessionComposer'
import { useChatStore } from '@/stores/chatStore'
import { resetChatStore } from '@/stores/testUtils'
import { synthApi } from '@/lib/api/synthApi'

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      enqueueMessage: vi.fn(),
      getSession: vi.fn(),
      returnQueue: vi.fn(),
      steerQueue: vi.fn(),
      clearQueue: vi.fn(),
      resumeQueue: vi.fn(),
      reorderQueue: vi.fn(),
      addStickyNote: vi.fn(),
    },
  }
})

const notify = vi.hoisted(() => vi.fn())
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
const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Хост: контроллер (логика) + композер (разметка) — как в чате. */
function ComposerHarness(props: Partial<SessionComposerProps>) {
  const controller = useSessionComposer(SESSION)
  return (
    <SessionComposer
      controller={controller}
      agents={[]}
      isStreaming={false}
      {...props}
    />
  )
}

async function mount(props: Partial<SessionComposerProps> = {}): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ComposerHarness {...props} />
      </I18nProvider>,
    )
  })
  await flush()
  return container
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

/** Развернуть панель очереди (по умолчанию она свёрнута). */
async function expandQueue(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector('[data-testid="queue-header-toggle"]') as HTMLButtonElement | null
  expect(toggle).toBeTruthy()
  await act(async () => {
    toggle!.click()
  })
  await flush(2)
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  vi.mocked(synthApi.enqueueMessage).mockResolvedValue({
    messageId: 'm1',
    mode: 'queue',
    position: 1,
  } as never)
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    pending_messages: [],
  } as never)
  vi.mocked(synthApi.steerQueue).mockResolvedValue({ steered: true, pending_count: 0 } as never)
  vi.mocked(synthApi.returnQueue).mockResolvedValue({ texts: ['x'] } as never)
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

describe('SessionComposer — композер сессии', () => {
  it('рендерит поле ввода и панель очереди', async () => {
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'q1', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
    })
    const container = await mount()

    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.querySelector('[data-testid="queue-header-toggle"]')).toBeTruthy()
  })

  it('пустая очередь — панели очереди нет', async () => {
    const container = await mount()

    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.querySelector('[data-testid="queue-header-toggle"]')).toBeNull()
  })

  it('развёрнутый композер показывает только ввод', async () => {
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'q1', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
    })
    const container = await mount({
      expanded: true,
      banner: <div data-testid="banner" />,
      children: <div data-testid="extra" />,
    })

    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.querySelector('[data-testid="queue-header-toggle"]')).toBeNull()
    expect(container.querySelector('[data-testid="banner"]')).toBeNull()
    expect(container.querySelector('[data-testid="extra"]')).toBeNull()
  })

  it('баннер и слот вызывающего — между очередью и вводом', async () => {
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'q1', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
    })
    const container = await mount({
      banner: <div data-testid="banner" />,
      children: <div data-testid="extra" />,
    })

    expect(container.querySelector('[data-testid="banner"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="extra"]')).toBeTruthy()
  })

  it('отправка уходит в транспорт', async () => {
    const container = await mount()

    await send(container, 'привет')

    expect(synthApi.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(synthApi.enqueueMessage).mock.calls[0][0]).toBe(SESSION)
    expect(vi.mocked(synthApi.enqueueMessage).mock.calls[0][1]).toBe('привет')
  })

  it('«Вклинить» в очереди уходит в разрыв хода', async () => {
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'msg-1', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
    })
    // «Вклинить» доступно только при активном ходе (ADR-118 §1).
    const container = await mount({ isStreaming: true })
    await expandQueue(container)

    const button = container.querySelector('[data-testid="queue-steer-0"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    await act(async () => {
      button!.click()
    })
    await flush()

    expect(synthApi.steerQueue).toHaveBeenCalledWith(SESSION, { id: 'msg-1' })
  })

  it('отказ отправки по коду PROVIDER_DISABLED даёт плашку, а не тост', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(
      Object.assign(new Error('disabled'), {
        status: 400,
        code: 'PROVIDER_DISABLED',
        details: { provider: 'off' },
      }),
    )
    const container = await mount()

    await send(container)

    const panel = container.querySelector('[data-testid="send-blocked-panel"]')
    expect(panel).toBeTruthy()
    expect(panel!.textContent).toContain('off')
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(enDict['chat.error.sendFailed']) }),
    )
  })
})
