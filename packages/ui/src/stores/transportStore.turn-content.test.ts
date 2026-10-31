/**
 * ADR-118 §5: признак «контент хода уже был» и живые события хода.
 *
 * Регрессии, которые закрывает набор:
 * - вызов инструмента — тоже контент хода: шаг «только вызовы инструментов»
 *   иначе не поднимает флаг, и ни строка активности хода, ни индикатор в
 *   живом сегменте не включаются;
 * - `stream.start` не разрушает живой ход (восстановленный после перезагрузки):
 *   границы хода и `contentStarted` не теряются;
 * - `message.accepted` для режимов `steer`/`interrupt` не заводит строку
 *   очереди — реплика уже показана в ленте (оптимистичная вставка), строка
 *   очереди была бы дублем.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher, restoreLiveTurnFromSession } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const SESSION = 's1'

function event(type: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: SESSION, data }
}

function turn() {
  return useChatStore.getState().turnBySession[SESSION]
}

function message(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: 'm1',
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00Z',
    ...partial,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore: контент хода (ADR-118 §5)', () => {
  it('вызов инструмента помечает ход как начавшийся', () => {
    dispatch(event('stream.start', { stream_id: 'stream-1' }))
    dispatch(event('turn.started', { turnId: 'turn-1' }))
    dispatch(event('step.started', { turnId: 'turn-1', messageId: 'a-1', stepIndex: 0 }))
    expect(turn()?.contentStarted).toBe(false)

    dispatch(event('tool_call.started', {
      turnId: 'turn-1',
      messageId: 'a-1',
      call_id: 'call-1',
      name: 'execute_shell',
      arguments: { command: 'ls' },
    }))

    expect(turn()?.contentStarted).toBe(true)
  })

  it('stream.start не разрушает восстановленный живой ход', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming',
        content: 'Ответ',
      }),
    ])
    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: { turn_id: 'turn-1', stream_id: 'stream-1' },
    })
    expect(turn()).toMatchObject({ turnId: 'turn-1', contentStarted: true })

    dispatch(event('stream.start', { stream_id: 'stream-1', agent_role: 'leader', model: 'gpt-x' }))

    // Границы хода и признак «контент уже был» — на месте; агент/модель
    // дописаны из события.
    expect(turn()).toMatchObject({
      turnId: 'turn-1',
      streamId: 'stream-1',
      status: 'streaming',
      contentStarted: true,
      agentRole: 'leader',
      model: 'gpt-x',
    })
  })

  it('новый ход после завершённого — ход заводится заново (контент не наследуется)', () => {
    dispatch(event('stream.start', { stream_id: 'stream-1' }))
    dispatch(event('turn.started', { turnId: 'turn-1' }))
    dispatch(event('turn.finished', { turnId: 'turn-1', status: 'completed' }))
    expect(turn()?.status).toBe('completed')

    dispatch(event('stream.start', { stream_id: 'stream-2' }))

    expect(turn()).toMatchObject({
      turnId: 'stream-2',
      status: 'streaming',
      contentStarted: false,
    })
  })
})

describe('transportStore: message.accepted и режим приёма (ADR-118 §4)', () => {
  it('steer: строка очереди не заводится (реплика уже показана в ленте)', () => {
    dispatch(event('message.accepted', { messageId: 'm1', mode: 'steer', position: null }))

    expect(useChatStore.getState().pendingBySession[SESSION]).toBeUndefined()
  })

  it('interrupt: строка очереди не заводится', () => {
    dispatch(event('message.accepted', { messageId: 'm1', mode: 'interrupt', position: null }))

    expect(useChatStore.getState().pendingBySession[SESSION]).toBeUndefined()
  })

  it('queue: строка очереди заводится (как раньше)', () => {
    dispatch(event('message.accepted', { messageId: 'm1', mode: 'queue', position: 1 }))

    expect(useChatStore.getState().pendingBySession[SESSION]).toHaveLength(1)
  })
})
