import { describe, it, expect, beforeEach, vi } from 'vitest'

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

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('react-toastify', () => ({ toast: toastMocks }))

import { notifyMessage, notifyPendingActionSessions } from './useNotification'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUIStore } from '@/stores/useUIStore'

function unread(sessionId: string): number {
  return useNotificationStore.getState().sessionUnread[sessionId] ?? 0
}

function openSessionInActiveTab(sessionId: string): void {
  useUIStore.setState({
    centerTabs: [
      { id: `chat-${sessionId}`, type: 'chat', title: sessionId, data: { sessionId } },
    ],
    activeCenterTabId: `chat-${sessionId}`,
  })
}

describe('notifyMessage: правило «unread ⇒ требует действия»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    useNotificationStore.setState({
      history: [],
      sessionUnread: {},
      suppressedUnread: {},
      actionNotified: {},
    })
  })

  it('requiresAction: true в неоткрытой сессии — тост, история и unread', () => {
    notifyMessage({
      text: 'Требуется подтверждение: write_file',
      type: 'info',
      category: 'system',
      sessionId: 's1',
      requiresAction: true,
    })

    expect(toastMocks.info).toHaveBeenCalledTimes(1)
    expect(useNotificationStore.getState().history).toHaveLength(1)
    expect(useNotificationStore.getState().history[0]!.requiresAction).toBe(true)
    expect(unread('s1')).toBe(1)
  })

  it('без requiresAction — тост и история есть, unread НЕ растёт', () => {
    notifyMessage({
      text: 'Фоновый процесс завершён: npm test',
      type: 'success',
      category: 'system',
      sessionId: 's1',
    })

    expect(toastMocks.success).toHaveBeenCalledTimes(1)
    expect(useNotificationStore.getState().history).toHaveLength(1)
    expect(useNotificationStore.getState().history[0]!.requiresAction).toBe(false)
    expect(unread('s1')).toBe(0)
  })

  it('requiresAction: false явно — unread НЕ растёт', () => {
    notifyMessage({
      text: 'Провайдер недоступен',
      type: 'error',
      category: 'error',
      sessionId: 's1',
      requiresAction: false,
    })

    expect(unread('s1')).toBe(0)
  })

  it('открытая сессия — unread не растёт даже при requiresAction', () => {
    openSessionInActiveTab('s1')

    notifyMessage({
      text: 'Агент ждёт ответа: Выбор',
      type: 'info',
      category: 'system',
      sessionId: 's1',
      requiresAction: true,
    })

    expect(unread('s1')).toBe(0)
  })

  it('подавленная сессия («Спросить агента») — unread не растёт', () => {
    useNotificationStore.getState().suppressUnread('s1', true)

    notifyMessage({
      text: 'Агент ждёт ответа: Выбор',
      type: 'info',
      category: 'system',
      sessionId: 's1',
      requiresAction: true,
    })

    expect(unread('s1')).toBe(0)
  })

  it('без sessionId unread не считается', () => {
    notifyMessage({ text: 'Нет связи', type: 'error', category: 'connection' })

    expect(useNotificationStore.getState().history).toHaveLength(1)
    expect(useNotificationStore.getState().sessionUnread).toEqual({})
  })
})

describe('notifyPendingActionSessions: сводный тост по списку сессий', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    useNotificationStore.setState({
      history: [],
      sessionUnread: {},
      suppressedUnread: {},
      actionNotified: {},
    })
  })

  it('один тост на сессию, повторный вызов не дублирует', () => {
    const sessions = [{ id: 's1', pending_approvals: 3 }]

    notifyPendingActionSessions(sessions)
    notifyPendingActionSessions(sessions)

    expect(useNotificationStore.getState().history).toHaveLength(1)
    expect(unread('s1')).toBe(1)
  })

  it('ожидание снято — метка сброшена и новое ожидание снова уведомляет', () => {
    notifyPendingActionSessions([{ id: 's1', pending_approvals: 1 }])
    notifyPendingActionSessions([{ id: 's1', pending_approvals: 0 }])

    expect(useNotificationStore.getState().actionNotified['s1']).toBeUndefined()

    notifyPendingActionSessions([{ id: 's1', pending_approvals: 1 }])
    expect(useNotificationStore.getState().history).toHaveLength(2)
  })

  it('активная сессия не уведомляется и метку не ставит', () => {
    openSessionInActiveTab('s1')

    notifyPendingActionSessions([{ id: 's1', pending_approvals: 1 }])

    expect(useNotificationStore.getState().history).toHaveLength(0)
    expect(useNotificationStore.getState().actionNotified['s1']).toBeUndefined()
  })

  it('queue_stopped без pending_approvals — тоже «требуется действие»', () => {
    notifyPendingActionSessions([{ id: 's1', status: { queue_stopped: true } }])

    expect(useNotificationStore.getState().history[0]).toMatchObject({
      requiresAction: true,
      sessionId: 's1',
    })
    expect(unread('s1')).toBe(1)
  })
})
