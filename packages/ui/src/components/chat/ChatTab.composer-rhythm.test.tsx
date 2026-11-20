/**
 * ChatTab: вертикальный ритм композерной зоны (`SessionComposer` + плашки вне
 * него).
 *
 * Проблема владельца: над полем ввода одновременно живут несколько блоков
 * (предупреждение о контексте, панель очереди, полоса подтверждений прав, док
 * вопросов, плашка финальной ошибки, плашка остановки саб-агента, «отправка
 * заблокирована»). Раньше у каждого были свои `mt-2`/`mb-2` (или их не было
 * вовсе) — соседние блоки то слипались (док вопроса + плашка ошибки), то давали
 * двойной зазор.
 *
 * Инвариант: расстояние между любыми соседями задаёт **контейнер** —
 * `flex flex-col gap-2` в `SessionComposer` (`data-testid="session-composer"`) и
 * такой же контейнер в `ChatTab` для плашек вне композера
 * (`data-testid="chat-composer-zone"`). У самих блоков вертикальных отступов
 * нет, поэтому интервалы не складываются. Зазор на стыке двух контейнеров даёт
 * `pt-2` композера — он равен `gap` (8 px по токену темы `--spacing-2`).
 *
 * Проверяем структурно (классы/`data-testid`), не по пикселям.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { resetChatStore } from '@/stores/testUtils'
import { useChatStore } from '@/stores/chatStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useQuestionStore } from '@/stores/questionStore'
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
      enqueueMessage: vi.fn(),
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

/** Класс-контракт контейнера ритма: столбец с единым `gap`. */
function expectRhythmContainer(el: HTMLElement | null): void {
  expect(el).not.toBeNull()
  expect(el!.className).toContain('flex')
  expect(el!.className).toContain('flex-col')
  expect(el!.className).toContain('gap-2')
}

/** У плашки нет собственных вертикальных отступов (их даёт контейнер). */
function expectNoVerticalMargin(el: HTMLElement | null): void {
  expect(el).not.toBeNull()
  expect(el!.className).not.toMatch(/(^|\s)(mt|mb|my)-/)
}

/** Ожидающая карточка подтверждения прав (восстановление через API). */
function seedPermission(): void {
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
}

/** Ожидающий вопрос агента (восстановление через API). */
function seedQuestion(): void {
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

describe('ChatTab — ритм композерной зоны', () => {
  it('ошибка + вопрос: оба блока на месте, интервал даёт ритм (8 px), не отступы', async () => {
    seedQuestion()
    const container = await mountChat()

    // Финальная ошибка хода — плашка вне композера.
    act(() => {
      useChatStore.getState().setFinalStreamError(SESSION, {
        streamId: 'stream-1',
        error: 'boom',
        errorType: 'internal',
      })
    })
    await flush(2)

    const errorPanel = container.querySelector('[data-testid="stream-error-panel"]') as HTMLElement
    const questionDock = container.querySelector('[data-question-dock="true"]') as HTMLElement
    expect(errorPanel).not.toBeNull()
    expect(questionDock).not.toBeNull()

    // Плашки вне композера — в своём контейнере ритма…
    const errorZone = container.querySelector('[data-testid="chat-composer-zone"]') as HTMLElement
    expectRhythmContainer(errorZone)
    expect(errorPanel.parentElement).toBe(errorZone)
    expectNoVerticalMargin(errorPanel)

    // …док вопроса — в контейнере композера, с тем же ритмом.
    const composerZone = container.querySelector('[data-testid="session-composer"]') as HTMLElement
    expectRhythmContainer(composerZone)
    expect(questionDock.parentElement).toBe(composerZone)
    expectNoVerticalMargin(questionDock)

    // Стык двух контейнеров даёт `pt-2` композера — тот же шаг шкалы, что `gap-2`.
    expect(composerZone.className).toContain('pt-2')
  })

  it('подтверждение + вопрос: оба блока в одном контейнере ритма', async () => {
    seedPermission()
    seedQuestion()
    const container = await mountChat()

    const permissionBar = container.querySelector('.permission-bar') as HTMLElement
    const questionDock = container.querySelector('[data-question-dock="true"]') as HTMLElement
    expect(permissionBar).not.toBeNull()
    expect(questionDock).not.toBeNull()

    const composerZone = container.querySelector('[data-testid="session-composer"]') as HTMLElement
    expectRhythmContainer(composerZone)
    // Оба — прямые дети одного контейнера: между ними ровно один `gap`, без
    // удвоения (собственных `mt-*`/`mb-*` у плашек нет).
    expect(permissionBar.parentElement).toBe(composerZone)
    expect(questionDock.parentElement).toBe(composerZone)
    expectNoVerticalMargin(permissionBar)
    expectNoVerticalMargin(questionDock)
    expect(Array.from(composerZone.children).indexOf(permissionBar))
      .toBeLessThan(Array.from(composerZone.children).indexOf(questionDock))
  })

  it('ошибка + очередь: панель очереди в ритме композера, ошибка — в своём', async () => {
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'q1', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
      useChatStore.getState().setFinalStreamError(SESSION, {
        streamId: 'stream-1',
        error: 'boom',
        errorType: 'internal',
      })
    })
    const container = await mountChat()

    const errorPanel = container.querySelector('[data-testid="stream-error-panel"]') as HTMLElement
    const queueToggle = container.querySelector('[data-testid="queue-header-toggle"]') as HTMLElement
    expect(errorPanel).not.toBeNull()
    expect(queueToggle).not.toBeNull()

    const composerZone = container.querySelector('[data-testid="session-composer"]') as HTMLElement
    const queueBlock = queueToggle.closest('.shrink-0') as HTMLElement
    expect(queueBlock).not.toBeNull()
    expect(queueBlock.parentElement).toBe(composerZone)
    expectNoVerticalMargin(queueBlock)
    // Единственная плашка в зоне вне композера — ошибка.
    const errorZone = container.querySelector('[data-testid="chat-composer-zone"]') as HTMLElement
    expectRhythmContainer(errorZone)
    expect(errorZone.children).toHaveLength(1)
  })

  it('блоков нет: композер остаётся единственным контейнером ритма', async () => {
    const container = await mountChat()

    expect(container.querySelector('[data-testid="chat-composer-zone"]')).toBeNull()
    const composerZone = container.querySelector('[data-testid="session-composer"]') as HTMLElement
    expectRhythmContainer(composerZone)
    // Только поле ввода: `gap` между несуществующими блоками не рисуется.
    expect(composerZone.children).toHaveLength(1)
    expect(
      (composerZone.firstElementChild as HTMLElement).classList.contains('chat-composer'),
    ).toBe(true)
  })
})
