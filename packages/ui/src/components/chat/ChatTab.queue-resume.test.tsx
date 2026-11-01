/**
 * ChatTab: возобновление очереди после «Стопа».
 *
 * «Стоп» оставляет очередь в покое (автозапуска нет) — продолжить обработку
 * можно кнопкой в панели очереди (`POST /queue/:sessionId/resume`). Кнопка
 * доступна, когда очередь непуста и активного хода нет.
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

/** Сессия с очередью из одного сообщения и без активного хода (после «Стопа»). */
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
    useChatStore.getState().setPendingMessages(SESSION, [{ id: 'a', content: 'в очереди' }])
    useChatStore.getState().updateQueueCount(SESSION, 1)
  })
  await flush(2)
  return container
}

describe('ChatTab — возобновление очереди после «Стопа»', () => {
  it('кнопка «Продолжить» видна при непустой очереди без активного хода', async () => {
    const container = await mountWithQueue()
    expect(container.querySelector('[data-testid="queue-resume"]')).not.toBeNull()
  })

  it('нажатие шлёт POST /queue/:sessionId/resume', async () => {
    const container = await mountWithQueue()
    const resume = container.querySelector('[data-testid="queue-resume"]') as HTMLButtonElement | null
    expect(resume).toBeTruthy()

    await act(async () => {
      resume!.click()
    })
    await flush()

    expect(synthApi.resumeQueue).toHaveBeenCalledTimes(1)
    expect(synthApi.resumeQueue).toHaveBeenCalledWith(SESSION)
  })

  it('при активном ходе кнопки «Продолжить» нет', async () => {
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
      useChatStore.getState().startTurn(SESSION, {
        turnId: 'turn_1',
        status: 'streaming',
        contentStarted: false,
      })
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'a', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
    })
    await flush(2)

    expect(container.querySelector('[data-testid="queue-resume"]')).toBeNull()
  })
})
