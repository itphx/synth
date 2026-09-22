import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, selectLiveSubagentUsage } from './chatStore'
import type { MessageData } from './chatStore'

const EMPTY_STORE = {
  messagesBySession: {},
  streamFinishTickBySession: {},
  streamingBySession: {},
  queueBySession: {},
  pendingBySession: {},
  errorBySession: {},
  retryBySession: {},
  subagentRetryBySession: {},
  subagentResumingBySession: {},
  finalErrorBySession: {},
  stickyNotesBySession: {},
  summarizationPendingBySession: {},
  liveSubagentUsageBySession: {},
}

beforeEach(() => {
  useChatStore.setState(EMPTY_STORE as Partial<ReturnType<typeof useChatStore.getState>>)
})

describe('chatStore: streamFinishTickBySession', () => {
  it('finishStream инкрементирует тик завершения для своей сессии', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', 'developer')
    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBeUndefined()

    useChatStore.getState().finishStream('s1', 'st1', {
      content: 'ok',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(1)
  })

  it('повторное завершение увеличивает тик (не сбрасывается)', () => {
    useChatStore.getState().startStream('s1', 'st1', null)
    useChatStore.getState().finishStream('s1', 'st1', { content: 'a' })
    useChatStore.getState().startStream('s1', 'st2', null)
    useChatStore.getState().finishStream('s1', 'st2', { content: 'b' })

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(2)
  })

  it('cancelStream инкрементирует тик (отмена/ошибка завершают стрим)', () => {
    useChatStore.getState().startStream('s1', 'st1', null)
    useChatStore.getState().cancelStream('s1', 'st1')

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(1)
  })

  it('тик привязан к сессии и не задевает другие', () => {
    useChatStore.getState().startStream('s1', 'st1', null)
    useChatStore.getState().finishStream('s1', 'st1', { content: 'a' })

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(1)
    expect(useChatStore.getState().streamFinishTickBySession['s2']).toBeUndefined()
  })
})

/** Минимальный assistant-месседж с привязкой к стриму (для cancelStream). */
function makeAssistantMessage(streamId: string): MessageData {
  return {
    index: 7,
    role: 'assistant',
    content: 'partial',
    metadata: { stream_id: streamId },
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
  }
}

describe('chatStore: updateStreamUsage (AD-070 §2.6)', () => {
  it('обновляет StreamState: usage, cost, breakdown, estimated, model/provider', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', 'developer')

    store.updateStreamUsage('s1', 'st1', {
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: 4 },
      costUsd: 0.01,
      costCurrency: 'RUB',
      costBreakdown: { input: 0.001, output: 0.009, cacheRead: 0, cacheWrite: 0 },
      usageEstimated: false,
      model: 'gpt-x',
      provider: 'openai',
    })

    const st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: 4 })
    expect(st.costUsd).toBe(0.01)
    expect(st.costCurrency).toBe('RUB')
    expect(st.costBreakdown).toEqual({ input: 0.001, output: 0.009, cacheRead: 0, cacheWrite: 0 })
    expect(st.usageEstimated).toBe(false)
    expect(st.model).toBe('gpt-x')
    expect(st.provider).toBe('openai')
  })

  it('нет StreamState → создаётся минимальный usage-only (дочерняя сессия без stream.start)', () => {
    // AD-070 §2.6 (Bug 2): дочерний саб-агент не публикует stream.start, поэтому
    // первый stream.usage обязан создать live-состояние, иначе live не виден.
    useChatStore.getState().updateStreamUsage('child', 'st-child', {
      usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
      costUsd: 0.01,
      model: 'sub-model',
      provider: 'itphx',
      agentRole: 'explore',
    })

    const st = useChatStore.getState().streamingBySession['child']!['st-child']!
    expect(st).toBeDefined()
    expect(st.isStreaming).toBe(true)
    expect(st.hasContent).toBe(false)
    expect(st.content).toBe('')
    expect(st.agentRole).toBe('explore')
    expect(st.usage).toEqual({ input_tokens: 200, output_tokens: 40, total_tokens: 240 })
    expect(st.costUsd).toBe(0.01)
    expect(st.model).toBe('sub-model')
  })

  it('usage-only StreamState очищается clearUsageStream (stream.ended)', () => {
    useChatStore.getState().updateStreamUsage('child', 'st-child', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      agentRole: 'explore',
    })
    expect(useChatStore.getState().streamingBySession['child']!['st-child']).toBeDefined()

    useChatStore.getState().clearUsageStream('child', 'st-child')
    expect(useChatStore.getState().streamingBySession['child']?.['st-child']).toBeUndefined()
  })

  it('clearUsageStream не трогает настоящий стрим с контентом', () => {
    const store = useChatStore.getState()
    store.startStream('parent', 'st-parent', 'developer')
    store.updateStreamChunk('parent', 'st-parent', 'hello', '')

    store.clearUsageStream('parent', 'st-parent')
    const st = useChatStore.getState().streamingBySession['parent']!['st-parent']!
    expect(st).toBeDefined()
    expect(st.content).toBe('hello')
  })

  it('не понижает точный usage оценкой', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', null)
    store.updateStreamUsage('s1', 'st1', {
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      costUsd: 0.05,
      usageEstimated: false,
      model: 'exact-model',
    })

    // Оценка приходит позже — не должна перезаписать точные токены/стоимость.
    store.updateStreamUsage('s1', 'st1', {
      usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 },
      costUsd: 0.99,
      usageEstimated: true,
      provider: 'openai',
    })

    const st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 })
    expect(st.costUsd).toBe(0.05)
    expect(st.usageEstimated).toBe(false)
    // Фактические model/provider обновляются.
    expect(st.model).toBe('exact-model')
    expect(st.provider).toBe('openai')
  })

  it('оценка принимается, пока точного usage нет, и заменяется точным', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', null)

    store.updateStreamUsage('s1', 'st1', {
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
      usageEstimated: true,
    })
    let st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.usageEstimated).toBe(true)
    expect(st.usage!.input_tokens).toBe(80)

    store.updateStreamUsage('s1', 'st1', {
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      usageEstimated: false,
    })
    st = useChatStore.getState().streamingBySession['s1']!['st1']!
    expect(st.usageEstimated).toBe(false)
    expect(st.usage!.input_tokens).toBe(100)
  })
})

