/**
 * ADR-118 §7: мутации сообщений адресуются **только по `id`**.
 * Лента сортируется по `ord`, позиционный индекс нестабилен — в тесте `id`
 * намеренно не совпадает с `index`, так что обращение по индексу дало бы
 * другой путь запроса.
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
      toggleMessage: vi.fn(),
      pinMessage: vi.fn(),
      deleteMessage: vi.fn(),
      retryMessage: vi.fn(),
      batchMessages: vi.fn(),
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
const TAB: CenterTab = { id: 'chat-s1', type: 'chat', title: 'Сессия', data: { sessionId: SESSION } }

function message(id: string, index: number, role: string, content: string, ord: number): MessageData {
  return {
    id,
    index,
    ord,
    role,
    content,
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00.000Z',
  }
}

// `id` и `index` намеренно расходятся (порядок ленты задаёт `ord`).
const MESSAGES: MessageData[] = [
  message('msg-b', 0, 'user', 'вопрос', 1),
  message('msg-a', 1, 'assistant', 'ответ', 2),
]

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
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
  // `resetChatStore` не чистит выделение — сбрасываем явно (тесты изолированы).
  useChatStore.setState({ selectionBySession: {} })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({ messages: MESSAGES, session_id: SESSION } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [] as AgentInfo[], default_agent: 'assistant' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
  } as never)
  vi.mocked(synthApi.toggleMessage).mockResolvedValue({ disabled: true, success: true } as never)
  vi.mocked(synthApi.pinMessage).mockResolvedValue({ pinned: true, success: true } as never)
  vi.mocked(synthApi.deleteMessage).mockResolvedValue({ success: true } as never)
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

function buttonIn(container: HTMLElement, messageId: string, title: string): HTMLButtonElement {
  const row = container.querySelector(`[data-message-id="${messageId}"]`)
  expect(row, `сообщение ${messageId} должно быть в ленте`).not.toBeNull()
  const btn = row!.querySelector(`button[title="${title}"]`)
  expect(btn, `кнопка "${title}" у ${messageId}`).not.toBeNull()
  return btn as HTMLButtonElement
}

describe('ChatTab — мутации сообщений по id (ADR-118 §7)', () => {
  it('«Закрепить» → pinMessage(sessionId, id)', async () => {
    const container = await mount()
    await act(async () => {
      buttonIn(container, 'msg-a', 'Pin').click()
    })
    await flush(2)
    expect(synthApi.pinMessage).toHaveBeenCalledWith(SESSION, 'msg-a')
  })

  it('«Отключить» → toggleMessage(sessionId, id)', async () => {
    const container = await mount()
    await act(async () => {
      buttonIn(container, 'msg-b', 'Disable').click()
    })
    await flush(2)
    expect(synthApi.toggleMessage).toHaveBeenCalledWith(SESSION, 'msg-b')
  })

  it('«Удалить» → deleteMessage(sessionId, id)', async () => {
    const container = await mount()
    await act(async () => {
      buttonIn(container, 'msg-a', 'Delete').click()
    })
    await flush(2)
    expect(synthApi.deleteMessage).toHaveBeenCalledWith(SESSION, 'msg-a')
  })

  it('удаление самого нового сообщения убирает его, хотя снимок без него имеет меньший maxOrd', async () => {
    // Регресс: защита от гонки «снимок старше записи» (ord > maxOrd снимка)
    // сохраняла удалённое самое новое сообщение — удаление адресуется по id.
    const first = { ...message('m-1', 0, 'user', 'первое', 1), seq: 1 }
    const second = { ...message('m-2', 1, 'assistant', 'второе', 2), seq: 2 }
    const newest = { ...message('m-3', 2, 'user', 'самое новое', 3), seq: 3 }
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [first, second, newest],
      session_id: SESSION,
    } as never)
    // Снимок после DELETE: самого нового сообщения уже нет, maxOrd = 2.
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [first, second],
      session_id: SESSION,
    } as never)

    const container = await mount()
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ])

    await act(async () => {
      buttonIn(container, 'm-3', 'Delete').click()
    })
    await flush(4)

    expect(synthApi.deleteMessage).toHaveBeenCalledWith(SESSION, 'm-3')
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual([
      'm-1',
      'm-2',
    ])
  })

  it('удаление среднего сообщения по-прежнему работает', async () => {
    const first = { ...message('m-1', 0, 'user', 'первое', 1), seq: 1 }
    const middle = { ...message('m-2', 1, 'assistant', 'среднее', 2), seq: 2 }
    const last = { ...message('m-3', 2, 'user', 'последнее', 3), seq: 3 }
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [first, middle, last],
      session_id: SESSION,
    } as never)
    vi.mocked(synthApi.getSessionMessages).mockResolvedValueOnce({
      messages: [first, last],
      session_id: SESSION,
    } as never)

    const container = await mount()
    await act(async () => {
      buttonIn(container, 'm-2', 'Delete').click()
    })
    await flush(4)

    expect(synthApi.deleteMessage).toHaveBeenCalledWith(SESSION, 'm-2')
    expect(useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id)).toEqual([
      'm-1',
      'm-3',
    ])
  })

  it('без серверного id действие не уходит в API', async () => {
    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
      messages: [{ ...MESSAGES[1]!, id: undefined }],
      session_id: SESSION,
    } as never)
    const container = await mount()
    const row = container.querySelector('.message-actions')
    expect(row).not.toBeNull()
    const pin = container.querySelector('button[title="Pin"]') as HTMLButtonElement | null
    if (pin) {
      await act(async () => {
        pin.click()
      })
      await flush(2)
    }
    expect(synthApi.pinMessage).not.toHaveBeenCalled()
  })
})

describe('Пакетные мутации — по id', () => {
  it('pin на контейнере хода → batchMessages с messageIds', async () => {
    const turnMessages: MessageData[] = [
      { ...message('msg-x', 0, 'assistant', 'шаг 1', 1), turn_id: 'turn-1' },
      { ...message('msg-y', 1, 'assistant', 'шаг 2', 2), turn_id: 'turn-1' },
    ]
    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
      messages: turnMessages,
      session_id: SESSION,
    } as never)
    vi.mocked(synthApi.batchMessages).mockResolvedValue({ results: [] } as never)

    const container = await mount()
    // Ряд действий блока хода — у последнего сегмента (ADR-118 §1), pin всё равно
    // пинит весь ход целиком.
    await act(async () => {
      buttonIn(container, 'msg-y', 'Pin').click()
    })
    await flush(2)

    expect(synthApi.batchMessages).toHaveBeenCalledWith(SESSION, 'pin', ['msg-x', 'msg-y'], true)
  })
})

describe('Выделение — по id', () => {
  it('selectAllMessages/toggleMessageSelection хранят id, а не индекс', () => {
    const store = useChatStore.getState()
    store.setMessages(SESSION, MESSAGES)
    store.toggleSelectionMode(SESSION)
    store.selectAllMessages(SESSION)
    expect([...useChatStore.getState().selectionBySession[SESSION]!.ids]).toEqual(['msg-b', 'msg-a'])

    store.toggleMessageSelection(SESSION, 'msg-a')
    expect([...useChatStore.getState().selectionBySession[SESSION]!.ids]).toEqual(['msg-b'])
  })

  it('selectMessageRange выделяет по id между двумя сообщениями ленты', () => {
    const store = useChatStore.getState()
    store.setMessages(SESSION, MESSAGES)
    store.toggleSelectionMode(SESSION)
    store.selectMessageRange(SESSION, 'msg-b', 'msg-a')
    expect([...useChatStore.getState().selectionBySession[SESSION]!.ids]).toEqual(['msg-b', 'msg-a'])
  })
})
