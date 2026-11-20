import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionData } from '@/lib/api/synthApi'

// persist (zustand) захватывает localStorage при импорте сторов — заглушка до импорта.
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

// Всплывающие окна — мок; `notifyMessage` настоящий (проверяем счётчики и историю).
vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const mocks = vi.hoisted(() => ({
  getSessionsPage: vi.fn(),
  updateSession: vi.fn(),
  getSessions: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
// Транспорт в тестах не подключён — локальное применение ответа (как при офлайне).
vi.mock('./transportStore', () => ({ isTransportConnected: () => false }))

import { useSessionsStore } from './sessionsStore'
import { useNotificationStore } from './notificationStore'
import { useUIStore } from './useUIStore'
import { useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'

function session(
  id: string,
  extra: Partial<SessionData> & { status?: Record<string, unknown> } = {},
): SessionData {
  return {
    id,
    name: id,
    user_id: 'u1',
    owner_id: 'u1',
    project_id: null,
    messages: [],
    pending_messages: [],
    status: { blocked: null },
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
    ...extra,
  } as SessionData
}

/** Ответ `GET /sessions` с указанными сессиями (страница-сводка). */
function page(sessions: SessionData[]) {
  return {
    sessions,
    total: sessions.length,
    offset: 0,
    limit: 100,
    next_offset: null,
  }
}

function history() {
  return useNotificationStore.getState().history
}

function unread(sessionId: string): number {
  return useNotificationStore.getState().sessionUnread[sessionId] ?? 0
}

describe('sessionsStore.loadSessions: сводный тост «требуется действие»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    useSessionsStore.setState({ sessions: [], total: 0, nextOffset: null })
    useNotificationStore.setState({
      history: [],
      sessionUnread: {},
      suppressedUnread: {},
      actionNotified: {},
    })
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('pending_approvals > 0 у неоткрытой сессии — один тост с requiresAction', async () => {
    mocks.getSessionsPage.mockResolvedValueOnce(
      page([session('s1', { pending_approvals: 2 })]),
    )

    await useSessionsStore.getState().loadSessions()

    expect(history()).toHaveLength(1)
    expect(history()[0]).toMatchObject({
      text: 'Ждут подтверждения: 2',
      type: 'info',
      category: 'system',
      sessionId: 's1',
      requiresAction: true,
    })
    expect(unread('s1')).toBe(1)
  })

  it('повторная загрузка списка тост не дублирует', async () => {
    mocks.getSessionsPage.mockResolvedValue(
      page([session('s1', { pending_approvals: 1 })]),
    )

    await useSessionsStore.getState().loadSessions()
    await useSessionsStore.getState().loadSessions()

    expect(history()).toHaveLength(1)
  })

  it('ожидание снято — метка сбрасывается, новое ожидание снова даёт тост', async () => {
    mocks.getSessionsPage.mockResolvedValueOnce(
      page([session('s1', { pending_approvals: 1 })]),
    )
    await useSessionsStore.getState().loadSessions()
    expect(history()).toHaveLength(1)

    mocks.getSessionsPage.mockResolvedValueOnce(page([session('s1', { pending_approvals: 0 })]))
    await useSessionsStore.getState().loadSessions()
    expect(history()).toHaveLength(1)
    expect(useNotificationStore.getState().actionNotified['s1']).toBeUndefined()

    mocks.getSessionsPage.mockResolvedValueOnce(
      page([session('s1', { pending_approvals: 1 })]),
    )
    await useSessionsStore.getState().loadSessions()
    expect(history()).toHaveLength(2)
  })

  it('остановленная очередь (queue_stopped) — тост «ждёт продолжения»', async () => {
    mocks.getSessionsPage.mockResolvedValueOnce(
      page([session('s1', { status: { blocked: null, queue_stopped: true } })]),
    )

    await useSessionsStore.getState().loadSessions()

    expect(history()).toHaveLength(1)
    expect(history()[0]).toMatchObject({
      text: 'Очередь остановлена — ждёт продолжения',
      requiresAction: true,
      sessionId: 's1',
    })
    expect(unread('s1')).toBe(1)
  })

  it('активная сессия не уведомляется', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'chat-s1', type: 'chat', title: 's1', data: { sessionId: 's1' } }],
      activeCenterTabId: 'chat-s1',
    })
    mocks.getSessionsPage.mockResolvedValueOnce(
      page([session('s1', { pending_approvals: 1 })]),
    )

    await useSessionsStore.getState().loadSessions()

    expect(history()).toHaveLength(0)
    expect(unread('s1')).toBe(0)
  })

  it('сессии без ожиданий тостов не дают', async () => {
    mocks.getSessionsPage.mockResolvedValueOnce(
      page([session('s1'), session('s2', { pending_approvals: 0 })]),
    )

    await useSessionsStore.getState().loadSessions()

    expect(history()).toHaveLength(0)
  })
})
