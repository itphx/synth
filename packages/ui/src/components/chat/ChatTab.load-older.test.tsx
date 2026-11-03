/**
 * Пагинация истории ленты (ADR-089 + контракт `GET /sessions/:id/messages`).
 *
 * - первичная загрузка берёт **последнюю** страницу (`limit`), а не всю историю;
 * - кнопка «Загрузить старые» видна, пока сервер отдаёт `has_more`;
 * - клик грузит страницу **перед** курсором (`before: next_before`) и
 *   **добавляет** сообщения в начало ленты; курсор и `has_more` обновляются.
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
import type { MessageData } from '@/stores/chatStore'

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getSessionMessages: vi.fn(),
      getAgents: vi.fn(),
      getSession: vi.fn(),
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

function serverMsg(id: string, ord: number, seq: number): MessageData {
  return {
    index: seq - 1,
    id,
    seq,
    ord,
    role: 'assistant',
    content: `сообщение ${ord}`,
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-03T00:00:00.000Z',
  }
}

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
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages: [serverMsg('m2', 2, 2)],
    session_id: SESSION,
    has_more: true,
    next_before: 2,
  } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [] as AgentInfo[], default_agent: 'assistant' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
    status: {},
    current_stream: null,
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

describe('ChatTab — пагинация истории ленты', () => {
  it('первичная загрузка берёт последнюю страницу (limit=200)', async () => {
    await mount()

    expect(synthApi.getSessionMessages).toHaveBeenCalledWith(SESSION, { limit: 200 })
  })

  it('has_more/next_before сохраняются в сторе — кнопка «Загрузить старые» видна', async () => {
    const container = await mount()

    expect(useChatStore.getState().historyPageBySession[SESSION]).toEqual({
      hasMore: true,
      nextBefore: 2,
    })
    expect(container.querySelector('[data-testid="load-older"]')).not.toBeNull()
  })

  it('клик грузит страницу перед курсором и добавляет сообщения в начало ленты', async () => {
    const container = await mount()

    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [serverMsg('m1', 1, 1)],
      session_id: SESSION,
      has_more: false,
      next_before: null,
    } as never)

    const button = container.querySelector<HTMLButtonElement>('[data-testid="load-older"]')!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(synthApi.getSessionMessages).toHaveBeenLastCalledWith(SESSION, {
      limit: 200,
      before: 2,
    })
    const messages = useChatStore.getState().messagesBySession[SESSION] ?? []
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Больше старых сообщений нет — кнопка исчезает, курсор сброшен.
    expect(useChatStore.getState().historyPageBySession[SESSION]).toEqual({
      hasMore: false,
      nextBefore: null,
    })
    expect(container.querySelector('[data-testid="load-older"]')).toBeNull()
  })

  it('ошибка догрузки не теряет уже загруженную страницу', async () => {
    const container = await mount()

    vi.mocked(synthApi.getSessionMessages).mockRejectedValueOnce(new Error('сеть'))

    const button = container.querySelector<HTMLButtonElement>('[data-testid="load-older"]')!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const messages = useChatStore.getState().messagesBySession[SESSION] ?? []
    expect(messages.map((m) => m.id)).toEqual(['m2'])
    // Курсор прежний — повторная попытка возможна.
    expect(useChatStore.getState().historyPageBySession[SESSION]).toEqual({
      hasMore: true,
      nextBefore: 2,
    })
  })
})
