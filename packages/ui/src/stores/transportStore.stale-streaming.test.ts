/**
 * ADR-118 §5: застрявший черновик шага (`status: 'streaming'` посреди истории,
 * который так и не финализировали; позже компактизация поставила `disabled`)
 * не должен:
 *
 * - поднимать «активный ход» после `mergeServerMessages`/reload (фантомный
 *   индикатор в дереве сессий, режим «идёт ход», бесполезная «Стоп»);
 * - уезжать в конец ленты при сортировке (`isLiveOrderKey` считал живым по
 *   порядку **любое** `streaming`-сообщение, независимо от `ord`).
 *
 * Правило: живой шаг — только свежайшее по `ord` `streaming`-сообщение, не
 * `disabled`; `ord` важнее статуса — материализованное сообщение стоит на своём
 * месте в истории.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import {
  mergeServerMessages,
  maxServerOrd,
  isLiveStreamingMessage,
  restoreLiveTurnFromHistory,
  restoreLiveTurnFromSession,
  useTransportStore,
} from './transportStore'
import { sortMessagesByOrd, useChatStore, type MessageData } from './chatStore'
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

/** Реалистичная история: застрявший черновик шага (ord 3) + финальный ответ (ord 10). */
function staleSnapshot(): MessageData[] {
  const snapshot: MessageData[] = [
    message({ id: 'm-user', index: 0, role: 'user', content: 'почини баг', ord: 1, status: 'completed' }),
    message({
      id: 'm-stale',
      index: 1,
      ord: 3,
      turn_id: 't1',
      step_index: 0,
      status: 'streaming',
      disabled: true,
      content: '',
      reasoning: 'думаю над задачей',
      metadata: {
        tool_results: [
          { name: 'execute_shell', args: {}, id: 'call_1', result: { content: 'ok' } },
        ],
      },
    }),
  ]
  for (let i = 4; i <= 9; i += 1) {
    snapshot.push(
      message({
        id: `m-${i}`,
        index: i - 2,
        ord: i,
        turn_id: 't1',
        step_index: i - 3,
        status: 'completed',
        content: `шаг ${i}`,
      }),
    )
  }
  snapshot.push(
    message({
      id: 'm-final',
      index: 8,
      ord: 10,
      turn_id: 't1',
      step_index: 7,
      status: 'completed',
      content: 'готово',
    }),
  )
  return snapshot
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('застрявший streaming-черновик: нормализация при мерже истории', () => {
  it('не поднимает фантомный ход и стоит на своём месте по ord', () => {
    const snapshot = staleSnapshot()

    mergeServerMessages(SESSION, snapshot)

    const state = useChatStore.getState()
    // Фантомного хода нет: застрявший `streaming` живым не считается.
    expect(state.turnBySession[SESSION]).toBeUndefined()

    const stale = state.messagesBySession[SESSION]!.find((m) => m.id === 'm-stale')!
    expect(stale.status).not.toBe('streaming')
    expect(stale.status).toBe('completed')

    // Место в ленте — по ord (3), между репликой (1) и шагами (4..10),
    // а не в конце.
    const ordered = sortMessagesByOrd(state.messagesBySession[SESSION]!)
    const ids = ordered.map((m) => m.id)
    expect(ids).toEqual([
      'm-user',
      'm-stale',
      'm-4',
      'm-5',
      'm-6',
      'm-7',
      'm-8',
      'm-9',
      'm-final',
    ])
  })

  it('живое (свежайшее) streaming-сообщение не трогается', () => {
    const live = staleSnapshot().filter((m) => m.id !== 'm-final')
    live.push(
      message({
        id: 'm-live',
        index: 8,
        ord: 10,
        turn_id: 't1',
        step_index: 7,
        status: 'streaming',
        content: 'печатаю',
      }),
    )

    mergeServerMessages(SESSION, live)

    const messages = useChatStore.getState().messagesBySession[SESSION]!
    expect(messages.find((m) => m.id === 'm-live')!.status).toBe('streaming')
    expect(messages.find((m) => m.id === 'm-stale')!.status).toBe('completed')
    // Свежайший шаг — живой: ход восстановлен по нему.
    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 't1',
      messageId: 'm-live',
      status: 'streaming',
    })
  })
})

