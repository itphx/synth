/**
 * ADR-118 §5: восстановление хода после reload — ход, уже восстановленный по
 * истории, **дополняется** данными сессии (`current_stream`).
 *
 * Без дополнения терялся `stream_id` (по нему сопоставляется статус
 * автоповтора `stream.retry` — плашка «повтор» не появлялась), а также
 * агент/модель/шаг хода и признак «контент уже был».
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { restoreLiveTurnFromHistory, restoreLiveTurnFromSession } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'

const SESSION = 's1'

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

const HISTORY = [
  message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
  message({
    id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming',
    content: 'Шаг ответа', model: 'gpt', provider: 'itphx', agent_role: 'leader',
  }),
]

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('восстановление хода: дополнение уже восстановленного хода', () => {
  it('stream_id из current_stream дописывается в ход, восстановленный по истории', () => {
    useChatStore.getState().setMessages(SESSION, HISTORY)
    restoreLiveTurnFromHistory(SESSION, HISTORY)

    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: { turn_id: 'turn-1', stream_id: 'stream-1', agent_role: 'leader' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      streamId: 'stream-1',
      agentRole: 'leader',
      status: 'streaming',
    })
  })

  it('непустые значения хода не перетираются, contentStarted не сбрасывается', () => {
    useChatStore.getState().startTurn(SESSION, {
      turnId: 'turn-live',
      streamId: 'stream-old',
      agentRole: 'fixer',
      model: 'model-1',
      provider: 'provider-1',
      messageId: 'm-live',
      stepIndex: 2,
      status: 'streaming',
      contentStarted: true,
    })

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { turn_id: 'turn-stale', stream_id: 'stream-new', agent_role: 'leader' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-live',
      streamId: 'stream-old',
      agentRole: 'fixer',
      model: 'model-1',
      provider: 'provider-1',
      messageId: 'm-live',
      stepIndex: 2,
      contentStarted: true,
      status: 'streaming',
    })
  })

  it('пустые поля хода дополняются: messageId/stepIndex по streaming-шагу', () => {
    useChatStore.getState().setMessages(SESSION, HISTORY)
    useChatStore.getState().startTurn(SESSION, { turnId: 'turn-1', status: 'streaming' })

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { turn_id: 'turn-1', stream_id: 'stream-1' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      messageId: 'm-step',
      stepIndex: 0,
      streamId: 'stream-1',
      // Контент хода по истории уже был — флаг выставляется.
      contentStarted: true,
    })
  })

  it('пустой шаг — contentStarted остаётся false', () => {
    const empty = [
      message({ id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'streaming', content: '', parts: [] }),
    ]
    useChatStore.getState().setMessages(SESSION, empty)
    useChatStore.getState().startTurn(SESSION, { turnId: 'turn-1', status: 'streaming' })

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { turn_id: 'turn-1', stream_id: 'stream-1' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      streamId: 'stream-1',
    })
    // Контента хода не было — флаг не выставляется (и не сбрасывается в false).
    expect(useChatStore.getState().turnBySession[SESSION]?.contentStarted).not.toBe(true)
  })
})
