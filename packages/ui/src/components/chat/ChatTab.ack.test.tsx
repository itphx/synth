/**
 * Метка «просмотрено» (`notificationStore.ackedAtBySession`) — единственная
 * точка постановки: `ChatTab`, когда его вкладка активна.
 *
 * Метка — вход модели `sessionBadgeState` (`lib/sessionBadgeState.ts`): исход
 * последнего хода сессии старше метки уже прочитан, дерево его не красит.
 * Проверяем оба пути: открытая при загрузке страницы вкладка (эффект на
 * монтировании) и переключение на сессию (смена `activeCenterTabId`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// persist (zustand) в notificationStore/useUIStore пишет в localStorage — в
// Node/vitest его нет.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatTab } from './ChatTab'
import { resetChatStore } from '@/stores/testUtils'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

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

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(rounds = 3): Promise<void> {
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
  useNotificationStore.setState({ ackedAtBySession: {} })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages: [],
    session_id: SESSION,
  } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({
    agents: [] as AgentInfo[],
    default_agent: 'assistant',
  })
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

describe('ChatTab — метка «просмотрено»', () => {
  it('активная вкладка чата при монтировании ставит метку сессии', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    expect(useNotificationStore.getState().getAckedAt(SESSION)).toBeUndefined()

    await mount()

    const ackedAt = useNotificationStore.getState().getAckedAt(SESSION)
    expect(typeof ackedAt).toBe('number')
    expect(ackedAt!).toBeGreaterThan(0)
  })

  it('вкладка не активна — метки нет', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-other' })

    await mount()

    expect(useNotificationStore.getState().getAckedAt(SESSION)).toBeUndefined()
  })

  it('переключение на вкладку сессии ставит метку', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-other' })
    await mount()
    expect(useNotificationStore.getState().getAckedAt(SESSION)).toBeUndefined()

    await act(async () => {
      useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    })
    await flush()

    expect(useNotificationStore.getState().getAckedAt(SESSION)).toBeGreaterThan(0)
  })

  it('переключение на другую сессию не трогает метку этой', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    await mount()
    const first = useNotificationStore.getState().getAckedAt(SESSION)!
    expect(first).toBeGreaterThan(0)

    await act(async () => {
      useUIStore.setState({ activeCenterTabId: 'chat-other' })
    })
    await flush()

    // Метка осталась прежней (не сброшена и не «омоложена» чужим переходом).
    expect(useNotificationStore.getState().getAckedAt(SESSION)).toBe(first)
  })
})
