/**
 * D3: строка очереди без серверного `id` не адресуется по индексу.
 * Обработчики «Удалить»/«В разрыв» не должны вызывать API с индексом —
 * вместо этого перечитывают очередь (локальный id мог потеряться).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { useChatStore } from '@/stores/chatStore'
import { resetChatStore } from '@/stores/testUtils'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
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
      returnQueue: vi.fn(),
      steerQueue: vi.fn(),
      enqueueMessage: vi.fn(),
    },
  }
})

vi.mock('@/lib/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
  useNotification: () => ({ notify: vi.fn() }),
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
const TAB: CenterTab = {
  id: 'chat-s1',
  type: 'chat',
  title: 'Сессия',
  data: { sessionId: SESSION },
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({ messages: [], session_id: SESSION } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [] as AgentInfo[], default_agent: 'assistant' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
  } as never)
  vi.mocked(synthApi.returnQueue).mockResolvedValue({ texts: ['x'] } as never)
  vi.mocked(synthApi.steerQueue).mockResolvedValue({ steered: true, pending_count: 0 } as never)
  vi.mocked(synthApi.enqueueMessage).mockResolvedValue(undefined as never)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('ChatTab — строка очереди без id', () => {
  async function mountWithPending(id?: string): Promise<HTMLElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })
    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatTab tab={TAB} />
        </I18nProvider>,
      )
    })
    await flush()
    // Строка без `id` (например, пришла из старого источника/потерялась).
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ ...(id ? { id } : {}), content: id ? 'с id' : 'без id' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
    })
    await flush(2)
    // Очередь по умолчанию свёрнута — разворачиваем, чтобы строки были в DOM.
    const toggle = container.querySelector('[data-testid="queue-header-toggle"]') as HTMLButtonElement | null
    expect(toggle).toBeTruthy()
    await act(async () => {
      toggle!.click()
    })
    await flush(2)
    return container
  }

  it('«Удалить»: API не вызывается, очередь перечитывается', async () => {
    const container = await mountWithPending()
    const before = vi.mocked(synthApi.getSession).mock.calls.length

    const button = container.querySelector('[data-testid="queue-remove-0"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    await act(async () => {
      button!.click()
    })
    await flush()

    expect(synthApi.returnQueue).not.toHaveBeenCalled()
    expect(synthApi.steerQueue).not.toHaveBeenCalled()
    expect(vi.mocked(synthApi.getSession).mock.calls.length).toBeGreaterThan(before)
  })

  it('«В разрыв»: API не вызывается, очередь перечитывается', async () => {
    const container = await mountWithPending()
    // Кнопка steer видна только при активном ходе.
    act(() => {
      useChatStore.setState((state) => ({
        streamingBySession: {
          ...state.streamingBySession,
          [SESSION]: { st1: { isStreaming: true } } as never,
        },
      }))
    })
    await flush(2)
    const before = vi.mocked(synthApi.getSession).mock.calls.length

    const button = container.querySelector('[data-testid="queue-steer-0"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    await act(async () => {
      button!.click()
    })
    await flush()

    expect(synthApi.steerQueue).not.toHaveBeenCalled()
    expect(vi.mocked(synthApi.getSession).mock.calls.length).toBeGreaterThan(before)
  })

  it('«Удалить»: строка с id → returnQueue({id})', async () => {
    const container = await mountWithPending('msg-1')

    const button = container.querySelector('[data-testid="queue-remove-0"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    await act(async () => {
      button!.click()
    })
    await flush()

    expect(synthApi.returnQueue).toHaveBeenCalledWith(SESSION, { id: 'msg-1' })
    expect(synthApi.steerQueue).not.toHaveBeenCalled()
  })

  it('«В разрыв»: строка с id → steerQueue({id})', async () => {
    const container = await mountWithPending('msg-1')
    act(() => {
      useChatStore.setState((state) => ({
        streamingBySession: {
          ...state.streamingBySession,
          [SESSION]: { st1: { isStreaming: true } } as never,
        },
      }))
    })
    await flush(2)

    const button = container.querySelector('[data-testid="queue-steer-0"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    await act(async () => {
      button!.click()
    })
    await flush()

    expect(synthApi.steerQueue).toHaveBeenCalledWith(SESSION, { id: 'msg-1' })
  })
})
