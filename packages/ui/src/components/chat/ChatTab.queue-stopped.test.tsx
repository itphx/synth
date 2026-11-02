/**
 * ChatTab: осознанная остановка обработки переживает рестарт.
 *
 * `queue.stalled` публикуется в момент «Стопа», но свежий клиент подключается
 * уже после — сигнал нужно восстановить из `GET /sessions/:id`
 * (`status.queue_stopped` + непустой `pending_messages` без активного хода),
 * иначе баннер «Обработка остановлена» и «Продолжить» не появятся.
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
      resumeQueue: vi.fn(),
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
    pending_messages: [
      {
        id: 'pending-1',
        index: 0,
        role: 'user',
        content: 'в очереди',
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-11-02T00:00:00.000Z',
      },
    ],
    sticky_notes: [],
    status: { queue_stopped: true, queue_stopped_at: '2026-11-02T00:00:05.000Z' },
    current_stream: null,
  } as never)
  vi.mocked(synthApi.resumeQueue).mockResolvedValue(undefined as never)
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

async function mount(): Promise<HTMLElement> {
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
  return container
}

describe('ChatTab — осознанная остановка очереди после рестарта', () => {
  it('status.queue_stopped из GET /sessions/:id поднимает isStalled', async () => {
    await mount()

    const queue = useChatStore.getState().queueBySession[SESSION]
    expect(queue?.isStalled).toBe(true)
    expect(queue?.pendingCount).toBe(1)
  })

  it('баннер «Обработка остановлена» и кнопка «Продолжить» видны', async () => {
    const container = await mount()

    expect(container.textContent).toContain('Processing stopped: 1 messages')
    expect(container.querySelector('[data-testid="queue-resume"]')).not.toBeNull()
  })

  it('без флага queue_stopped isStalled не поднимается', async () => {
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: SESSION,
      settings: {},
      session_origin: null,
      pending_messages: [
        {
          id: 'pending-1',
          index: 0,
          role: 'user',
          content: 'в очереди',
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: '2026-11-02T00:00:00.000Z',
        },
      ],
      sticky_notes: [],
      status: {},
      current_stream: null,
    } as never)

    await mount()

    expect(useChatStore.getState().queueBySession[SESSION]?.isStalled).toBeFalsy()
  })
})
