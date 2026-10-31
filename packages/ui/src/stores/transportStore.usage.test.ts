/**
 * ADR-118 §4/§5: диспетчер новых событий потока сообщений.
 *
 * Покрывает замену удалённых v1-событий:
 * - `stream.chunk` → `part.delta`/`part.updated` (upsert по `{messageId, partId}`);
 * - `stream.usage`/`stream.done` → `step.finished` (usage/provider/model/стоимость);
 * - «финал» — смена статуса сообщения, границы — `turn.*`/`step.*`;
 * - очередь — `message.accepted`/`queue.state`/`message.delivered`.
 */
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
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore dispatcher: turn/step (ADR-118 §1)', () => {
  it('turn.started → активный ход сессии; turn.finished → терминальный статус', () => {
    // ADR-118 §5: `messageId` в `turn.started` — id **реплики пользователя**,
    // а не живого сообщения шага: в `ActiveTurn.messageId` живёт сообщение
    // текущего шага (единственный «живой» источник контента). Поэтому ход
    // открывается без `messageId`, а он приходит в `step.started`.
    dispatch(makeEvent('turn.started', 's1', { turnId: 't1', messageId: 'm-user' }))
    expect(useChatStore.getState().turnBySession['s1']).toMatchObject({
      turnId: 't1',
      status: 'streaming',
    })
    expect(useChatStore.getState().turnBySession['s1']?.messageId).toBeUndefined()

    dispatch(makeEvent('turn.finished', 's1', { turnId: 't1', status: 'completed' }))
    expect(useChatStore.getState().turnBySession['s1']?.status).toBe('completed')
  })

  it('step.started создаёт assistant-сообщение хода со статусом streaming', () => {
    dispatch(makeEvent('turn.started', 't1', { turnId: 't1', messageId: 'm-user' }))
    dispatch(makeEvent('step.started', 't1', { turnId: 't1', stepIndex: 0, messageId: 'm-step' }))

    const msgs = useChatStore.getState().messagesBySession['t1']!
    const step = msgs.find((m) => m.id === 'm-step')!
    expect(step).toMatchObject({ role: 'assistant', status: 'streaming', turn_id: 't1', step_index: 0 })
    expect(useChatStore.getState().turnBySession['t1']).toMatchObject({
      turnId: 't1',
      messageId: 'm-step',
      stepIndex: 0,
    })
  })
})

describe('transportStore dispatcher: части сообщения (ADR-118 §4)', () => {
  it('part.delta дописывает текст в ту же часть (upsert, не append частей)', () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'При' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'вет' }))

    const parts = useChatStore.getState().partsBySession['s1']!['m1']!
    expect(Object.keys(parts)).toEqual(['msg:text:0'])
    expect(parts['msg:text:0']).toMatchObject({ type: 'text', text: 'Привет' })
  })

  it('part.updated заменяет часть целиком (кумулятивный снимок не задваивается)', () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'При' }))
    dispatch(makeEvent('part.updated', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      part: { id: 'msg:text:0', type: 'text', data: { text: 'Привет, мир' } },
    }))

    const part = useChatStore.getState().partsBySession['s1']!['m1']!['msg:text:0']!
    expect(part.text).toBe('Привет, мир')
  })

  it('части разных сообщений не смешиваются (адресация по messageId)', () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'a' }))
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 1, messageId: 'm2' }))
    dispatch(makeEvent('part.delta', 's1', { messageId: 'm2', partId: 'msg:text:0', field: 'text', delta: 'b' }))

    const parts = useChatStore.getState().partsBySession['s1']!
    expect(parts['m1']!['msg:text:0']!.text).toBe('a')
    expect(parts['m2']!['msg:text:0']!.text).toBe('b')
  })
})

