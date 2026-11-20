/**
 * Метка «просмотрено» (`notificationStore.ackedTurnBySession`) — единственная
 * точка постановки: `ChatTab`.
 *
 * Метка — ключ **увиденного исхода** последнего хода (`turnKey(last_turn)`),
 * вход модели `sessionBadgeState` (`lib/sessionBadgeState.ts`): при совпадении
 * ключей дерево название не красит.
 *
 * Проверяются оба пути постановки:
 *  1. активация вкладки — включая уже открытую при загрузке страницы (эффект на
 *     монтировании) и переключение на сессию (смена `activeCenterTabId`);
 *  2. смена исхода **при уже открытой вкладке** — ход завершился, пока человек
 *     смотрит чат: новый ключ отмечается сразу (иначе зелёный/красный «прилипал»
 *     к названию до переключения вкладки).
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
import { useSessionsStore } from '@/stores/sessionsStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { turnKey } from '@/lib/sessionBadgeState'
import { synthApi, type AgentInfo, type SessionData } from '@/lib/api/synthApi'

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

/** Моменты исходов: текущий ход и следующий (детерминированные ключи). */
const TURN_AT = '2026-01-01T12:00:00.000Z'
const NEXT_TURN_AT = '2026-01-02T09:00:00.000Z'

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Сессия в сторе (источник durable-исхода для метки — без запросов к API). */
function sessionData(
  at: string | null,
  outcome: 'completed' | 'error' = 'completed',
): SessionData {
  return {
    id: SESSION,
    name: SESSION,
    user_id: 'u1',
    owner_id: 'u1',
    project_id: null,
    pending_messages: [],
    status: { blocked: null, last_turn: at === null ? null : { outcome, at } },
    activity: { type: 'idle' },
    settings: {},
    sticky_notes: [],
    summarization_pending: false,
    can_summarize: false,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    processor_running: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** Положить сессию в стор (исход последнего хода = `at`). */
function setStoredTurn(at: string | null, outcome: 'completed' | 'error' = 'completed'): void {
  useSessionsStore.setState({ sessions: [sessionData(at, outcome)] })
}

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
  useNotificationStore.setState({ ackedTurnBySession: {} })
  setStoredTurn(TURN_AT)
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({
    messages: [],
    session_id: SESSION,
  } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({
    agents: [] as AgentInfo[],
    default_agent: 'assistant',
  })
  // Детальный ответ сессии заменяет запись в сторе — держим тот же исход.
  vi.mocked(synthApi.getSession).mockImplementation(async () => sessionData(TURN_AT) as never)
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
    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBeUndefined()

    await mount()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBe(
      turnKey({ outcome: 'completed', at: TURN_AT }),
    )
  })

  it('вкладка не активна — метки нет', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-other' })

    await mount()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBeUndefined()
  })

  it('исхода нет (ход ни разу не завершался) — метки нет', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    setStoredTurn(null)
    vi.mocked(synthApi.getSession).mockImplementation(async () => sessionData(null) as never)

    await mount()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBeUndefined()
  })

  it('переключение на вкладку сессии ставит метку', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-other' })
    await mount()
    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBeUndefined()

    await act(async () => {
      useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    })
    await flush()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBe(
      turnKey({ outcome: 'completed', at: TURN_AT }),
    )
  })

  it('переключение на другую сессию не трогает метку этой', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    await mount()
    const first = useNotificationStore.getState().getAckedTurnKey(SESSION)
    expect(first).toBeDefined()

    await act(async () => {
      useUIStore.setState({ activeCenterTabId: 'chat-other' })
    })
    await flush()

    // Метка осталась прежней (не сброшена и не «омоложена» чужим переходом).
    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBe(first)
  })
})

describe('ChatTab — исход меняется при открытой вкладке', () => {
  it('новый ход у активной вкладки отмечается сразу (цвет не «прилипает»)', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    await mount()
    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBe(
      turnKey({ outcome: 'completed', at: TURN_AT }),
    )

    // Ход завершился, пока человек смотрит чат: `last_turn` сменился.
    await act(async () => {
      setStoredTurn(NEXT_TURN_AT)
    })
    await flush()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBe(
      turnKey({ outcome: 'completed', at: NEXT_TURN_AT }),
    )
  })

  it('смена исхода на ошибку у активной вкладки тоже отмечается', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-s1' })
    await mount()

    await act(async () => {
      setStoredTurn(NEXT_TURN_AT, 'error')
    })
    await flush()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBe(
      turnKey({ outcome: 'error', at: NEXT_TURN_AT }),
    )
  })

  it('смена исхода у НЕактивной вкладки метку не ставит', async () => {
    useUIStore.setState({ activeCenterTabId: 'chat-other' })
    await mount()

    await act(async () => {
      setStoredTurn(NEXT_TURN_AT)
    })
    await flush()

    expect(useNotificationStore.getState().getAckedTurnKey(SESSION)).toBeUndefined()
  })
})
