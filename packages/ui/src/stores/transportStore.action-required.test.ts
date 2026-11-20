import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте сторов, а Node/vitest
// без --localstorage-file его не даёт — ставим заглушку до импорта.
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

// Всплывающие окна: `notifyMessage` настоящий (важно для счётчиков), toast — мок.
vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// Сеть диспетчеру не нужна: события приходят кадром, но ветки фоновой работы
// перечитывают снимки — отдаём пустые ответы.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
    listProcesses: vi.fn().mockResolvedValue([]),
    listProcessesWithBlocking: vi.fn().mockResolvedValue({ runs: [], blocking: [] }),
  },
}))

import { createDispatcher } from './transportStore'
import { useNotificationStore } from './notificationStore'
import { useUIStore } from './useUIStore'
import { useQuestionStore } from './questionStore'
import { usePermissionStore } from './permissionStore'
import { useProcessesStore } from './processesStore'
import { useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Сессия открыта в активной центральной вкладке. */
function openSessionInActiveTab(sessionId: string): void {
  useUIStore.setState({
    centerTabs: [
      { id: `chat-${sessionId}`, type: 'chat', title: sessionId, data: { sessionId } },
    ],
    activeCenterTabId: `chat-${sessionId}`,
  })
}

/** Активной вкладки с сессией нет (сессия свёрнута/не открыта). */
function closeActiveTab(): void {
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
}

function history() {
  return useNotificationStore.getState().history
}

function unread(sessionId: string): number {
  return useNotificationStore.getState().sessionUnread[sessionId] ?? 0
}

describe('transportStore: «unread ⇒ требует действия» (permission.asked)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeActiveTab()
    useNotificationStore.setState({
      history: [],
      sessionUnread: {},
      suppressedUnread: {},
      actionNotified: {},
    })
    usePermissionStore.setState({ requestsBySession: {} })
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('неактивная сессия — тост «Требуется подтверждение» и unread', () => {
    dispatch(makeEvent('permission.asked', 's-perm-inactive', {
      approval_id: 'ap_1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt' },
      reason: 'правило file.* → ask',
    }))

    expect(history()).toHaveLength(1)
    expect(history()[0]).toMatchObject({
      text: 'Требуется подтверждение: write_file',
      type: 'info',
      category: 'system',
      sessionId: 's-perm-inactive',
      requiresAction: true,
    })
    // Оранжевый цвет названия в дереве = «требуется действие».
    expect(unread('s-perm-inactive')).toBe(1)
    // Карточка подтверждения в живом сторе — как и раньше.
    expect(usePermissionStore.getState().requestsBySession['s-perm-inactive']).toHaveLength(1)
  })

  it('активная сессия — тоста нет и unread не растёт', () => {
    openSessionInActiveTab('s-perm-active')

    dispatch(makeEvent('permission.asked', 's-perm-active', {
      approval_id: 'ap_1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt' },
    }))

    expect(history()).toHaveLength(0)
    expect(unread('s-perm-active')).toBe(0)
    expect(usePermissionStore.getState().requestsBySession['s-perm-active']).toHaveLength(1)
  })

  it('execute_shell — в тексте короткий префикс команды', () => {
    dispatch(makeEvent('permission.asked', 's-perm-shell', {
      approval_id: 'ap_1',
      tool: 'execute_shell',
      arguments: { command: 'npm run build' },
      commands: ['npm run build'],
    }))

    expect(history()[0]!.text).toBe('Требуется подтверждение: execute_shell: npm run build')
    expect(unread('s-perm-shell')).toBe(1)
  })

  it('execute_shell — переносы строк схлопываются, длинное обрезается', () => {
    const long = `npm run build\n\necho ${'x'.repeat(120)}`
    dispatch(makeEvent('permission.asked', 's-perm-shell-long', {
      approval_id: 'ap_1',
      tool: 'execute_shell',
      arguments: { command: long },
      commands: [long],
    }))

    const text = history()[0]!.text
    expect(text.startsWith('Требуется подтверждение: execute_shell: npm run build echo ')).toBe(true)
    expect(text).not.toContain('\n')
    // «Требуется подтверждение: » (23 символа) + tool + ': ' + 60 символов команды.
    const command = text.slice('Требуется подтверждение: execute_shell: '.length)
    expect(command).toHaveLength(60)
    expect(command.endsWith('…')).toBe(true)
  })

  it('execute_shell — команда, похожая на секрет, в тост не выводится', () => {
    dispatch(makeEvent('permission.asked', 's-perm-secret', {
      approval_id: 'ap_1',
      tool: 'execute_shell',
      arguments: { command: 'curl -H "authorization: Bearer abcdef"' },
      commands: ['curl -H "authorization: Bearer abcdef"'],
    }))

    expect(history()[0]!.text).toBe('Требуется подтверждение: execute_shell')
  })

  it('дедуп: два permission.asked подряд — один тост; после 11 с второй проходит', () => {
    vi.useFakeTimers()

    dispatch(makeEvent('permission.asked', 's-perm-dedup', {
      approval_id: 'ap_1',
      tool: 'write_file',
      arguments: { file_path: 'a.txt' },
    }))
    dispatch(makeEvent('permission.asked', 's-perm-dedup', {
      approval_id: 'ap_2',
      tool: 'execute_shell',
      arguments: { command: 'ls' },
      commands: ['ls'],
    }))

    expect(history()).toHaveLength(1)
    expect(usePermissionStore.getState().requestsBySession['s-perm-dedup']).toHaveLength(2)
    expect(unread('s-perm-dedup')).toBe(1)

    vi.advanceTimersByTime(11_000)

    dispatch(makeEvent('permission.asked', 's-perm-dedup', {
      approval_id: 'ap_3',
      tool: 'read_file',
      arguments: { file_path: 'a.txt' },
    }))

    expect(history()).toHaveLength(2)
    expect(unread('s-perm-dedup')).toBe(2)
  })

  it('permission.replied тост не повторяет и метку дедупа не сбрасывает', () => {
    vi.useFakeTimers()

    dispatch(makeEvent('permission.asked', 's-perm-reply', {
      approval_id: 'ap_1',
      tool: 'write_file',
    }))
    dispatch(makeEvent('permission.replied', 's-perm-reply', { approval_id: 'ap_1' }))
    dispatch(makeEvent('permission.asked', 's-perm-reply', {
      approval_id: 'ap_2',
      tool: 'write_file',
    }))

    expect(history()).toHaveLength(1)
  })
})

