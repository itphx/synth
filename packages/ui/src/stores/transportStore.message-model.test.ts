/**
 * ADR-118 §6/§8: сверка версий (fail-closed) и точка догона (`since`).
 *
 * - Перед подключением клиент спрашивает возможности инстанса
 *   (`GET /api/v2/meta`) и сверяет `supportsMessageModel()`;
 * - при расхождении подключения **нет**, выставляется `versionMismatch` и
 *   показывается ошибка;
 * - точка догона — максимум `eventSeq` применённых событий (`lastEventSeq`),
 *   он уходит в транспорт при (ре)коннекте.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  interface Callbacks {
    onEvent?: (event: unknown) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onTransportSwitch?: (transport: string) => void
    onBackendReady?: () => void
  }

  class MockClient {
    kind: 'ws' | 'sse' | 'disconnected' = 'disconnected'
    callbacks: Callbacks
    connect = vi.fn((mode: 'ws' | 'sse') => {
      this.kind = mode
    })
    disconnect = vi.fn(() => {
      this.kind = 'disconnected'
      this.callbacks.onDisconnect?.('manual')
    })
    getTransport = vi.fn(() => this.kind)
    cancel = vi.fn()
    sendPermissionReply = vi.fn()
    sendPermissionHold = vi.fn()
    isBackendReady = vi.fn(() => true)

    constructor(callbacks: Callbacks) {
      this.callbacks = callbacks
      instances.push(this)
    }
  }

  const instances: MockClient[] = []
  const api = {
    getInstanceCapabilities: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  }
  return { instances, MockClient, api }
})

vi.mock('@/lib/api/transport', () => ({ TransportClient: mocks.MockClient }))
vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks.api }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { useTransportStore, createDispatcher, resetEventSeqTracking, restoreLiveTurnFromHistory } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { useInstanceCapabilitiesStore } from './instanceCapabilitiesStore'
import { resetChatStore } from './testUtils'
import { notifyMessage } from '@/hooks/useNotification'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(
  type: string,
  sessionId: string,
  data: Record<string, unknown>,
  eventSeq?: number,
): WSEvent {
  return { type, session_id: sessionId, data, ...(eventSeq != null ? { eventSeq } : {}) }
}

const CAPS_OK = { messageModel: 2, eventSeq: true, replay: true, version: '0.13.0' }

beforeEach(() => {
  useTransportStore.getState().disconnect()
  useTransportStore.setState({ versionMismatch: false, transportMode: 'ws', connected: false })
  mocks.instances.length = 0
  vi.clearAllMocks()
  mocks.api.getInstanceCapabilities.mockResolvedValue(CAPS_OK)
  // Кэш `/meta` живёт в сторе возможностей инстанса — сбрасываем, чтобы
  // каждый тест сверялся со своим ответом сервера.
  useInstanceCapabilitiesStore.getState().resetForTests()
  resetEventSeqTracking()
  resetChatStore()
})

describe('transportStore.connect: fail-closed сверка модели сообщений (ADR-118 §8)', () => {
  it('совпадающая версия → подключение с точкой догона', async () => {
    useTransportStore.getState().connect('ws')
    await vi.waitFor(() => expect(mocks.instances[0]!.connect).toHaveBeenCalled())

    // ADR-118 §6: точки догона ещё нет (`since` не определён) — второй
    // аргумент **не передаётся** вовсе (чистый контракт `connect`).
    expect(mocks.instances[0]!.connect).toHaveBeenCalledWith('ws')
    expect(useTransportStore.getState().versionMismatch).toBe(false)
  })

  it('несовпадающая версия → не подключаемся, versionMismatch и ошибка', async () => {
    mocks.api.getInstanceCapabilities.mockResolvedValue({
      messageModel: 1, eventSeq: true, replay: true, version: '0.12.0',
    })

    useTransportStore.getState().connect('ws')
    await vi.waitFor(() => expect(useTransportStore.getState().versionMismatch).toBe(true))

    expect(mocks.instances[0]!.connect).not.toHaveBeenCalled()
    expect(mocks.instances[0]!.disconnect).toHaveBeenCalled()
    expect(useTransportStore.getState().connected).toBe(false)
    expect(notifyMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })

  it('старый инстанс без messageModel → тоже отказ (тихая деградация запрещена)', async () => {
    mocks.api.getInstanceCapabilities.mockResolvedValue({ eventSeq: true, replay: false, version: '0.11.0' })

    useTransportStore.getState().connect('ws')
    await vi.waitFor(() => expect(useTransportStore.getState().versionMismatch).toBe(true))

    expect(mocks.instances[0]!.connect).not.toHaveBeenCalled()
  })

  it('мета недоступна → подключаемся (гейт на сервере всё равно откажет)', async () => {
    mocks.api.getInstanceCapabilities.mockRejectedValue(new Error('network'))

    useTransportStore.getState().connect('sse')
    await vi.waitFor(() => expect(mocks.instances[0]!.connect).toHaveBeenCalledWith('sse'))

    expect(useTransportStore.getState().versionMismatch).toBe(false)
  })
})

describe('transportStore: точка догона (ADR-118 §6)', () => {
  it('каждое применённое событие двигает точку догона; реконнект уносит её в since', async () => {
    useTransportStore.getState().connect('ws')
    await vi.waitFor(() => expect(mocks.instances[0]!.connect).toHaveBeenCalled())

    dispatch(makeEvent('turn.started', 's1', { turnId: 't1', messageId: 'm1' }, 4))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1', partId: 'msg:text:0', field: 'text', delta: 'a',
    }, 9))
    // Меньший номер (событие другой сессии/порядок доставки) не откатывает точку.
    dispatch(makeEvent('queue.state', 's1', { pendingCount: 0, steerCount: 0 }, 3))

    // Обрыв → повторный connect с известной точкой догона.
    mocks.instances[0]!.callbacks.onDisconnect?.('WS closed: 1006')
    useTransportStore.getState().connect('ws')

    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2))
    await vi.waitFor(() => expect(mocks.instances[1]!.connect).toHaveBeenCalledWith('ws', { since: 9 }))
  })

  it('инстансный канал (pipeline.run.*) не подмешивается в точку догона', async () => {
    dispatch(makeEvent('pipeline.run.started', 'instance', { runId: 'r1' }, 100))
    dispatch(makeEvent('turn.started', 's1', { turnId: 't1', messageId: 'm1' }, 2))

    useTransportStore.getState().connect('ws')
    await vi.waitFor(() => expect(mocks.instances[0]!.connect).toHaveBeenCalledWith('ws', { since: 2 }))
  })
})

describe('transportStore: восстановление живого хода из истории (ADR-118 §5)', () => {
  it('сообщение со статусом streaming восстанавливает активный ход сессии', () => {
    restoreLiveTurnFromHistory('s1', [
      {
        index: 0, id: 'm-user', role: 'user', content: 'привет', ord: 1, status: 'completed',
        disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:00Z',
      },
      {
        index: 1, id: 'm-step', role: 'assistant', content: 'част', ord: 2,
        status: 'streaming', turn_id: 't1', step_index: 0, model: 'gpt',
        disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:01Z',
      },
    ])

    expect(useChatStore.getState().turnBySession['s1']).toMatchObject({
      turnId: 't1',
      messageId: 'm-step',
      stepIndex: 0,
      status: 'streaming',
      model: 'gpt',
    })
  })

  it('завершённая история не создаёт активного хода', () => {
    restoreLiveTurnFromHistory('s1', [
      {
        index: 0, id: 'm1', role: 'assistant', content: 'готово', ord: 1, status: 'completed',
        turn_id: 't1', disabled: false, pinned: false, hidden: false,
        created_at: '2026-10-30T00:00:00Z',
      },
    ])

    expect(useChatStore.getState().turnBySession['s1']).toBeUndefined()
  })

  it('идемпотентность: повторный вызов с той же историей не меняет ход', () => {
    const messages: MessageData[] = [
      {
        index: 0, id: 'm-step', role: 'assistant', content: 'част', ord: 2,
        status: 'streaming', turn_id: 't1', step_index: 0, model: 'gpt',
        disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:01Z',
      },
    ]

    restoreLiveTurnFromHistory('s1', messages)
    const first = useChatStore.getState().turnBySession['s1']
    restoreLiveTurnFromHistory('s1', messages)
    const second = useChatStore.getState().turnBySession['s1']

    expect(second).toEqual(first)
    expect(second).toMatchObject({ turnId: 't1', messageId: 'm-step', status: 'streaming' })
  })

  it('идущий ход не перетирается историей (границы живого хода свежее истории)', () => {
    const messages: MessageData[] = [
      {
        index: 0, id: 'm-step', role: 'assistant', content: 'част', ord: 2,
        status: 'streaming', turn_id: 't1', step_index: 0,
        disabled: false, pinned: false, hidden: false, created_at: '2026-10-30T00:00:01Z',
      },
    ]

    restoreLiveTurnFromHistory('s1', messages)
    // Следующий шаг хода (живое событие `step.started`).
    useChatStore.getState().patchTurn('s1', { messageId: 'm-step-2', stepIndex: 1 })
    // Перезагрузка истории со «старым» снимком — границы хода не откатываются.
    restoreLiveTurnFromHistory('s1', messages)

    expect(useChatStore.getState().turnBySession['s1']).toMatchObject({
      turnId: 't1',
      messageId: 'm-step-2',
      stepIndex: 1,
      status: 'streaming',
    })
  })
})
