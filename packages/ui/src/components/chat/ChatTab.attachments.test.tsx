/**
 * ADR-115: «Повторить» возвращает вложения сообщения в композер.
 *
 * Интеграция ChatTab.handleRetry → attachmentsStore.restore → ChatInput
 * (чип + маркер в тексте) → отправка с `attachments: [blobPath]`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { useAgentsStore } from '@/stores/agentsStore'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
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
      retryMessage: vi.fn(),
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

// MessageList/ScrollableOverlay используют ResizeObserver и scrollTo — в jsdom их нет.
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
const BLOB_PATH = 'attachments/ab/hash'
const MESSAGE = {
  index: 0,
  id: 'm1',
  role: 'user',
  seq: 1,
  origin: 'local',
  content: 'смотри [image: photo.png]',
  parts: [
    { id: 'text-1', type: 'text', data: 'смотри' },
    {
      id: 'part-1',
      type: 'image',
      data: {
        blobPath: BLOB_PATH,
        sha256: 'hash',
        mime: 'image/png',
        size: 12,
        name: 'photo.png',
      },
    },
  ],
  created_at: '2026-01-01T00:00:00.000Z',
  disabled: false,
  pinned: false,
  hidden: false,
}

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
  useAttachmentsStore.setState({ bySession: {} })
  useAgentsStore.setState({ agents: [], activeAgentId: null, defaultAgentId: 'assistant', loading: false })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages: [MESSAGE],
    session_id: SESSION,
  } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [] as AgentInfo[], default_agent: 'assistant' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    settings: {},
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
  } as never)
  vi.mocked(synthApi.retryMessage).mockResolvedValue({
    content: 'смотри [image: photo.png]',
    success: true,
  })
  vi.mocked(synthApi.enqueueMessage).mockResolvedValue(undefined as never)
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  useAttachmentsStore.setState({ bySession: {} })
})

describe('ChatTab — «Повторить» с вложениями (ADR-115)', () => {
  it('восстанавливает вложение в композер и отправляет его blobPath', async () => {
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

    const retryButton = container.querySelector('button[title="Retry"]') as HTMLButtonElement | null
    expect(retryButton).toBeTruthy()
    await act(async () => {
      retryButton!.click()
    })
    await flush()

    // Вложение вернулось в стор как готовое, исходного File нет.
    const restored = useAttachmentsStore.getState().bySession[SESSION] ?? []
    expect(restored).toHaveLength(1)
    expect(restored[0]!.blobPath).toBe(BLOB_PATH)
    expect(restored[0]!.partId).toBe(BLOB_PATH)
    expect(restored[0]!.upload).toBe('ready')

    // Чип виден (изображение — превью), текст с маркером приехал в композер.
    const chip = container.querySelector('[data-testid="attachment-image"]')
    expect(chip?.querySelector('img')?.getAttribute('alt')).toBe('photo.png')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('смотри [image: photo.png]')

    // Отправка уносит blobPath вложением (без повторной вставки маркера).
    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.getAttribute('title') === enDict['chat.input.send'],
    ) as HTMLButtonElement | undefined
    expect(sendButton).toBeTruthy()
    await act(async () => {
      sendButton!.click()
    })
    await flush()

    const call = vi.mocked(synthApi.enqueueMessage).mock.calls[0]
    expect(call).toBeTruthy()
    expect(call![0]).toBe(SESSION)
    expect(call![1]).toBe('смотри [image: photo.png]')
    expect(call![2]).toMatchObject({ attachments: [BLOB_PATH] })
  })
})
