import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте стора, а Node/vitest без
// --localstorage-file его не даёт — ставим заглушку до импорта useUIStore.
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

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useQuestionStore, pendingFor } from './questionStore'
import { useUIStore } from './useUIStore'
import { notifyMessage } from '@/hooks/useNotification'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

const QUESTIONS = [
  {
    question: 'Какой вариант?',
    header: 'Выбор',
    options: [{ value: 'a', label: 'A' }],
  },
]

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

describe('transportStore dispatcher: user_question.* (вопросы пользователю)', () => {
  beforeEach(() => {
    useQuestionStore.setState({ bySession: {} })
    vi.clearAllMocks()
    closeActiveTab()
  })

  it('user_question.asked — добавляет pending-запись вопроса в стор', () => {
    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      questions: QUESTIONS,
      agent_role: 'assistant',
    }))

    const records = useQuestionStore.getState().bySession['s1']!
    expect(records).toHaveLength(1)
    expect(records[0]!.id).toBe('qst_1')
    expect(records[0]!.status).toBe('pending')
    expect(records[0]!.sessionId).toBe('s1')
    expect(records[0]!.questions).toHaveLength(1)
    expect(records[0]!.agentRole).toBe('assistant')
    expect(pendingFor('s1')).toHaveLength(1)
  })

  it('user_question.asked с полной записью в payload — использует её', () => {
    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_2',
      session_id: 's1',
      question: {
        id: 'qst_2',
        sessionId: 's1',
        status: 'pending',
        questions: QUESTIONS,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }))

    const records = useQuestionStore.getState().bySession['s1']!
    expect(records[0]!.id).toBe('qst_2')
    expect(records[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('user_question.asked без question_id — запись не создаётся', () => {
    dispatch(makeEvent('user_question.asked', 's1', { session_id: 's1', questions: QUESTIONS }))

    expect(useQuestionStore.getState().bySession['s1']).toBeUndefined()
  })

  it('user_question.answered — убирает вопрос из pending', () => {
    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      questions: QUESTIONS,
    }))
    dispatch(makeEvent('user_question.answered', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      answers: [['a']],
    }))

    expect(pendingFor('s1')).toHaveLength(0)
    expect(useQuestionStore.getState().bySession['s1']).toBeUndefined()
  })

  it('user_question.cancelled — убирает вопрос из pending', () => {
    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      questions: QUESTIONS,
    }))
    dispatch(makeEvent('user_question.cancelled', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      reason: 'timeout',
    }))

    expect(pendingFor('s1')).toHaveLength(0)
  })

  it('старое question.asked (очередь зависла) не трогает вопросы', () => {
    dispatch(makeEvent('question.asked', 's1', { session_id: 's1', pending_count: 3 }))

    expect(useQuestionStore.getState().bySession['s1']).toBeUndefined()
  })
})

describe('transportStore dispatcher: уведомление о вопросе (ADR-112)', () => {
  beforeEach(() => {
    useQuestionStore.setState({ bySession: {} })
    vi.clearAllMocks()
    closeActiveTab()
  })

  it('неактивная сессия — тост вызван, вопрос попал в стор', () => {
    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      questions: QUESTIONS,
    }))

    expect(notifyMessage).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(notifyMessage).mock.calls[0]![0]
    expect(opts.type).toBe('info')
    expect(opts.category).toBe('system')
    expect(opts.sessionId).toBe('s1')
    expect(opts.text).toContain('Выбор')

    expect(pendingFor('s1')).toHaveLength(1)
  })

  it('активная сессия — тост не вызван, вопрос всё равно попал в стор', () => {
    openSessionInActiveTab('s1')

    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      questions: QUESTIONS,
    }))

    expect(notifyMessage).not.toHaveBeenCalled()
    expect(pendingFor('s1')).toHaveLength(1)
  })

  it('без header у вопроса — в уведомлении fallback «question»', () => {
    dispatch(makeEvent('user_question.asked', 's1', {
      question_id: 'qst_1',
      session_id: 's1',
      questions: [{ question: 'Что делать?', options: [{ value: 'a', label: 'A' }] }],
    }))

    expect(notifyMessage).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(notifyMessage).mock.calls[0]![0]
    expect(opts.text).toContain('question')
  })
})
