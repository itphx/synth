/**
 * ADR-118 §4: `message.enqueued` — адресное событие «сообщение принято и ждёт
 * материализации» со **снимком** сообщения.
 *
 * Правило показа (утверждено владельцем):
 *   • `delivery: 'queue'` — обычная очередь: в ленте **не показывается** вообще
 *     (живёт только в панели очереди / `QueuePanel`);
 *   • `delivery: 'steer'` — вклинивание в текущий ход: показывается в ленте
 *     **сразу**, до материализации.
 *
 * `message.delivered` примиряет запись по `id` (`ord`/`turn_id`, снятие
 * маркера `steerPending`), а не добавляет второй пузырь.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [], pending_messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
    getSessionMessage: vi.fn().mockResolvedValue({ message: null as never }),
    enqueueMessage: vi.fn(),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { synthApi } from '@/lib/api/synthApi'
import { createDispatcher } from './transportStore'
import { useChatStore } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const getSession = vi.mocked(synthApi.getSession)

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Снимок сообщения в событии `message.enqueued`. */
function snapshot(content = 'вмешательство', id = 'm-steer') {
  return {
    id,
    role: 'user',
    author: 'user',
    content,
    parts: [{ id: 'msg:text:0', type: 'text', data: content }],
    metadata: { steer: true, stream_id: 'st-1' },
    created_at: '2026-10-31T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  getSession.mockResolvedValue({ id: 's1', messages: [], pending_messages: [] } as never)
})

describe('message.enqueued: очередь в ленте не показывается', () => {
  it('delivery=queue — реплика в ленту не попадает', () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-q',
      delivery: 'queue',
      position: 2,
      message: snapshot('в очереди', 'm-q'),
    }))

    expect(useChatStore.getState().messagesBySession['s1']).toBeUndefined()
  })

  it('delivery=queue — очередь в панели очереди не ломается', () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-q',
      delivery: 'queue',
      position: 2,
      message: snapshot('в очереди', 'm-q'),
    }))
    dispatch(makeEvent('queue.state', 's1', {
      pendingCount: 1,
      steerCount: 0,
      items: [{ id: 'st-1', status: 'queued' }],
    }))

    const pending = useChatStore.getState().pendingBySession['s1']
    expect(pending).toBeUndefined()
    expect(useChatStore.getState().queueBySession['s1']).toMatchObject({ pendingCount: 1 })
  })
})

describe('message.enqueued: вклинивание (steer) появляется в ленте сразу', () => {
  it('delivery=steer — реплика появляется в ленте с маркером steerPending', () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer',
      delivery: 'steer',
      position: null,
      message: snapshot(),
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'm-steer',
      role: 'user',
      content: 'вмешательство',
      steerPending: true,
      ord: null,
    })
  })

  it('повторное событие (догон/реконнект) не создаёт второй пузырь', () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
  })

  it('message.delivered примиряет по id: ord/turn_id и снятие маркера', () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))
    dispatch(makeEvent('message.delivered', 's1', {
      messageId: 'm-steer', ord: 7, role: 'user', author: 'user', turnId: 'turn_1',
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'm-steer',
      ord: 7,
      turn_id: 'turn_1',
      steerPending: false,
    })
  })

  it('уже материализованное сообщение не получает маркер ожидания', () => {
    useChatStore.getState().upsertMessage('s1', {
      index: 0,
      id: 'm-steer',
      role: 'user',
      content: 'уже в истории',
      ord: 3,
      disabled: false,
      pinned: false,
      hidden: false,
      created_at: '2026-10-31T00:00:00Z',
    })

    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))

    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.steerPending).toBe(false)
  })
})

describe('message.enqueued: уборка неразрешённых вклиниваний', () => {
  it('вернувшееся в обычную очередь — исчезает из ленты', async () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))
    expect(useChatStore.getState().messagesBySession['s1']).toHaveLength(1)

    // Ход закончился до границы шага — ядро вернуло сообщение в очередь.
    getSession.mockResolvedValue({
      id: 's1',
      messages: [],
      pending_messages: [{ id: 'm-steer', role: 'user', content: 'вмешательство' }],
    } as never)
    dispatch(makeEvent('queue.state', 's1', { pendingCount: 1, steerCount: 0 }))

    await vi.waitFor(() => {
      expect(useChatStore.getState().messagesBySession['s1'] ?? []).toHaveLength(0)
    })
  })

  it('терминал хода снимает неразрешённые вклинивания', () => {
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))
    expect(useChatStore.getState().messagesBySession['s1']).toHaveLength(1)

    dispatch(makeEvent('turn.finished', 's1', { turnId: 't1', status: 'completed' }))

    expect(useChatStore.getState().messagesBySession['s1'] ?? []).toHaveLength(0)
  })

  it('отмена хода (stream.cancelled) тоже снимает неразрешённые вклинивания', () => {
    dispatch(makeEvent('turn.started', 's1', { turnId: 't1', messageId: 'm-user' }))
    dispatch(makeEvent('message.enqueued', 's1', {
      messageId: 'm-steer', delivery: 'steer', position: null, message: snapshot(),
    }))
    expect(useChatStore.getState().messagesBySession['s1']).toHaveLength(1)

    dispatch(makeEvent('stream.cancelled', 's1', { stream_id: 'st-1', content: '', status: 'cancelled' }))

    expect(useChatStore.getState().messagesBySession['s1'] ?? []).toHaveLength(0)
  })
})

describe('message.enqueued: после перезагрузки очередь в ленту не досеивается', () => {
  it('pending_messages не добавляются в ленту', () => {
    // Очередь живёт только в панели очереди — досева в ленту нет.
    getSession.mockResolvedValue({
      id: 's1',
      messages: [],
      pending_messages: [{ id: 'm-q', role: 'user', content: 'в очереди' }],
    } as never)

    dispatch(makeEvent('message.accepted', 's1', { messageId: 'm-q', mode: 'queue', position: 1 }))

    // Событие принятия само по себе в ленту ничего не добавляет.
    expect(useChatStore.getState().messagesBySession['s1']).toBeUndefined()
  })
})
