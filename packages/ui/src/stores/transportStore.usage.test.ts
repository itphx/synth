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
import type { MessageData } from './chatStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

function makeAssistantMessage(streamId: string): MessageData {
  return {
    index: 3,
    role: 'assistant',
    content: 'partial',
    metadata: { stream_id: streamId },
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore dispatcher: stream.usage (AD-070 §2.6)', () => {
  it('маппит usage camelCase → snake_case и прокидывает cost/model/provider/estimated', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1', model: 'gpt', provider: 'openai' }))
    dispatch(makeEvent('stream.usage', 's1', {
      stream_id: 'st1',
      iteration: 2,
      usage: {
        inputTokens: 1_700_000,
        outputTokens: 33_300,
        totalTokens: 1_733_300,
        cacheReadTokens: 1_581_000,
        cacheWriteTokens: 0,
        reasoningTokens: 120,
      },
      cost_usd: 0.03,
      cost_currency: 'RUB',
      cost_breakdown: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
      estimated: false,
      model: 'gpt-x',
      provider: 'openai',
    }))

    const st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.usage).toEqual({
      input_tokens: 1_700_000,
      output_tokens: 33_300,
      total_tokens: 1_733_300,
      cache_read_tokens: 1_581_000,
      cache_write_tokens: 0,
      reasoning_tokens: 120,
    })
    expect(st.costUsd).toBe(0.03)
    expect(st.costCurrency).toBe('RUB')
    expect(st.costBreakdown).toEqual({ input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 })
    expect(st.usageEstimated).toBe(false)
    expect(st.model).toBe('gpt-x')
    expect(st.provider).toBe('openai')
  })

  it('stream_usage (snake-имя события) обрабатывается так же', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1' }))
    dispatch(makeEvent('stream_usage', 's1', {
      stream_id: 'st1',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      estimated: true,
    }))

    const st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.usage).toEqual({ input_tokens: 5, output_tokens: 3, total_tokens: 8 })
    expect(st.usageEstimated).toBe(true)
  })

  it('без stream_id — no-op', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1' }))
    dispatch(makeEvent('stream.usage', 's1', {
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    }))
    expect(useChatStore.getState().streamingBySession['s1']!['st1']!.usage).toBeUndefined()
  })

  it('дочерняя сессия: stream.usage обновляет streamingBySession[childSessionId]', () => {
    dispatch(makeEvent('stream.start', 'child', { stream_id: 'st-child', agent_role: 'researcher' }))
    dispatch(makeEvent('stream.usage', 'child', {
      stream_id: 'st-child',
      session_id: 'child',
      iteration: 1,
      usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
      estimated: false,
      model: 'sub-model',
    }))

    const st = useChatStore.getState().streamingBySession['child']!['st-child']!
    expect(st.usage).toEqual({ input_tokens: 200, output_tokens: 40, total_tokens: 240 })
    expect(st.model).toBe('sub-model')
  })

  it('дочерняя сессия: stream.usage без stream.start создаёт live-состояние', () => {
    // Bug 2: task.ts публикует в child только stream.usage — stream.start нет.
    dispatch(makeEvent('stream.usage', 'child', {
      stream_id: 'st-parent',
      session_id: 'child',
      iteration: 0,
      agent_role: 'explore',
      usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
      cost_usd: 0.005,
      estimated: false,
      model: 'sub-model',
    }))

    const st = useChatStore.getState().streamingBySession['child']!['st-parent']!
    expect(st).toBeDefined()
    expect(st.isStreaming).toBe(true)
    expect(st.hasContent).toBe(false)
    expect(st.agentRole).toBe('explore')
    expect(st.usage).toEqual({ input_tokens: 300, output_tokens: 50, total_tokens: 350 })
    expect(st.costUsd).toBe(0.005)
  })

  it('stream.ended снимает usage-only live и не создаёт фантомных сообщений', () => {
    dispatch(makeEvent('stream.usage', 'child', {
      stream_id: 'st-parent',
      session_id: 'child',
      agent_role: 'explore',
      usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
    }))
    // Финальное сообщение ребёнка сохраняется отдельно (реальный вложенный payload).
    dispatch(makeEvent('message.added', 'child', {
      session_id: 'child',
      message: {
        index: 0,
        role: 'assistant',
        content: 'sub answer',
        usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 },
        metadata: { stream_id: 'st-parent' },
      },
      index: 0,
    }))

    dispatch(makeEvent('stream.ended', 'child', { stream_id: 'st-parent' }))

    expect(useChatStore.getState().streamingBySession['child']?.['st-parent']).toBeUndefined()
    // Ровно одно реальное сообщение ребёнка — без фантома (index: undefined) и дублей.
    const msgs = useChatStore.getState().messagesBySession['child']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.index).toBe(0)
    expect(msgs[0]!.content).toBe('sub answer')
    expect(msgs[0]!.usage).toEqual({ input_tokens: 300, output_tokens: 50, total_tokens: 350 })
  })

  it('финальное message.added ребёнка (с usage) переносит usage и снимает live', () => {
    dispatch(makeEvent('stream.usage', 'child', {
      stream_id: 'st-parent',
      session_id: 'child',
      agent_role: 'explore',
      usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
    }))
    dispatch(makeEvent('message.added', 'child', {
      session_id: 'child',
      message: {
        index: 0,
        role: 'assistant',
        content: 'sub answer',
        metadata: { stream_id: 'st-parent', duration_ms: 900 },
        usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 },
      },
      index: 0,
    }))

    const msg = useChatStore.getState().messagesBySession['child']![0]!
    expect(msg.usage).toEqual({ input_tokens: 300, output_tokens: 50, total_tokens: 350 })
    expect(useChatStore.getState().streamingBySession['child']?.['st-parent']).toBeUndefined()
  })
})