describe('sortMessagesByOrd: ord важнее статуса', () => {
  it('streaming с ord 2 стоит раньше completed с ord 5', () => {
    const ordered = sortMessagesByOrd([
      message({ id: 'late', ord: 5, status: 'completed', content: 'ответ' }),
      message({ id: 'early', ord: 2, status: 'streaming', content: 'черновик' }),
    ])

    expect(ordered.map((m) => m.id)).toEqual(['early', 'late'])
  })
})

describe('restoreLiveTurnFromHistory: живой шаг — только свежайший', () => {
  it('застрявший disabled-черновик ход не создаёт', () => {
    restoreLiveTurnFromHistory(SESSION, staleSnapshot())

    expect(useChatStore.getState().turnBySession[SESSION]).toBeUndefined()
  })

  it('свежайшее streaming-сообщение ход создаёт (регресс живого хода)', () => {
    const live = staleSnapshot().filter((m) => m.id !== 'm-final')
    live.push(
      message({
        id: 'm-live',
        ord: 10,
        turn_id: 't1',
        step_index: 7,
        status: 'streaming',
        content: 'печатаю',
      }),
    )

    restoreLiveTurnFromHistory(SESSION, live)

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 't1',
      messageId: 'm-live',
      status: 'streaming',
    })
  })
})

describe('restoreLiveTurnFromSession: фантомный ход закрывается по idle-серверу', () => {
  it('stale-ход с застрявшим streaming-сообщением в истории завершается stopped', () => {
    useChatStore.getState().setMessages(SESSION, staleSnapshot())
    // Ход был поднят из застрявшей записи (до нормализации/по старому клиенту).
    useChatStore.getState().startTurn(SESSION, { turnId: 't1', status: 'streaming' })

    restoreLiveTurnFromSession(SESSION, { status: {}, current_stream: null })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 't1',
      status: 'stopped',
    })
  })
})

describe('markSessionOpen: повторное открытие фантом не воскрешает', () => {
  it('после мержа истории и повторного markSessionOpen хода нет', () => {
    mergeServerMessages(SESSION, staleSnapshot())
    expect(useChatStore.getState().turnBySession[SESSION]).toBeUndefined()

    useTransportStore.getState().markSessionOpen(SESSION)
    useTransportStore.getState().markSessionOpen(SESSION)

    expect(useChatStore.getState().turnBySession[SESSION]).toBeUndefined()
  })
})

describe('предикаты maxServerOrd/isLiveStreamingMessage', () => {
  it('maxServerOrd берёт максимум и игнорирует отсутствие ord', () => {
    expect(maxServerOrd([])).toBeNull()
    expect(maxServerOrd([message({ id: 'a' }), message({ id: 'b' })])).toBeNull()
    expect(maxServerOrd([message({ id: 'a', ord: 3 }), message({ id: 'b', ord: 7 })])).toBe(7)
  })

  it('isLiveStreamingMessage: disabled и не-свежие по ord — не живые', () => {
    const maxOrd = 10
    expect(isLiveStreamingMessage(message({ id: 'a', ord: 10, status: 'streaming' }), maxOrd)).toBe(true)
    expect(isLiveStreamingMessage(message({ id: 'b', ord: 3, status: 'streaming' }), maxOrd)).toBe(false)
    expect(
      isLiveStreamingMessage(message({ id: 'c', ord: 10, status: 'streaming', disabled: true }), maxOrd),
    ).toBe(false)
    expect(isLiveStreamingMessage(message({ id: 'd', ord: 10, status: 'completed' }), maxOrd)).toBe(false)
    // Клиентский live-сегмент до материализации — без ord.
    expect(isLiveStreamingMessage(message({ id: 'e', status: 'streaming' }), maxOrd)).toBe(true)
  })
})
