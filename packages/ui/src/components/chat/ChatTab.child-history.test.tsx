/**
 * ChatTab: автодогрузка истории **дочерней** сессии (ADR-111, ADR-118 §1).
 *
 * У прогона саб-агента шаги живут отдельными сообщениями (каждый шаг — свои
 * `metadata.tool_results`, плюс `role:'tool'` результаты), поэтому длинный
 * прогон перерастает одну страницу истории. При открытии вкладки дочерней
 * сессии история догружается целиком существующим механизмом пагинации
 * (`before: next_before` → `prependMessages` → `expanded: true`), а обычная
 * сессия по-прежнему делает **один** запрос.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { useChatStore, type MessageData } from '@/stores/chatStore'
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

const SESSION = 'child-1'
const TAB: CenterTab = {
  id: 'chat-child-1',
  type: 'chat',
  title: 'Сабагент',
  data: { sessionId: SESSION },
}

/** Число страниц автодогрузки — как `CHILD_HISTORY_MAX_PAGES` в `ChatTab`. */
const MAX_OLDER_PAGES = 20

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

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
    created_at: '2026-11-18T00:00:00.000Z',
  }
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages: [serverMsg('m1', 1, 1)],
    session_id: SESSION,
    has_more: false,
    next_before: null,
  } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({
    agents: [] as AgentInfo[],
    default_agent: 'assistant',
  })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: 'subagent',
    parent_id: 'parent-1',
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

describe('ChatTab — автодогрузка истории дочерней сессии', () => {
  it('дочерняя сессия: догружает все страницы, лента полная, курсор expanded', async () => {
    const pages: Record<string, unknown> = {
      initial: {
        messages: [serverMsg('m3', 3, 3)],
        has_more: true,
        next_before: 3,
      },
      '3': { messages: [serverMsg('m2', 2, 2)], has_more: true, next_before: 2 },
      '2': { messages: [serverMsg('m1', 1, 1)], has_more: false, next_before: null },
    }
    vi.mocked(synthApi.getSessionMessages).mockImplementation((async (
      _sid: string,
      params?: { before?: number },
    ) => ({
      session_id: SESSION,
      ...(pages[params?.before != null ? String(params.before) : 'initial'] as object),
    })) as never)

    const container = await mount()

    expect(synthApi.getSessionMessages).toHaveBeenCalledTimes(3)
    expect(synthApi.getSessionMessages).toHaveBeenNthCalledWith(1, SESSION, { limit: 200 })
    expect(synthApi.getSessionMessages).toHaveBeenNthCalledWith(2, SESSION, { limit: 200, before: 3 })
    expect(synthApi.getSessionMessages).toHaveBeenNthCalledWith(3, SESSION, { limit: 200, before: 2 })

    const messages = useChatStore.getState().messagesBySession[SESSION] ?? []
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    // `expanded: true` — последующие снимки не сбрасывают догруженный курсор.
    expect(useChatStore.getState().historyPageBySession[SESSION]).toEqual({
      hasMore: false,
      nextBefore: null,
      expanded: true,
    })
    // Вся история загружена — кнопки «Загрузить старые» нет.
    expect(container.querySelector('[data-testid="load-older"]')).toBeNull()
  })

  it('дочерняя сессия по `parent_id` (без session_origin) тоже догружается', async () => {
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: SESSION,
      settings: {},
      session_origin: null,
      parent_id: 'parent-1',
      pending_messages: [],
      sticky_notes: [],
      status: {},
      current_stream: null,
    } as never)
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [serverMsg('m2', 2, 2)],
      session_id: SESSION,
      has_more: true,
      next_before: 2,
    } as never)
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [serverMsg('m1', 1, 1)],
      session_id: SESSION,
      has_more: false,
      next_before: null,
    } as never)

    await mount()

    expect(synthApi.getSessionMessages).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('обычная сессия — один запрос, кнопка «Загрузить старые» на месте', async () => {
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: SESSION,
      settings: {},
      session_origin: null,
      parent_id: null,
      pending_messages: [],
      sticky_notes: [],
      status: {},
      current_stream: null,
    } as never)
    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
      messages: [serverMsg('m2', 2, 2)],
      session_id: SESSION,
      has_more: true,
      next_before: 2,
    } as never)

    const container = await mount()

    expect(synthApi.getSessionMessages).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().historyPageBySession[SESSION]).toEqual({
      hasMore: true,
      nextBefore: 2,
      expanded: false,
    })
    expect(container.querySelector('[data-testid="load-older"]')).not.toBeNull()
  })

  it('число страниц ограничено капом — сервер с вечным has_more не зацикливает', async () => {
    vi.mocked(synthApi.getSessionMessages).mockImplementation((async (
      _sid: string,
      params?: { before?: number },
    ) => ({
      session_id: SESSION,
      messages: params?.before != null ? [] : [serverMsg('m2', 2, 2)],
      has_more: true,
      next_before: 100,
    })) as never)

    await mount()

    // Первая страница + не больше капа догрузок.
    expect(synthApi.getSessionMessages).toHaveBeenCalledTimes(1 + MAX_OLDER_PAGES)
  })

  it('отмена размонтированием не пишет догруженную страницу в стор', async () => {
    let resolveOlder: ((value: unknown) => void) | undefined
    vi.mocked(synthApi.getSessionMessages).mockImplementation((async (
      _sid: string,
      params?: { before?: number },
    ) => {
      if (params?.before != null) {
        return new Promise((resolve) => {
          resolveOlder = resolve
        })
      }
      return {
        session_id: SESSION,
        messages: [serverMsg('m2', 2, 2)],
        has_more: true,
        next_before: 2,
      }
    }) as never)

    await mount()
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual(['m2'])

    // Вкладку закрыли, пока страница в полёте.
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()

    await act(async () => {
      resolveOlder?.({
        session_id: SESSION,
        messages: [serverMsg('m1', 1, 1)],
        has_more: false,
        next_before: null,
      })
    })
    await flush(2)

    // Старая страница не добавлена и курсор не тронут.
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual(['m2'])
    expect(useChatStore.getState().historyPageBySession[SESSION]).toEqual({
      hasMore: true,
      nextBefore: 2,
      expanded: false,
    })
  })
})