describe('transportStore dispatcher: stream.done с финальной статистикой (AD-070 §2.6, Bug 1)', () => {
  it('маппит top-level cost_usd/duration_ms/usage_estimated/cost_breakdown/provider в metadata', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1' }))
    useChatStore.setState({
      messagesBySession: {
        s1: [{
          index: 3,
          role: 'assistant',
          content: 'final',
          metadata: { stream_id: 'st1' },
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: '2026-09-19T00:00:00Z',
        }],
      },
    })

    dispatch(makeEvent('stream.done', 's1', {
      stream_id: 'st1',
      content: 'final',
      message_index: 3,
      status: 'completed',
      provider: 'itphx',
      duration_ms: 1500,
      cost_usd: 0.02,
      cost_currency: 'RUB',
      cost_breakdown: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      usage_estimated: true,
    }))

    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.metadata).toMatchObject({
      status: 'completed',
      duration_ms: 1500,
      cost_usd: 0.02,
      cost_currency: 'RUB',
      cost_breakdown: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      usage_estimated: true,
    })
    expect(msg.provider).toBe('itphx')
  })
})

describe('transportStore dispatcher: stream.cancelled с usage/cost (AD-070 §2.6)', () => {
  it('передаёт usage/cost/usage_estimated в cancelStream (сохраняются в сообщении)', () => {
    dispatch(makeEvent('stream.start', 's1', { stream_id: 'st1' }))
    useChatStore.setState({ messagesBySession: { s1: [makeAssistantMessage('st1')] } })

    dispatch(makeEvent('stream.cancelled', 's1', {
      stream_id: 'st1',
      status: 'cancelled',
      content: 'partial',
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
      cost_usd: 0.02,
      cost_currency: 'RUB',
      usage_estimated: true,
    }))

    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.usage).toEqual({ input_tokens: 1200, output_tokens: 300, total_tokens: 1500 })
    expect(msg.metadata).toMatchObject({
      stream_id: 'st1',
      status: 'cancelled',
      cost_usd: 0.02,
      cost_currency: 'RUB',
      usage_estimated: true,
    })
    expect(useChatStore.getState().streamingBySession['s1']?.['st1']).toBeUndefined()
  })
})

describe('transportStore dispatcher: subagent.progress → live-вклад (AD-070 §2.6)', () => {
  it('накапливает usage/cost/model/estimated по parent_call_id', () => {
    dispatch(makeEvent('subagent.progress', 'parent', {
      stream_id: 'st-parent',
      parent_call_id: 'call-1',
      reasoning: '',
      content: '',
      iteration: 0,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      cost_usd: 0.004,
      cost_currency: 'RUB',
      estimated: false,
      model: 'sub-model',
      provider: 'itphx',
    }))

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(live).toBeDefined()
    expect(live.byCall['call-1']!.usage).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120 })
    expect(live.byCall['call-1']!.costUsd).toBe(0.004)
    expect(live.byCall['call-1']!.costCurrency).toBe('RUB')
    expect(live.byCall['call-1']!.model).toBe('sub-model')
    expect(live.byCall['call-1']!.provider).toBe('itphx')
    expect(live.usage.input_tokens).toBe(100)
  })

  it('без parent_call_id live-вклад не создаётся', () => {
    dispatch(makeEvent('subagent.progress', 'parent', {
      stream_id: 'st-parent',
      reasoning: 'thinking',
      content: '',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }))
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeUndefined()
  })
})
