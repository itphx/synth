import { describe, it, expect, beforeEach, vi } from 'vitest'

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 'parent', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import { useSessionsStore } from './sessionsStore'
import { synthApi } from '@/lib/api/synthApi'
import { notifyMessage } from '@/hooks/useNotification'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore dispatcher: subagent.retry (B5)', () => {
  it('событие в родительской сессии → состояние привязано к callId тула task', () => {
    dispatch(makeEvent('subagent.retry', 'parent', {
      stream_id: 'st1',
      session_id: 'parent',
      child_session_id: 'child',
      parent_call_id: 'call-1',
      attempt: 2,
      max_retries: 3,
      retry_in: 15000,
      error_type: 'rate_limit',
      error: '429',
    }))

    const st = useChatStore.getState().subagentRetryBySession['parent']
    expect(st).not.toBeNull()
    expect(st!.callId).toBe('call-1')
    expect(st!.childSessionId).toBe('child')
    expect(st!.attempt).toBe(2)
    expect(st!.maxRetries).toBe(3)
    expect(st!.retryInMs).toBe(15000)
    expect(st!.errorType).toBe('rate_limit')
  })

  it('событие в дочерней сессии при resume (без parent_call_id) → callId undefined', () => {
    dispatch(makeEvent('subagent.retry', 'child', {
      stream_id: 'st-resume',
      session_id: 'child',
      child_session_id: 'child',
      attempt: 1,
      max_retries: 3,
      retry_in: 5000,
      error_type: 'network',
    }))

    const st = useChatStore.getState().subagentRetryBySession['child']
    expect(st).not.toBeNull()
    expect(st!.callId).toBeUndefined()
    expect(st!.childSessionId).toBe('child')
  })

  it('tool_call.result для того же callId снимает статус ретрая', () => {
    dispatch(makeEvent('subagent.retry', 'parent', {
      parent_call_id: 'call-1', attempt: 1, max_retries: 3, retry_in: 5000,
    }))
    expect(useChatStore.getState().subagentRetryBySession['parent']).not.toBeNull()

    dispatch(makeEvent('tool_call.result', 'parent', {
      stream_id: 'st1',
      call_id: 'call-1',
      result: { content: '<task_result>...</task_result>', isError: true },
    }))
    expect(useChatStore.getState().subagentRetryBySession['parent']).toBeNull()
  })

  it('tool_call.result другого тула не снимает статус ретрая', () => {
    dispatch(makeEvent('subagent.retry', 'parent', {
      parent_call_id: 'call-1', attempt: 1, max_retries: 3, retry_in: 5000,
    }))

    dispatch(makeEvent('tool_call.result', 'parent', {
      stream_id: 'st1',
      call_id: 'call-other',
      result: { content: 'ok' },
    }))
    expect(useChatStore.getState().subagentRetryBySession['parent']).not.toBeNull()
  })
})

describe('transportStore dispatcher: subagent.resume.started/finished (B5)', () => {
  it('started → состояние «возобновление идёт» в родительской и дочерней сессиях', () => {
    dispatch(makeEvent('subagent.resume.started', 'parent', {
      child_session_id: 'child',
      parent_session_id: 'parent',
      stream_id: 'st-resume',
    }))

    const parent = useChatStore.getState().subagentResumingBySession['parent']
    const child = useChatStore.getState().subagentResumingBySession['child']
    expect(parent).toEqual({ childSessionId: 'child', parentSessionId: 'parent', streamId: 'st-resume' })
    expect(child).toEqual({ childSessionId: 'child', parentSessionId: 'parent', streamId: 'st-resume' })
  })

  it('finished → состояние снято, родительская сессия обновлена с сервера', async () => {
    dispatch(makeEvent('subagent.resume.started', 'parent', {
      child_session_id: 'child', parent_session_id: 'parent', stream_id: 'st-resume',
    }))
    expect(useChatStore.getState().subagentResumingBySession['parent']).not.toBeNull()

    dispatch(makeEvent('subagent.resume.finished', 'parent', {
      child_session_id: 'child',
      parent_session_id: 'parent',
      stream_id: 'st-resume',
      status: 'completed',
    }))

    expect(useChatStore.getState().subagentResumingBySession['parent']).toBeNull()
    expect(useChatStore.getState().subagentResumingBySession['child']).toBeNull()
    // refresh родителя: getSession вызван
    await vi.waitFor(() => {
      expect(synthApi.getSession).toHaveBeenCalledWith('parent')
    })
  })
})

