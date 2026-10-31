/**
 * ADR-118 §5: восстановление **живого хода** после перезагрузки страницы.
 *
 * История (`GET /sessions/:id/messages`) несёт статус сообщения; сообщение
 * со `status: 'streaming'` — это идущий ход. `ChatTab` обязан после
 * `setMessages` восстановить границы хода (`turnBySession`), иначе лента
 * рисует идущий шаг как обычное сообщение: нет «Стоп», нет индикатора
 * хода, очередь считает ход неидущим.
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
      deleteMessage: vi.fn(),
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

/** История с идущим шагом: последнее сообщение — `status: 'streaming'`. */
const LIVE_MESSAGES: MessageData[] = [
  {
    id: 'msg-user', index: 0, ord: 1, role: 'user', content: 'вопрос',
    disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:00.000Z',
    turn_id: 'turn-1',
  },
  {
    id: 'msg-step', index: 1, ord: 2, role: 'assistant', content: 'начало ответа',
    status: 'streaming', turn_id: 'turn-1', step_index: 0,
    disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:01.000Z',
  },
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
  useChatStore.setState({ selectionBySession: {} })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({ messages: LIVE_MESSAGES, session_id: SESSION } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [] as AgentInfo[], default_agent: 'assistant' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
  } as never)
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

describe('ChatTab — восстановление живого хода из истории (ADR-118 §5)', () => {
  it('после загрузки истории границы идущего хода восстановлены', async () => {
    await mount()

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      messageId: 'msg-step',
      stepIndex: 0,
      status: 'streaming',
    })
  })

  it('живой шаг отрисован как живой (точки в шапке сегмента)', async () => {
    const container = await mount()

    const segment = container.querySelector('[data-message-id="msg-step"]') as HTMLElement
    expect(segment).not.toBeNull()
    expect(segment.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
    expect(segment.querySelector('[data-testid="live-indicator"]')).toBeNull()
    expect(segment.querySelector('.markdown-content')).not.toBeNull()
  })

  it('идущий ход не перетирается повторной загрузкой истории', async () => {
    await mount()
    // Живое событие сменило шаг (`step.started`).
    useChatStore.getState().patchTurn(SESSION, { messageId: 'msg-step-2', stepIndex: 1 })

    await act(async () => {
      await mount()
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      messageId: 'msg-step-2',
      stepIndex: 1,
      status: 'streaming',
    })
  })

  it('current_stream из GET /sessions/:id восстанавливает ход без streaming-сообщения', async () => {
    // История без `streaming`: шаг с текстом завершён, идёт длинный инструмент,
    // следующего assistant-сообщения ещё нет.
    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
      session_id: SESSION,
      messages: [
        {
          id: 'msg-user', index: 0, ord: 1, role: 'user', content: 'запусти',
          disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:00.000Z',
          turn_id: 'turn-9',
        },
        {
          id: 'msg-step', index: 1, ord: 2, role: 'assistant', content: 'Запускаю команду.',
          status: 'completed', turn_id: 'turn-9', step_index: 0,
          disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:01.000Z',
        },
      ],
    } as never)
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: SESSION,
      settings: {},
      session_origin: null,
      pending_messages: [],
      sticky_notes: [],
      status: {},
      current_stream: { turn_id: 'turn-9' },
    } as never)

    const container = await mount()

    // Границы хода восстановлены → индикатор («Стоп» в композере, ctrl+b).
    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-9',
      status: 'streaming',
    })
    expect(container.querySelector('button[title="Stop"]')).not.toBeNull()
  })

  it('status.blocked из GET /sessions/:id восстанавливает ожидающий ход', async () => {
    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
      session_id: SESSION,
      messages: LIVE_MESSAGES,
    } as never)
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: SESSION,
      settings: {},
      session_origin: null,
      pending_messages: [],
      sticky_notes: [],
      status: { blocked: 'permission' },
      current_stream: null,
    } as never)

    await mount()

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      status: 'streaming',
    })
  })

  it('current_stream без turn_id — id хода берётся из истории (сообщения уже в сторе)', async () => {
    // Старое ядро: `current_stream` без `turn_id`. Ход должен совпасть с id хода
    // в истории — иначе live-сообщения получат `turn_id = stream-…`, а история
    // `turn_…`: блок хода рвётся на два, индикатор застревает в середине.
    vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
      session_id: SESSION,
      messages: [
        {
          id: 'msg-user', index: 0, ord: 1, role: 'user', content: 'запусти',
          disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:00.000Z',
          turn_id: 'turn-9',
        },
        {
          id: 'msg-step', index: 1, ord: 2, role: 'assistant', content: 'Запускаю команду.',
          status: 'completed', turn_id: 'turn-9', step_index: 0,
          disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:01.000Z',
        },
      ],
    } as never)
    vi.mocked(synthApi.getSession).mockResolvedValue({
      id: SESSION,
      settings: {},
      session_origin: null,
      pending_messages: [],
      sticky_notes: [],
      status: {},
      current_stream: { stream_id: 'stream-7' },
    } as never)

    await mount()

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-9',
      status: 'streaming',
    })
  })
})