describe('transportStore dispatcher: step.finished — учёт шага (замена stream.usage/stream.done)', () => {
  it('маппит usage camelCase → snake_case и фиксирует статус шага', async () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('step.finished', 's1', {
      turnId: 't1',
      stepIndex: 0,
      messageId: 'm1',
      status: 'completed',
      usage: {
        inputTokens: 1_700_000,
        outputTokens: 33_300,
        totalTokens: 1_733_300,
        cacheReadTokens: 1_581_000,
        cacheWriteTokens: 0,
        reasoningTokens: 120,
      },
      provider: 'itphx',
      model: 'gpt-x',
      costUsd: 0.03,
      costCurrency: 'RUB',
      timings: { chunks: 12, firstChunkMs: 120 },
    }))

    // ADR-118 §5: статус шага меняется **после** сверки с историей — иначе в
    // окне RTT текст шага мигал бы пустым (части DTO ещё не пришли).
    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!.status)
        .toBe('completed')
    })
    const msg = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
    expect(msg.usage).toEqual({
      input_tokens: 1_700_000,
      output_tokens: 33_300,
      total_tokens: 1_733_300,
      cache_read_tokens: 1_581_000,
      cache_write_tokens: 0,
      reasoning_tokens: 120,
    })
    expect(msg.provider).toBe('itphx')
    expect(msg.model).toBe('gpt-x')
    expect(msg.metadata).toMatchObject({
      cost_usd: 0.03,
      cost_currency: 'RUB',
      timings: { chunks: 12, firstChunkMs: 120 },
    })
  })

  it('metadata шага мёржится с уже известной (части/аттачменты не теряются)', async () => {
    useChatStore.getState().upsertMessage('s1', {
      index: 0,
      id: 'm1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      metadata: { existing: true },
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T00:00:00Z',
    })

    dispatch(makeEvent('step.finished', 's1', {
      turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'error', costUsd: 1,
    }))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession['s1']![0]!.status).toBe('error')
    })
    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg.metadata).toMatchObject({ existing: true, cost_usd: 1 })
  })

  it('step.finished со статусом cancelled — сообщение отменено', async () => {
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('step.finished', 's1', {
      turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'cancelled',
    }))
    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession['s1']![0]!.status).toBe('cancelled')
    })
  })
})

describe('transportStore dispatcher: очередь и приём (ADR-118 §4)', () => {
  it('message.accepted → строка очереди без потери текста', () => {
    useChatStore.getState().upsertMessage('s1', {
      index: 0,
      id: 'm-user',
      role: 'user',
      content: 'привет',
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-30T00:00:00Z',
    })
    useChatStore.getState().upsertPendingMessage('s1', { id: 'm-user', content: 'привет', sending: true })

    dispatch(makeEvent('message.accepted', 's1', { messageId: 'm-user', mode: 'queue', position: 2 }))

    const pending = useChatStore.getState().pendingBySession['s1']!
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'm-user', content: 'привет' })
    expect(pending[0]!.sending).toBe(false)
  })

  it('message.accepted с mode=steer не создаёт маркера доставки у сообщения', () => {
    useChatStore.getState().upsertMessage('s1', {
      index: 0, id: 'm1', role: 'user', content: 'в ход',
      disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:00Z',
    })
    dispatch(makeEvent('message.accepted', 's1', { messageId: 'm1', mode: 'steer', position: null }))
    expect(useChatStore.getState().messagesBySession['s1']![0]).not.toHaveProperty('delivery')
  })

  it('queue.state обновляет только счётчики (без текста и автора)', () => {
    dispatch(makeEvent('queue.state', 's1', { pendingCount: 2, steerCount: 1 }))
    expect(useChatStore.getState().queueBySession['s1']).toMatchObject({
      pendingCount: 2,
      steerCount: 1,
    })
    expect(useChatStore.getState().pendingBySession['s1']).toBeUndefined()
  })

  it('message.delivered для известного сообщения патчит ord/роль/автора', () => {
    useChatStore.getState().upsertMessage('s1', {
      index: 0, id: 'm1', role: 'user', content: 'x',
      disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:00Z',
    })
    dispatch(makeEvent('message.delivered', 's1', { messageId: 'm1', ord: 7, role: 'user', author: 'Иван' }))
    const msg = useChatStore.getState().messagesBySession['s1']![0]!
    expect(msg).toMatchObject({ ord: 7, author: 'Иван' })
  })
})

describe('transportStore dispatcher: subagent.progress → live-вклад (ADR-070 §2.6)', () => {
  it('накапливает usage/cost/model/estimated по parent_call_id', () => {
    dispatch(makeEvent('step.started', 'parent', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('tool_call.started', 'parent', {
      call_id: 'call-1',
      name: 'task',
      arguments: {},
      iteration: 0,
    }))
    dispatch(makeEvent('subagent.progress', 'parent', {
      parent_call_id: 'call-1',
      iteration: 0,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      cost_usd: 0.004,
      cost_currency: 'RUB',
      estimated: false,
      model: 'sub-model',
      provider: 'itphx',
    }))

    const live = useChatStore.getState().liveSubagentUsageBySession['parent']!
    expect(live.byCall['call-1']!.usage).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120 })
    expect(live.byCall['call-1']!.costUsd).toBe(0.004)
    expect(live.byCall['call-1']!.costCurrency).toBe('RUB')
    expect(live.byCall['call-1']!.model).toBe('sub-model')
    expect(live.usage.input_tokens).toBe(100)
  })

  it('без parent_call_id live-вклад не создаётся', () => {
    dispatch(makeEvent('subagent.progress', 'parent', {
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }))
    expect(useChatStore.getState().liveSubagentUsageBySession['parent']).toBeUndefined()
  })
})
