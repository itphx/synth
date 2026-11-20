/**
 * ChatTab: вкладка дочерней сессии (саб-агента).
 *
 * PROP-142 §2: дочерняя сессия **интерактивна** — композер доступен, сообщение
 * уходит существующим путём `POST /sessions/:id/prompt` (сервер сам решает
 * steer/queue/resume). Заглушка «только чтение» остаётся только для сессии,
 * которой больше нет (удалена/архивирована).
 *
 * PROP-143: durable-запись остановки (`metadata.type='execution_stopped'`) —
 * причина показа плашки «Продолжить»: кнопка есть только у сбоев прогона
 * (`provider_error`/`internal`/`empty`); у причин-ограничителей
 * (`steps_limit`/`context_budget`/`output_limit`) и у `stopped_by_user` её нет —
 * продолжение идёт новым сообщением. Причину показывает служебный блок в ленте,
 * плашка — только действие (текст причины не дублируется).
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
      resumeSubagent: vi.fn(),
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

const SESSION = 'child-1'
const TAB: CenterTab = {
  id: 'chat-child-1',
  type: 'chat',
  title: 'Сабагент',
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
    session_origin: 'subagent',
    pending_messages: [],
    sticky_notes: [],
  } as never)
  vi.mocked(synthApi.resumeSubagent).mockResolvedValue({ status: 'started' } as never)
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

/**
 * Durable-запись остановки хода (PROP-143): служебное user-сообщение с
 * `metadata.type='execution_stopped'` и причиной в `metadata.reason`.
 */
function stopRecord(reason: string) {
  return {
    index: 1,
    id: 'msg-stop',
    role: 'user',
    content: `<execution_stopped reason="${reason}">\nтекст провайдера\n</execution_stopped>`,
    author: 'System',
    metadata: { type: 'execution_stopped', reason },
    disabled: false,
    pinned: false,
  }
}

/** Вкладка дочерней сессии; при `reason` — с записью остановки в истории. */
async function mountSubagent(reason?: string): Promise<HTMLElement> {
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

  if (reason) {
    act(() => {
      useChatStore.getState().setMessages(SESSION, [stopRecord(reason)] as never)
    })
    await flush(2)
  }
  return container
}

/** Кнопка «Продолжить» плашки остановки. */
function resumeButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Resume',
  )
}

describe('ChatTab — вкладка дочерней сессии (PROP-142/143)', () => {
  it('композер доступен: поле ввода есть, заглушки «read-only» нет', async () => {
    const container = await mountSubagent()

    expect(container.querySelector('textarea')).not.toBeNull()
    expect(container.textContent).not.toContain('Session is unavailable')
  })

  it('execution_stopped (provider_error) → плашка «Продолжить», клик зовёт resumeSubagent', async () => {
    const container = await mountSubagent('provider_error')

    // Причина — в служебном блоке ленты, а не в плашке.
    expect(container.textContent).toContain('Stopped: provider error')
    expect(container.textContent).not.toContain('Subagent stopped')
    const btn = resumeButton(container)
    expect(btn).toBeTruthy()

    await act(async () => {
      btn!.click()
    })
    await flush()

    expect(synthApi.resumeSubagent).toHaveBeenCalledTimes(1)
    expect(synthApi.resumeSubagent).toHaveBeenCalledWith(SESSION)
  })

  it('execution_stopped (stopped_by_user) → плашки нет, «Продолжить» нет', async () => {
    const container = await mountSubagent('stopped_by_user')

    expect(container.textContent).toContain('Interrupted: stopped by the user')
    expect(resumeButton(container)).toBeUndefined()
    expect(synthApi.resumeSubagent).not.toHaveBeenCalled()
  })

  it('без записи остановки плашки нет', async () => {
    const container = await mountSubagent()

    expect(resumeButton(container)).toBeUndefined()
  })
})