describe('chatStore: finishStream переносит финальную статистику (AD-070 §2.6, Bug 1)', () => {
  it('top-level duration_ms/cost_usd/cost_breakdown/usage_estimated/provider → metadata сообщения', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', 'developer')
    // message.added уже добавил optimistic-сообщение с metadata (subagents/secrets).
    useChatStore.setState({
      messagesBySession: {
        s1: [{
          index: 5,
          role: 'assistant',
          content: 'final',
          metadata: { stream_id: 'st1', subagents: { sessions: 1, input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0.001 } },
          disabled: false,
          pinned: false,
          hidden: false,
          created_at: '2026-09-19T00:00:00Z',
        }],
      },
    })

    store.finishStream('s1', 'st1', {
      content: 'final',
      message_index: 5,
      status: 'completed',
      provider: 'itphx',
      duration_ms: 1234,
      cost_usd: 0.02,
      cost_currency: 'RUB',
      cost_breakdown: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      usage_estimated: true,
      metadata: { secrets: { TOKEN: 'secret' } },
    })

    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.metadata).toMatchObject({
      stream_id: 'st1',
      status: 'completed',
      duration_ms: 1234,
      cost_usd: 0.02,
      cost_currency: 'RUB',
      cost_breakdown: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      usage_estimated: true,
      secrets: { TOKEN: 'secret' },
    })
    // metadata от message.added не затирается.
    expect(msg.metadata?.subagents).toBeDefined()
    expect(msg.provider).toBe('itphx')
  })

  it('без StreamState (fallback-ветка) статистика тоже попадает в metadata', () => {
    useChatStore.getState().finishStream('s1', 'missing', {
      content: 'fallback',
      message_index: 0,
      status: 'completed',
      provider: 'itphx',
      duration_ms: 500,
      cost_usd: 0.03,
    })

    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.metadata).toMatchObject({
      status: 'completed',
      duration_ms: 500,
      cost_usd: 0.03,
    })
    expect(msg.provider).toBe('itphx')
  })
})

