/**
 * «Повторить» после финальной ошибки хода (B6).
 *
 * Регрессия: цель искалась как «последняя user-реплика с `metadata.last_error`».
 * После `stream.error` UI историю не перечитывает, поэтому у текущей упавшей
 * реплики `last_error` в сторе обычно ещё нет — повтор уходил в более старый
 * запрос. Теперь цель адресуется `stream.error.message_id` (id упавшей
 * реплики), затем `turn_id` хода, затем — просто последняя user-реплика.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { useChatStore, type FinalStreamError, type MessageData } from '@/stores/chatStore'
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
      getSessionMessage: vi.fn(),
      getAgents: vi.fn(),
      getSession: vi.fn(),
      toggleMessage: vi.fn(),
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

function userMsg(id: string, ord: number, content: string, extra: Partial<MessageData> = {}): MessageData {
  return {
    index: ord - 1,
    id,
    seq: ord,
    ord,
    role: 'user',
    content,
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-03T00:00:00.000Z',
    ...extra,
  }
}

function assistantMsg(id: string, ord: number): MessageData {
  return {
    index: ord - 1,
    id,
    seq: ord,
    ord,
    role: 'assistant',
    content: 'ответ',
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-03T00:00:01.000Z',
  }
}

function finalError(overrides: Partial<FinalStreamError> = {}): FinalStreamError {
  return {
    streamId: 'stream-1',
    error: 'boom',
    errorType: 'network_error',
    ...overrides,
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
  vi.mocked(synthApi.getSessionMessage).mockResolvedValue({ message: userMsg('u-new', 3, '') } as never)
  vi.mocked(synthApi.toggleMessage).mockResolvedValue({ disabled: true, success: true } as never)
  vi.mocked(synthApi.enqueueMessage).mockResolvedValue({} as never)
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

/** Смонтировать вкладку с готовой лентой и плашкой финальной ошибки. */
async function mountWith(messages: MessageData[], error: FinalStreamError): Promise<HTMLElement> {
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages,
    session_id: SESSION,
    has_more: false,
    next_before: null,
  } as never)

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
  await act(async () => {
    useChatStore.getState().setFinalStreamError(SESSION, error)
  })
  await flush()
  return container
}

async function clickRetry(container: HTMLElement): Promise<void> {
  const panel = container.querySelector<HTMLElement>('[data-testid="stream-error-panel"]')
  expect(panel).not.toBeNull()
  const button = Array.from(panel!.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').trim() === 'Retry')
  expect(button).toBeTruthy()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

describe('ChatTab — «Повторить» после финальной ошибки', () => {
  it('повторяет реплику упавшего хода по message_id, а не старую с last_error', async () => {
    // У старой реплики остался `last_error`, у текущей (упавшей) его ещё нет.
    const oldUser = userMsg('u-old', 1, 'давний вопрос', { metadata: { last_error: true } })
    const oldAnswer = assistantMsg('a-old', 2)
    const currentUser = userMsg('u-new', 3, 'текущий вопрос', { turn_id: 't2' })
    const currentAnswer = assistantMsg('a-new', 4)

    const container = await mountWith(
      [oldUser, oldAnswer, currentUser, currentAnswer],
      finalError({ messageId: 'u-new', turnId: 't2' }),
    )

    await clickRetry(container)

    expect(synthApi.toggleMessage).toHaveBeenCalledWith(SESSION, 'u-new')
    expect(synthApi.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(synthApi.enqueueMessage).mock.calls[0]![1]).toBe('текущий вопрос')
    // Плашка снята — цель найдена и повтор отправлен.
    expect(useChatStore.getState().finalErrorBySession[SESSION]).toBeNull()
  })

  it('без message_id (старое ядро) берёт последнюю user-реплику, а не помеченную last_error', async () => {
    const oldUser = userMsg('u-old', 1, 'давний вопрос', { metadata: { last_error: true } })
    const oldAnswer = assistantMsg('a-old', 2)
    const currentUser = userMsg('u-new', 3, 'текущий вопрос')

    const container = await mountWith(
      [oldUser, oldAnswer, currentUser],
      finalError(),
    )

    await clickRetry(container)

    expect(synthApi.getSessionMessage).not.toHaveBeenCalled()
    expect(synthApi.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(synthApi.enqueueMessage).mock.calls[0]![1]).toBe('текущий вопрос')
  })

  it('нет user-реплик — плашка снимается, ничего не отправляется', async () => {
    // Реплики упавшего хода нет ни в сторе, ни на сервере (404).
    vi.mocked(synthApi.getSessionMessage).mockRejectedValueOnce(new Error('404'))
    const container = await mountWith([assistantMsg('a-1', 1)], finalError({ messageId: 'u-gone' }))

    await clickRetry(container)

    expect(synthApi.getSessionMessage).toHaveBeenCalledWith(SESSION, 'u-gone')
    expect(synthApi.toggleMessage).not.toHaveBeenCalled()
    expect(synthApi.enqueueMessage).not.toHaveBeenCalled()
    await flush()
    expect(useChatStore.getState().finalErrorBySession[SESSION]).toBeNull()
  })
})
