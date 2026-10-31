/**
 * ADR-118 §5: восстановление живого хода **по признакам активного хода** из
 * `GET /sessions/:id` (`current_stream`, `status.blocked`).
 *
 * Истории для этого может не хватить: идёт длинный инструмент, шаг с текстом
 * уже `completed`, а следующего assistant-сообщения ещё нет — сообщения со
 * статусом `streaming` в истории нет, `restoreLiveTurnFromHistory` выходит, и
 * без признака из API в UI не было бы ни индикатора, ни «Стоп», ни `ctrl+b`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { restoreLiveTurnFromSession } from './transportStore'
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

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore: живой ход по признакам из GET /sessions/:id (ADR-118 §5)', () => {
  it('current_stream восстанавливает ход, даже если streaming-сообщения в истории нет', () => {
    // История: шаг с текстом уже завершён, следующего сообщения ещё нет.
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-1', step_index: 0, status: 'completed',
        content: 'Запускаю команду.',
        parts: [{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }],
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      id: SESSION,
      status: {},
      current_stream: { turn_id: 'turn-1', agent_role: 'leader' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-1',
      status: 'streaming',
      agentRole: 'leader',
    })
  })

  it('id хода берётся и из stream_id', () => {
    restoreLiveTurnFromSession(SESSION, {
      current_stream: { stream_id: 'stream-7' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'stream-7',
      status: 'streaming',
    })
  })

  it('без turn_id в current_stream берётся turn_id последнего сообщения — не stream_id', () => {
    // Смена ядра: `current_stream` без `turn_id`. Ход должен совпадать с id
    // хода в истории, иначе live-сообщения получают `turn_id = stream-…`,
    // а история — `turn_…`: блок хода рвётся на два, а закрытие сегментов
    // по `onlyTurnId` не срабатывает (индикатор застревает).
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-42', step_index: 0, status: 'completed',
        content: 'Запускаю команду.',
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { stream_id: 'stream-7' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-42',
      status: 'streaming',
    })
  })

  it('уведомление о фоне (turn_id = null) не влияет — берётся id хода', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-step', ord: 2, turn_id: 'turn-43', status: 'completed' }),
      message({
        id: 'm-notice', ord: 3, role: 'user', turn_id: null, status: 'completed',
        metadata: { type: 'background_run_result' },
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { stream_id: 'stream-8' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-43',
      status: 'streaming',
    })
  })

  it('ни turn_id в current_stream, ни turn_id в сообщениях — берётся stream_id (legacy)', () => {
    restoreLiveTurnFromSession(SESSION, {
      current_stream: { stream_id: 'stream-9' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'stream-9',
      status: 'streaming',
    })
  })

  it('status.blocked (ожидание подтверждения) тоже восстанавливает ход — по истории', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({
        id: 'm-step', ord: 2, turn_id: 'turn-2', step_index: 1, status: 'streaming',
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      status: { blocked: 'permission' },
      current_stream: null,
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-2',
      messageId: 'm-step',
      stepIndex: 1,
      status: 'streaming',
    })
  })

  it('нет ни current_stream, ни blocked — ход не создаётся', () => {
    restoreLiveTurnFromSession(SESSION, { status: {}, current_stream: null })

    expect(useChatStore.getState().turnBySession[SESSION]).toBeUndefined()
  })

  it('уже восстановленный ход не перетирается', () => {
    useChatStore.getState().startTurn(SESSION, {
      turnId: 'turn-live',
      messageId: 'm-live',
      stepIndex: 3,
      status: 'streaming',
    })

    restoreLiveTurnFromSession(SESSION, {
      current_stream: { turn_id: 'turn-stale' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-live',
      messageId: 'm-live',
      stepIndex: 3,
      status: 'streaming',
    })
  })

  it('activity.busy с turnId восстанавливает ход без current_stream', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: null,
      activity: { type: 'busy', turnId: 'turn-7', streamId: 'stream-7' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-7',
      streamId: 'stream-7',
      status: 'streaming',
    })
  })

  it('activity.retry включает плашку «Повтор N/M» и восстанавливает ход', () => {
    const retryAt = new Date(Date.now() + 3000).toISOString()

    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: null,
      activity: {
        type: 'retry',
        turnId: 'turn-8',
        streamId: 'stream-8',
        attempt: 2,
        maxRetries: 5,
        retryAt,
        error: 'rate limit',
      },
    })

    expect(useChatStore.getState().retryBySession[SESSION]).toMatchObject({
      streamId: 'stream-8',
      attempt: 2,
      maxRetries: 5,
      error: 'rate limit',
    })
    expect(useChatStore.getState().retryBySession[SESSION]!.retryInMs).toBeGreaterThanOrEqual(0)
    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-8',
      status: 'streaming',
    })
  })

  it('activity.retry с прошедшим retryAt не даёт отрицательной задержки', () => {
    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: null,
      activity: {
        type: 'retry',
        streamId: 'stream-9',
        attempt: 1,
        maxRetries: 3,
        retryAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    expect(useChatStore.getState().retryBySession[SESSION]).toMatchObject({
      streamId: 'stream-9',
      attempt: 1,
      maxRetries: 3,
      retryInMs: 0,
    })
  })

  it('уже восстановленный streaming-ход не перетирается activity.turnId', () => {
    useChatStore.getState().startTurn(SESSION, {
      turnId: 'turn-live',
      messageId: 'm-live',
      status: 'streaming',
    })

    restoreLiveTurnFromSession(SESSION, {
      status: {},
      current_stream: null,
      activity: { type: 'busy', turnId: 'turn-other', streamId: 'stream-other' },
    })

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: 'turn-live',
      messageId: 'm-live',
      status: 'streaming',
    })
  })
})

describe('transportStore: серверный снимок живого шага (ADR-118 §5)', () => {
  it('снимок создаёт сегмент шага целиком — без ожидания чанков', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'привет', ord: 1 }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      id: SESSION,
      status: {},
      activity: { type: 'busy', turnId: 'turn-1', streamId: 'stream-1' },
      current_stream: {
        stream_id: 'stream-1',
        turn_id: 'turn-1',
        agent_role: 'leader',
        live: {
          message_id: 'm-step',
          step_index: 0,
          turn_id: 'turn-1',
          content: 'уже видно',
          reasoning: 'думаю',
          parts: [
            { id: 'msg:text:0', type: 'text', data: 'уже видно' },
            { id: 'msg:reasoning:0', type: 'reasoning', data: 'думаю' },
          ],
          updated_at: '2026-10-30T00:00:01Z',
        },
      },
    })

    const chat = useChatStore.getState()
    const step = chat.messagesBySession[SESSION]!.find((m) => m.id === 'm-step')
    expect(step).toBeDefined()
    expect(step!.content).toBe('уже видно')
    expect(step!.status).toBe('streaming')
    expect(step!.turn_id).toBe('turn-1')
    expect(step!.step_index).toBe(0)

    // Части легли в live-состояние — `buildPartsView` соберёт по ним текст.
    const parts = chat.partsBySession[SESSION]?.['m-step'] ?? {}
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(['msg:text:0', 'msg:reasoning:0']))
    expect(parts['msg:text:0']!.text).toBe('уже видно')

    // Контент хода уже есть → индикатор в шапке, а не у реплики.
    expect(chat.turnBySession[SESSION]?.status).toBe('streaming')
    expect(chat.turnBySession[SESSION]?.contentStarted).toBe(true)
  })

  it('снимок дополняет уже известный сегмент и не дублирует части', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({
        id: 'm-step',
        turn_id: 'turn-1',
        step_index: 0,
        status: 'streaming',
        content: 'коротко',
        parts: [{ id: 'msg:text:0', type: 'text', data: 'коротко' }],
      }),
    ])
    useChatStore.getState().upsertPart(SESSION, 'm-step', 'msg:text:0', {
      id: 'msg:text:0',
      type: 'text',
      text: 'коротко',
      data: 'коротко',
    })

    restoreLiveTurnFromSession(SESSION, {
      id: SESSION,
      status: {},
      current_stream: {
        stream_id: 'stream-1',
        turn_id: 'turn-1',
        live: {
          message_id: 'm-step',
          step_index: 0,
          turn_id: 'turn-1',
          content: 'коротко, но уже длиннее',
          parts: [{ id: 'msg:text:0', type: 'text', data: 'коротко, но уже длиннее' }],
          updated_at: '2026-10-30T00:00:01Z',
        },
      },
    })

    const chat = useChatStore.getState()
    const step = chat.messagesBySession[SESSION]!.find((m) => m.id === 'm-step')!
    expect(step.content).toBe('коротко, но уже длиннее')
    const parts = chat.partsBySession[SESSION]!['m-step']!
    expect(Object.keys(parts)).toEqual(['msg:text:0'])
    expect(parts['msg:text:0']!.text).toBe('коротко, но уже длиннее')
  })

  it('снимок не воскрешает завершённый шаг', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({
        id: 'm-step',
        turn_id: 'turn-1',
        step_index: 0,
        status: 'completed',
        content: 'финал',
      }),
    ])

    restoreLiveTurnFromSession(SESSION, {
      id: SESSION,
      status: {},
      current_stream: {
        stream_id: 'stream-1',
        turn_id: 'turn-1',
        live: {
          message_id: 'm-step',
          step_index: 0,
          content: 'устаревшее',
          parts: [{ id: 'msg:text:0', type: 'text', data: 'устаревшее' }],
          updated_at: '2026-10-30T00:00:01Z',
        },
      },
    })

    const step = useChatStore.getState().messagesBySession[SESSION]!.find((m) => m.id === 'm-step')!
    expect(step.content).toBe('финал')
    expect(step.status).toBe('completed')
  })
})
