/**
 * ChatTab: создание заметки при отказе сервера по лимитам.
 *
 * 409 `LIMIT_EXCEEDED` / 400 `VALIDATION_ERROR` показываются понятным текстом
 * про лимит, а не общим «ошибка сохранения».
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { resetChatStore } from '@/stores/testUtils'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { resetStickyNotesLimitsCache } from '@/lib/api/stickyNotesLimits'
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
      addStickyNote: vi.fn(),
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

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  resetStickyNotesLimitsCache({ maxCount: 2, maxChars: 2000 })
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
  resetStickyNotesLimitsCache()
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

async function createNote(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    setTextareaValue(textarea, text)
  })
  const button = Array.from(container.querySelectorAll('button')).find((element) =>
    (element.getAttribute('title') ?? '').startsWith('Create note'),
  ) as HTMLButtonElement
  expect(button).toBeTruthy()
  await act(async () => {
    button.click()
  })
  await flush()
}

function errorTexts(): string[] {
  return notify.mock.calls
    .map(([options]) => options as { text?: string })
    .map((options) => options.text ?? '')
}

describe('ChatTab — заметки и лимиты инстанса', () => {
  it('409 LIMIT_EXCEEDED → текст про лимит, а не общий saveError', async () => {
    vi.mocked(synthApi.addStickyNote).mockRejectedValue(
      Object.assign(new Error('limit exceeded'), { status: 409, code: 'LIMIT_EXCEEDED' }),
    )
    const container = await mount()
    await createNote(container, 'заметка')

    expect(synthApi.addStickyNote).toHaveBeenCalledWith(SESSION, 'заметка')
    expect(errorTexts()).toContain('Note limit reached: at most 2 notes per session')
    expect(errorTexts()).not.toContain(enDict['common.saveError'])
  })

  it('400 VALIDATION_ERROR → текст про длину заметки', async () => {
    vi.mocked(synthApi.addStickyNote).mockRejectedValue(
      Object.assign(new Error('too long'), { status: 400, code: 'VALIDATION_ERROR' }),
    )
    const container = await mount()
    await createNote(container, 'заметка')

    expect(errorTexts()).toContain('The note was rejected: maximum 2000 characters')
  })

  it('успешное создание обновляет панель заметок', async () => {
    const note = {
      id: 'n1',
      content: 'заметка',
      created_at: '2026-11-02T00:00:00.000Z',
      updated_at: '2026-11-02T00:00:00.000Z',
      disabled: false,
    }
    vi.mocked(synthApi.addStickyNote).mockResolvedValue({ note, notes: [note] } as never)
    const container = await mount()
    await createNote(container, 'заметка')

    expect(container.querySelector('[data-testid="sticky-notes-counter"]')?.textContent).toBe(
      'Notes: 1/2',
    )
  })
})