describe('transportStore dispatcher: stream.error → финальная ошибка для плашки (B6)', () => {
  it('can_retry:false → finalError записан + toast отправлен', () => {
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st1',
      error: 'provider exploded',
      error_type: 'server_error',
      can_retry: false,
    }))

    const fe = useChatStore.getState().finalErrorBySession['s1']
    expect(fe).toEqual({ streamId: 'st1', error: 'provider exploded', errorType: 'server_error' })
    expect(notifyMessage).toHaveBeenCalled()
  })

  it('message_id/turn_id (snake_case) сохраняются в finalError', () => {
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st1',
      error: 'boom',
      error_type: 'network_error',
      can_retry: false,
      message_id: 'u-1',
      turn_id: 't-1',
    }))

    expect(useChatStore.getState().finalErrorBySession['s1']).toMatchObject({
      messageId: 'u-1',
      turnId: 't-1',
    })
  })

  it('camelCase-дубли messageId/turnId тоже читаются (fallback через ||)', () => {
    // `asNonEmptyString` возвращает '' (а не null) — fallback обязан быть `||`.
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st2',
      error: 'boom',
      error_type: 'network_error',
      can_retry: false,
      messageId: 'u-2',
      turnId: 't-2',
    }))

    expect(useChatStore.getState().finalErrorBySession['s1']).toMatchObject({
      messageId: 'u-2',
      turnId: 't-2',
    })
  })

  it('can_retry:true → плашки нет (бэкенд продолжит ретраи)', () => {
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st1', error: 'boom', error_type: 'network', can_retry: true,
    }))
    expect(useChatStore.getState().finalErrorBySession['s1']).toBeUndefined()
  })

  it('новый turn.started сбрасывает финальную ошибку', () => {
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st1', error: 'boom', error_type: 'server_error', can_retry: false,
    }))
    expect(useChatStore.getState().finalErrorBySession['s1']).not.toBeNull()

    dispatch(makeEvent('turn.started', 's1', { turnId: 't2', messageId: 'm-user' }))
    expect(useChatStore.getState().finalErrorBySession['s1']).toBeNull()
  })

  it('part.delta сбрасывает финальную ошибку', () => {
    dispatch(makeEvent('stream.error', 's1', {
      stream_id: 'st1', error: 'boom', error_type: 'timeout', can_retry: false,
    }))

    dispatch(makeEvent('step.started', 's1', { turnId: 't2', stepIndex: 0, messageId: 'm2' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm2', partId: 'msg:text:0', field: 'text', delta: 'x' }))
    expect(useChatStore.getState().finalErrorBySession['s1']).toBeNull()
  })
})

describe('transportStore dispatcher: tool_call.started → вызов виден в ходе (ADR-118 §1)', () => {
  it('step.started + tool_call.started создают live-часть tool_use', () => {
    dispatch(makeEvent('turn.started', 's1', { turnId: 't1', messageId: 'm-user' }))
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', agentRole: 'fixer' }))
    dispatch(makeEvent('tool_call.started', 's1', {
      call_id: 'call-1',
      name: 'read_file',
      arguments: { path: 'a.ts' },
      iteration: 0,
    }))

    const parts = useChatStore.getState().partsBySession['s1']!['m1']!
    expect(parts['call-1']).toMatchObject({ id: 'call-1', type: 'tool_use' })
    expect(parts['call-1']!.data).toMatchObject({ name: 'read_file', status: 'running' })

    // Результат приходит отдельным событием и патчит ту же часть.
    dispatch(makeEvent('tool_call.result', 's1', {
      call_id: 'call-1',
      result: { content: 'ok' },
    }))
    expect(useChatStore.getState().partsBySession['s1']!['m1']!['call-1']!.data).toMatchObject({
      status: 'done',
      result: { content: 'ok' },
    })
  })
})

describe('transportStore dispatcher: session.created origin (гибрид)', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [] })
  })

  it('локальное событие без origin → в стор попадает origin local', () => {
    dispatch(makeEvent('session.created', 'ses-local', {
      id: 'ses-local',
      name: 'Локальная',
    }))
    const created = useSessionsStore.getState().sessions.find((s) => s.id === 'ses-local')
    expect(created?.origin).toBe('local')
  })

  it('remote-событие моста (id remote:<...>, без origin) → в стор origin remote', () => {
    dispatch(makeEvent('session.created', 'remote:ses-1', {
      id: 'remote:ses-1',
      name: 'Удалённая',
    }))
    const created = useSessionsStore.getState().sessions.find((s) => s.id === 'remote:ses-1')
    expect(created?.origin).toBe('remote')
  })

  it('origin из payload не перетирается', () => {
    dispatch(makeEvent('session.created', 'remote:ses-2', {
      id: 'remote:ses-2',
      origin: 'remote',
    }))
    const created = useSessionsStore.getState().sessions.find((s) => s.id === 'remote:ses-2')
    expect(created?.origin).toBe('remote')
  })
})