describe('chatStore: cancelStream сохраняет статистику (AD-070 §2.6)', () => {
  it('usage/cost/status/usage_estimated попадают в assistant-сообщение по stream_id', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', null)
    useChatStore.setState({ messagesBySession: { s1: [makeAssistantMessage('st1')] } })

    store.cancelStream('s1', 'st1', 'cancelled', {
      usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
      costUsd: 0.02,
      costCurrency: 'RUB',
      usageEstimated: true,
    })

    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.usage).toEqual({ input_tokens: 1200, output_tokens: 300, total_tokens: 1500 })
    expect(msg.metadata).toMatchObject({ stream_id: 'st1', status: 'cancelled', cost_usd: 0.02, cost_currency: 'RUB', usage_estimated: true })
    // Стрим удалён.
    expect(useChatStore.getState().streamingBySession['s1']?.['st1']).toBeUndefined()
  })

  it('без extra сохраняет прежнее поведение (только status)', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', null)
    useChatStore.setState({ messagesBySession: { s1: [makeAssistantMessage('st1')] } })

    store.cancelStream('s1', 'st1', 'stopped')

    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.metadata).toMatchObject({ stream_id: 'st1', status: 'stopped' })
    expect(msg.usage).toBeUndefined()
  })
})

describe('chatStore: liveSubagentUsageBySession (AD-070 §2.6)', () => {
  it('накапливает вклад по вызовам и агрегирует сессию', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      costUsd: 0.001,
      costCurrency: 'USD',
      estimated: false,
      model: 'm1',
    })
    store.updateLiveSubagentUsage('parent', 'call-2', {
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      estimated: true,
    })

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(Object.keys(live.byCall)).toEqual(['call-1', 'call-2'])
    expect(live.byCall['call-1']!.usage.input_tokens).toBe(10)
    expect(live.byCall['call-1']!.model).toBe('m1')
    expect(live.byCall['call-1']!.costCurrency).toBe('USD')
    expect(live.usage).toEqual({
      input_tokens: 15,
      output_tokens: 3,
      total_tokens: 18,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    })
    expect(live.costUsd).toBeCloseTo(0.001)
    expect(live.costCurrency).toBe('USD')
    expect(live.estimated).toBe(true)
  })

  it('агрегат не задаёт валюту, когда вызовы в разных валютах', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      costUsd: 0.001,
      costCurrency: 'USD',
    })
    store.updateLiveSubagentUsage('parent', 'call-2', {
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      costUsd: 0.05,
      costCurrency: 'RUB',
    })

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(live.costUsd).toBeCloseTo(0.051)
    expect(live.byCall['call-1']!.costCurrency).toBe('USD')
    expect(live.byCall['call-2']!.costCurrency).toBe('RUB')
    expect(live.costCurrency).toBeUndefined()
  })

  it('событие несёт накопленный usage вызова — перезапись, а не суммирование', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 25, output_tokens: 8, total_tokens: 33 },
    })

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(live.byCall['call-1']!.usage.input_tokens).toBe(25)
    expect(live.usage.input_tokens).toBe(25)
  })

  it('сбрасывается при finishStream родителя', () => {
    const store = useChatStore.getState()
    store.startStream('parent', 'st1', null)
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeDefined()

    store.finishStream('parent', 'st1', { content: 'done' })
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeUndefined()
  })

  it('сбрасывается при cancelStream родителя', () => {
    const store = useChatStore.getState()
    store.startStream('parent', 'st1', null)
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })

    store.cancelStream('parent', 'st1', 'cancelled')
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeUndefined()
  })

  it('clearSession сбрасывает live-вклад сессии', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    store.clearSession('parent')
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeUndefined()
  })

  it('selectLiveSubagentUsage отдаёт вклад сессии для StatsTab', () => {
    const store = useChatStore.getState()
    store.updateLiveSubagentUsage('parent', 'call-1', {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    const selector = selectLiveSubagentUsage('parent')
    expect(selector(useChatStore.getState())?.usage.input_tokens).toBe(10)
    expect(selectLiveSubagentUsage('other')(useChatStore.getState())).toBeUndefined()
  })
})
