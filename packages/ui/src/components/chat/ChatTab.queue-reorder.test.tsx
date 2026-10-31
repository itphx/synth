/**
 * ChatTab: DnD-переупорядочивание очереди.
 *
 * Успех — `synthApi.reorderQueue(sid, ids)` + локальный порядок в сторе
 * (оптимистично, до ответа). `409 QUEUE_CHANGED` — очередь на сервере уже
 * другая: тост `chat.queue.changed` и перечитывание состава (`getSession`).
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
      reorderQueue: vi.fn(),
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

async function drag(el: Element, type: 'dragstart' | 'dragover' | 'drop' | 'dragend'): Promise<void> {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    dataTransfer: {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: () => {},
      getData: () => '',
    },
  })
  await act(async () => {
    el.dispatchEvent(event)
  })
}

function row(container: HTMLElement, index: number): Element {
  const el = container.querySelector(`[data-testid="queue-item-${index}"]`)
  expect(el).not.toBeNull()
  return el!
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

async function mountWithQueue(): Promise<HTMLElement> {
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

  act(() => {
    useChatStore.getState().setPendingMessages(SESSION, [
      { id: 'a', content: 'первое' },
      { id: 'b', content: 'второе' },
      { id: 'c', content: 'третье' },
    ])
    useChatStore.getState().updateQueueCount(SESSION, 3)
  })
  await flush(2)

  const toggle = container.querySelector('[data-testid="queue-header-toggle"]') as HTMLButtonElement | null
  expect(toggle).toBeTruthy()
  await act(async () => {
    toggle!.click()
  })
  await flush(2)
  return container
}

describe('ChatTab — DnD-переупорядочивание очереди', () => {
  it('успех: reorderQueue с новым порядком id + локальный порядок в сторе', async () => {
    vi.mocked(synthApi.reorderQueue).mockResolvedValue(undefined as never)
    const container = await mountWithQueue()

    await drag(row(container, 0), 'dragstart')
    await drag(row(container, 2), 'dragover')
    await drag(row(container, 2), 'drop')
    await flush()

    expect(synthApi.reorderQueue).toHaveBeenCalledTimes(1)
    expect(synthApi.reorderQueue).toHaveBeenCalledWith(SESSION, ['b', 'c', 'a'])
    const pending = useChatStore.getState().pendingBySession[SESSION] ?? []
    expect(pending.map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('409 QUEUE_CHANGED → тост «очередь изменилась» и перечитывание очереди', async () => {
    vi.mocked(synthApi.reorderQueue).mockRejectedValue(
      Object.assign(new Error('queue changed'), { status: 409, code: 'QUEUE_CHANGED' }),
    )
    const container = await mountWithQueue()
    const sessionCallsBefore = vi.mocked(synthApi.getSession).mock.calls.length

    await drag(row(container, 2), 'dragstart')
    await drag(row(container, 0), 'dragover')
    await drag(row(container, 0), 'drop')
    await flush()

    expect(synthApi.reorderQueue).toHaveBeenCalledWith(SESSION, ['c', 'a', 'b'])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: 'The queue changed — refreshed',
      type: 'info',
    }))
    expect(vi.mocked(synthApi.getSession).mock.calls.length).toBeGreaterThan(sessionCallsBefore)
  })

  it('прочая ошибка → тост ошибки перестановки', async () => {
    vi.mocked(synthApi.reorderQueue).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 }),
    )
    const container = await mountWithQueue()

    await drag(row(container, 1), 'dragstart')
    await drag(row(container, 2), 'drop')
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Failed to reorder the queue',
      type: 'error',
    }))
  })
})