describe('transportStore: фоновые прогоны — «просто тост» (регресс)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeActiveTab()
    useNotificationStore.setState({
      history: [],
      sessionUnread: {},
      suppressedUnread: {},
      actionNotified: {},
    })
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
    useProcessesStore.setState({
      byId: {},
      order: [],
      blocking: [],
      blockingLoaded: false,
      blockingScope: null,
      blockingScopeKey: null,
      blockingKnownIds: [],
      logs: {},
      pendingIds: [],
      error: null,
    })
  })

  it('child.completed — тост и история есть, unread НЕ растёт', () => {
    dispatch(makeEvent('child.completed', 's-bg-child', {
      background_run_id: 'bgr_c1',
      child_session_id: 'child-1',
      parent_session_id: 's-bg-child',
      description: 'аудит',
    }))

    expect(history()).toHaveLength(1)
    expect(history()[0]).toMatchObject({
      text: 'Фоновый саб-агент завершён: аудит',
      requiresAction: false,
      sessionId: 's-bg-child',
    })
    expect(unread('s-bg-child')).toBe(0)
  })

  it('process.exited (completed) — unread НЕ растёт', () => {
    dispatch(makeEvent('process.started', 's-bg-proc', {
      background_run_id: 'bgr_p1',
      session_id: 's-bg-proc',
      command: 'npm test',
    }))
    dispatch(makeEvent('process.exited', 's-bg-proc', {
      background_run_id: 'bgr_p1',
      session_id: 's-bg-proc',
      state: 'completed',
      exit_code: 0,
    }))

    expect(history()).toHaveLength(2)
    expect(history()[0]!.requiresAction).toBe(false)
    expect(unread('s-bg-proc')).toBe(0)
  })

  it('терминальная ошибка хода — тост остаётся, unread не растёт', () => {
    dispatch(makeEvent('stream.error', 's-bg-error', {
      stream_id: 'str_1',
      error: 'Провайдер недоступен',
      error_type: 'provider',
      can_retry: false,
    }))

    expect(history()).toHaveLength(1)
    expect(history()[0]).toMatchObject({ text: 'Провайдер недоступен', requiresAction: false })
    expect(unread('s-bg-error')).toBe(0)
  })
})

describe('transportStore: вопрос агента требует действия', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeActiveTab()
    useNotificationStore.setState({
      history: [],
      sessionUnread: {},
      suppressedUnread: {},
      actionNotified: {},
    })
    useQuestionStore.setState({ bySession: {} })
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('user_question.asked в неактивной сессии — requiresAction и unread', () => {
    dispatch(makeEvent('user_question.asked', 's-question', {
      question_id: 'qst_1',
      questions: [{ question: 'Какой вариант?', header: 'Выбор' }],
    }))

    expect(history()[0]).toMatchObject({ requiresAction: true, sessionId: 's-question' })
    expect(unread('s-question')).toBe(1)
  })

  it('suppressedUnread («Спросить агента») по-прежнему подавляет unread', () => {
    useNotificationStore.getState().suppressUnread('s-question-suppressed', true)

    dispatch(makeEvent('user_question.asked', 's-question-suppressed', {
      question_id: 'qst_1',
      questions: [{ question: 'Какой вариант?', header: 'Выбор' }],
    }))

    expect(history()).toHaveLength(1)
    expect(unread('s-question-suppressed')).toBe(0)
  })
})
