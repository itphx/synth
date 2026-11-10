/**
 * ChatTab: восстановление незакрытых запросов сессии после перезагрузки.
 *
 * Подтверждения прав (`permission.asked`) и вопросы пользователю
 * (`user_question.asked`) приходят только live-событиями — после перезагрузки
 * страницы (или протухшей аутентификации) клиент о них не знает, и карточка
 * подтверждения пропадает, а ход висит до ask-таймаута.
 *
 * Точка восстановления — `ChatTab` (смонтирован всегда), а не доки
 * `PermissionRequestBar`/`QuestionDock`: оба смонтированы условно
 * (`!inputExpanded && !isSubagent`), поэтому при развёрнутом композере
 * восстановление не выполнялось вовсе.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { resetChatStore } from '@/stores/testUtils'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { usePermissionStore } from '@/stores/permissionStore'
import { useQuestionStore } from '@/stores/questionStore'
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
      listPendingPermissions: vi.fn(),
      list: vi.fn(),
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
  usePermissionStore.setState({ requestsBySession: {} })
  useQuestionStore.setState({ bySession: {} })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages: [
      {
        index: 0,
        id: 'm1',
        seq: 1,
        ord: 1,
        role: 'user',
        content: 'привет',
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-11-03T00:00:00.000Z',
      },
    ],
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
  vi.mocked(synthApi.listPendingPermissions).mockResolvedValue([])
  vi.mocked(synthApi.list).mockResolvedValue({ questions: [] })
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

async function mountChat(): Promise<HTMLElement> {
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

/** Кнопка развёрнутого композера (по подписи). */
function expandButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('title') === 'Expand',
  )
}

describe('ChatTab — восстановление незакрытых запросов сессии', () => {
  it('подтягивает ожидающие подтверждения прав и показывает карточку', async () => {
    vi.mocked(synthApi.listPendingPermissions).mockResolvedValue([
      {
        approvalId: 'apr_1',
        toolName: 'read_file',
        params: { path: '/tmp/a' },
        reason: 'нужно прочитать',
        askedAt: new Date().toISOString(),
        timeoutMs: 30_000,
      },
    ])

    const container = await mountChat()

    expect(synthApi.listPendingPermissions).toHaveBeenCalledWith(SESSION)
    expect(container.textContent).toContain('requests permission')
    expect(usePermissionStore.getState().requestsBySession[SESSION]?.[0]?.approvalId).toBe('apr_1')
  })

  it('подтягивает ожидающие вопросы (опросник)', async () => {
    vi.mocked(synthApi.list).mockResolvedValue({
      questions: [
        {
          id: 'qst_1',
          sessionId: SESSION,
          status: 'pending',
          questions: [{ question: 'Какой вариант?', header: 'Выбор', options: [] }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const container = await mountChat()

    expect(synthApi.list).toHaveBeenCalledWith(SESSION, { status: 'pending', limit: 50 })
    expect(container.textContent).toContain('Какой вариант?')
  })

  it('восстановление не зависит от развёрнутого композера', async () => {
    vi.mocked(synthApi.listPendingPermissions).mockResolvedValue([
      {
        approvalId: 'apr_1',
        toolName: 'read_file',
        params: {},
        reason: '',
        askedAt: new Date().toISOString(),
        timeoutMs: 30_000,
      },
    ])

    const container = await mountChat()

    // Расширяем композер — доки (`PermissionRequestBar`/`QuestionDock`)
    // размонтированы, но восстановленные запросы остались в сторах.
    const expand = expandButton(container)
    expect(expand).toBeDefined()
    await act(async () => {
      expand!.click()
    })
    await flush(2)

    expect(container.querySelector('[data-question-dock]')).toBeNull()
    expect(usePermissionStore.getState().requestsBySession[SESSION]).toHaveLength(1)
  })

  it('восстановленная карточка показывает остаток, а не полный срок', async () => {
    // Запрошено 20 с назад при сроке 30 с — осталось ~10 с.
    vi.mocked(synthApi.listPendingPermissions).mockResolvedValue([
      {
        approvalId: 'apr_1',
        toolName: 'read_file',
        params: {},
        reason: '',
        askedAt: new Date(Date.now() - 20_000).toISOString(),
        timeoutMs: 30_000,
      },
    ])

    const container = await mountChat()

    expect(container.textContent).toMatch(/(9|10) сек/)
    expect(container.textContent).not.toContain('30 сек')
  })

  it('ошибка восстановления не ломает чат и не шумит тостом', async () => {
    vi.mocked(synthApi.listPendingPermissions).mockRejectedValue(new Error('network'))
    vi.mocked(synthApi.list).mockRejectedValue(new Error('network'))

    const container = await mountChat()

    expect(container.textContent).not.toContain('requests permission')
    expect(notify).not.toHaveBeenCalled()
  })
})
