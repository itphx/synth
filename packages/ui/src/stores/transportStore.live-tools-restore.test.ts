/**
 * ADR-118 §5: восстановление **выполняющихся инструментов** шага после
 * перезагрузки страницы.
 *
 * Ядро публикует `step.finished` до запуска инструментов, поэтому в истории
 * нет сообщения со статусом `streaming`, а `tool_call.started` пришло ещё до
 * reload и не переигрывается (полный reload не передаёт `since`). Стор обязан:
 * 1) взять id сообщения шага из последнего assistant-сообщения хода;
 * 2) «посеять» live-части выполняющихся вызовов, иначе `patchPartData` без
 *    существующей части молча ничего не делает и результат/прогресс теряются.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ session_id: 's1', messages: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { createDispatcher, mergeServerMessages, restoreLiveTurnFromSession } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'
import type { WSEvent } from '@/lib/api/transport'

const SESSION = 's1'
const TURN = 't1'
const STEP = 'm-step'
const DONE_CALL = 'call-done'
const LIVE_CALL = 'call-live'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId = SESSION): WSEvent {
  return { type, session_id: sessionId, data }
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

/** История: шаг завершён, два вызова, результат только у первого. */
function history(): MessageData[] {
  return [
    message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
    message({
      id: STEP,
      ord: 2,
      turn_id: TURN,
      step_index: 0,
      status: 'completed',
      content: 'Запускаю две задачи.',
      tool_calls: [
        {
          id: DONE_CALL,
          type: 'function',
          function: { name: 'task', arguments: '{"description":"первая"}' },
        },
        {
          id: LIVE_CALL,
          type: 'function',
          function: { name: 'task', arguments: '{"description":"вторая"}' },
        },
      ],
    }),
    message({
      id: 'm-tool',
      index: 3,
      ord: 3,
      role: 'tool',
      tool_call_id: DONE_CALL,
      content: 'готово',
      status: 'completed',
    }),
  ]
}

function seedHistory(): void {
  useChatStore.getState().setMessages(SESSION, history())
}

function restore(): void {
  restoreLiveTurnFromSession(SESSION, {
    status: {},
    current_stream: { turn_id: TURN },
  })
}

function parts(): Record<string, { data?: Record<string, unknown> }> {
  return (useChatStore.getState().partsBySession[SESSION]?.[STEP] ?? {}) as Record<
    string,
    { data?: Record<string, unknown> }
  >
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
})

describe('transportStore: восстановление инструментов шага после reload', () => {
  it('берёт id последнего assistant-сообщения хода и сеет выполняющийся вызов', () => {
    seedHistory()

    restore()

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: TURN,
      messageId: STEP,
      stepIndex: 0,
      status: 'streaming',
      toolsRunning: true,
    })
    // Выполняющийся вызов — «посеян» как live-часть шага.
    expect(parts()[LIVE_CALL]?.data).toMatchObject({
      name: 'task',
      args: { description: 'вторая' },
      status: 'running',
    })
    // Завершённый вызов не сеется (результат уже в истории).
    expect(parts()[DONE_CALL]).toBeUndefined()
  })

  it('result и progress после reload доходят до посеянной части, а не теряются', () => {
    seedHistory()
    restore()

    dispatch(makeEvent('tool_call.result', {
      call_id: LIVE_CALL,
      result: { content: 'вторая готова' },
    }))
    dispatch(makeEvent('subagent.progress', {
      parent_call_id: LIVE_CALL,
      reasoning_delta: 'дум',
      content_delta: 'Hel',
      iteration: 0,
    }))

    expect(parts()[LIVE_CALL]?.data).toMatchObject({
      status: 'done',
      result: { content: 'вторая готова' },
      subagentReasoningBlocks: [{ text: 'дум', iteration: 0 }],
      subagentIntermediateTextBlocks: [{ text: 'Hel', iteration: 0 }],
    })
  })

  it('part.delta нового шага по-прежнему адресуется через step.started', () => {
    seedHistory()
    restore()

    dispatch(makeEvent('step.started', {
      turnId: TURN,
      stepIndex: 1,
      messageId: 'm-step-2',
    }))
    dispatch(makeEvent('part.delta', {
      messageId: 'm-step-2',
      partId: 'msg:text:1',
      field: 'text',
      delta: 'Новый шаг',
    }))

    const live = useChatStore.getState().partsBySession[SESSION]?.['m-step-2']?.['msg:text:1']
    expect(live?.text).toBe('Новый шаг')
    // Ход переключился на новый шаг.
    expect(useChatStore.getState().turnBySession[SESSION]?.messageId).toBe('m-step-2')
  })

  it('вызовы другого хода не сеются', () => {
    useChatStore.getState().setMessages(SESSION, [
      message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' }),
      message({
        id: 'm-other',
        ord: 2,
        turn_id: 'other-turn',
        step_index: 0,
        status: 'completed',
        tool_calls: [{ id: 'call-other', type: 'function', function: { name: 'task', arguments: '{}' } }],
      }),
      message({
        id: STEP,
        ord: 3,
        turn_id: TURN,
        step_index: 0,
        status: 'completed',
        tool_calls: [{ id: LIVE_CALL, type: 'function', function: { name: 'task', arguments: '{}' } }],
      }),
    ])

    restore()

    expect(useChatStore.getState().partsBySession[SESSION]?.['m-other']).toBeUndefined()
    expect(parts()[LIVE_CALL]?.data).toMatchObject({ status: 'running' })
  })

  it('уже существующая live-часть не перетирается', () => {
    seedHistory()
    useChatStore.getState().upsertPart(SESSION, STEP, LIVE_CALL, {
      id: LIVE_CALL,
      type: 'tool_use',
      text: '',
      data: { name: 'task', args: { description: 'вторая' }, status: 'running', startedAt: '2026-10-30T10:43:00Z' },
    })

    restore()

    expect(parts()[LIVE_CALL]?.data).toMatchObject({
      startedAt: '2026-10-30T10:43:00Z',
      status: 'running',
    })
  })

  it('завершённый ход не восстанавливается и части не сеются', () => {
    seedHistory()

    restoreLiveTurnFromSession(SESSION, { status: {}, current_stream: null })

    expect(useChatStore.getState().turnBySession[SESSION]).toBeUndefined()
    expect(useChatStore.getState().partsBySession[SESSION]?.[STEP]).toBeUndefined()
  })
})

describe('transportStore: переключение вкладок/сессий без reload', () => {
  it('уже идущий ход без messageId: patch-путь восстанавливает id, сеет части, события применяются', () => {
    seedHistory()
    // Ход уже в сторе (пришёл событиями), но `messageId` не заполнен:
    // на переключении вкладок выполняется ветка `patchTurnFromSession`.
    useChatStore.getState().startTurn(SESSION, { turnId: TURN, status: 'streaming' })

    restore()

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: TURN,
      messageId: STEP,
      stepIndex: 0,
      toolsRunning: true,
    })
    expect(parts()[LIVE_CALL]?.data).toMatchObject({ status: 'running' })

    dispatch(makeEvent('tool_call.result', {
      call_id: LIVE_CALL,
      result: { content: 'вторая готова' },
    }))
    expect(parts()[LIVE_CALL]?.data).toMatchObject({ status: 'done' })
  })

  it('messageId указывает на отсутствующее сообщение — перепривязывается к шагу хода', () => {
    seedHistory()
    useChatStore.getState().startTurn(SESSION, {
      turnId: TURN,
      messageId: 'gone-message',
      status: 'streaming',
    })

    restore()

    expect(useChatStore.getState().turnBySession[SESSION]?.messageId).toBe(STEP)

    // Событие инструмента адресуется уже существующему сообщению шага.
    dispatch(makeEvent('subagent.progress', {
      parent_call_id: LIVE_CALL,
      content_delta: 'Hel',
      iteration: 0,
    }))
    expect(parts()[LIVE_CALL]?.data).toMatchObject({
      subagentIntermediateTextBlocks: [{ text: 'Hel', iteration: 0 }],
    })
    // Фантомного сообщения с «повисшим» id не появилось.
    expect(useChatStore.getState().messagesBySession[SESSION]?.some((m) => m.id === 'gone-message')).toBe(false)
  })

  it('несколько переключений подряд не теряют ход, части и доставку событий', () => {
    seedHistory()

    // Каждое «монтирование» вкладки: снимок истории + восстановление хода.
    for (let i = 0; i < 4; i += 1) {
      mergeServerMessages(SESSION, history())
      restore()
    }

    expect(useChatStore.getState().turnBySession[SESSION]).toMatchObject({
      turnId: TURN,
      messageId: STEP,
      status: 'streaming',
      toolsRunning: true,
    })
    expect(parts()[LIVE_CALL]?.data).toMatchObject({ status: 'running' })

    dispatch(makeEvent('tool_call.result', {
      call_id: LIVE_CALL,
      result: { content: 'вторая готова' },
    }))
    dispatch(makeEvent('subagent.progress', {
      parent_call_id: LIVE_CALL,
      reasoning_delta: 'дум',
      iteration: 0,
    }))
    expect(parts()[LIVE_CALL]?.data).toMatchObject({
      status: 'done',
      result: { content: 'вторая готова' },
      subagentReasoningBlocks: [{ text: 'дум', iteration: 0 }],
    })
  })

  it('снимок без сообщения активного хода не удаляет шаг (гонка записи)', () => {
    seedHistory()
    useChatStore.getState().startTurn(SESSION, { turnId: TURN, messageId: STEP, status: 'streaming' })

    // Серверный снимок отстал: сообщения шага в нём ещё нет.
    mergeServerMessages(SESSION, [message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' })])

    expect(useChatStore.getState().messagesBySession[SESSION]?.some((m) => m.id === STEP)).toBe(true)

    // Ход завершился — снимок снова источник истины по составу ленты.
    useChatStore.getState().finishTurn(SESSION, TURN, 'completed')
    mergeServerMessages(SESSION, [message({ id: 'm-user', role: 'user', content: 'запусти', ord: 1, status: 'completed' })])

    expect(useChatStore.getState().messagesBySession[SESSION]?.some((m) => m.id === STEP)).toBe(false)
  })

  it('отстающий снимок без tool_calls не затирает вызовы живого шага', () => {
    seedHistory()
    useChatStore.getState().startTurn(SESSION, { turnId: TURN, messageId: STEP, status: 'streaming' })

    const stale = history().map((m) => (m.id === STEP ? { ...m, tool_calls: null } : m))
    mergeServerMessages(SESSION, stale)

    const step = useChatStore.getState().messagesBySession[SESSION]?.find((m) => m.id === STEP)
    expect(step?.tool_calls).toHaveLength(2)
    // Результат завершённого вызова всё равно сведён из tool-сообщения.
    expect(step?.tool_calls?.[0]?.result).toEqual({ content: 'готово' })
  })
})

describe('transportStore: вкладка саб-агента (карточки инструментов)', () => {
  it('restore сеет running-часть ребёнка, tool_call.result из дочернего канала её закрывает', () => {
    const CHILD = 'child-1'
    const CHILD_STEP = 'child-step'
    const CALL = 'child-tool-call'

    useChatStore.getState().setMessages(CHILD, [
      message({ id: 'child-user', role: 'user', content: 'работай', ord: 1, status: 'completed' }),
      message({
        id: CHILD_STEP,
        ord: 2,
        turn_id: CHILD,
        step_index: 0,
        status: 'completed',
        content: 'Читаю файл.',
        tool_calls: [{
          id: CALL,
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        }],
      }),
    ])

    restoreLiveTurnFromSession(CHILD, {
      status: {},
      current_stream: { turn_id: CHILD },
    })

    expect(useChatStore.getState().turnBySession[CHILD]).toMatchObject({
      turnId: CHILD,
      messageId: CHILD_STEP,
      toolsRunning: true,
    })
    const childParts = useChatStore.getState().partsBySession[CHILD]?.[CHILD_STEP] ?? {}
    expect(childParts[CALL]?.data).toMatchObject({
      name: 'read_file',
      args: { path: 'a.ts' },
      status: 'running',
    })

    // Результат приходит из канала дочерней сессии (`run-cycle` публикует
    // `tool_call.result` и туда) — карточка закрывается, а не «мигает».
    dispatch(makeEvent('tool_call.result', {
      call_id: CALL,
      result: { content: 'содержимое файла' },
    }, CHILD))

    expect(useChatStore.getState().partsBySession[CHILD]?.[CHILD_STEP]?.[CALL]?.data).toMatchObject({
      status: 'done',
      result: { content: 'содержимое файла' },
    })
  })
})

describe('transportStore: результаты инструментов из истории (ADR-118 §1)', () => {
  const HISTORY_SESSION = 'hist'
  const ASSISTANT = 'a1'
  const CALL = 'c1'

  function snapshot(): MessageData[] {
    return [
      message({ id: 'u1', role: 'user', content: 'прочитай', ord: 1, status: 'completed' }),
      message({
        id: ASSISTANT,
        ord: 2,
        turn_id: 'turn-hist',
        step_index: 0,
        status: 'completed',
        tool_calls: [{ id: CALL, name: 'read_file', args: { path: 'a.ts' } }],
      }),
      message({
        id: 't1',
        index: 3,
        ord: 3,
        role: 'tool',
        tool_call_id: CALL,
        content: 'ok',
        status: 'completed',
        created_at: '2026-10-30T11:07:00Z',
        metadata: { tool_chain: true },
      }),
    ]
  }

  it('скрытое tool-сообщение даёт result в tool_calls assistant-сообщения', () => {
    mergeServerMessages(HISTORY_SESSION, snapshot())

    const assistant = useChatStore.getState().messagesBySession[HISTORY_SESSION]
      ?.find((m) => m.id === ASSISTANT)
    expect(assistant?.tool_calls?.[0]?.result).toEqual({ content: 'ok' })
    expect(assistant?.tool_calls?.[0]?.completed_at).toBe('2026-10-30T11:07:00Z')
  })

  it('live-часть с результатом не перетирается историческим сведением', () => {
    const livePart = {
      id: CALL,
      type: 'tool_use' as const,
      text: '',
      data: { name: 'read_file', args: { path: 'a.ts' }, status: 'done', result: { content: 'live' } },
    }
    useChatStore.getState().upsertPart(HISTORY_SESSION, ASSISTANT, CALL, livePart)

    mergeServerMessages(HISTORY_SESSION, snapshot())

    expect(useChatStore.getState().partsBySession[HISTORY_SESSION]?.[ASSISTANT]?.[CALL]).toBe(livePart)
    const assistant = useChatStore.getState().messagesBySession[HISTORY_SESSION]
      ?.find((m) => m.id === ASSISTANT)
    expect(assistant?.tool_calls?.[0]?.result).toEqual({ content: 'ok' })
  })

  it('неизвестный call_id не меняет вызов', () => {
    const messages = snapshot().map((m) => (
      m.id === ASSISTANT
        ? { ...m, tool_calls: [{ id: 'unknown', name: 'read_file', args: {} }] }
        : m
    ))
    mergeServerMessages(HISTORY_SESSION, messages)

    const assistant = useChatStore.getState().messagesBySession[HISTORY_SESSION]
      ?.find((m) => m.id === ASSISTANT)
    expect(assistant?.tool_calls?.[0]?.result).toBeUndefined()
    expect(assistant?.tool_calls?.[0]?.completed_at).toBeUndefined()
  })

  it('вкладка саб-агента после завершения инструментов: результат виден из истории', () => {
    const CHILD = 'child-hist'
    const CHILD_STEP = 'child-step-hist'

    mergeServerMessages(CHILD, [
      message({ id: 'child-user', role: 'user', content: 'работай', ord: 1, status: 'completed' }),
      message({
        id: CHILD_STEP,
        ord: 2,
        turn_id: CHILD,
        step_index: 0,
        status: 'completed',
        tool_calls: [{ id: 'child-c1', name: 'noop', args: {} }],
      }),
      message({
        id: 'child-tool',
        index: 3,
        ord: 3,
        role: 'tool',
        tool_call_id: 'child-c1',
        content: 'noop ok',
        status: 'completed',
        metadata: { tool_chain: true },
      }),
    ])
    restoreLiveTurnFromSession(CHILD, {
      status: {},
      current_stream: { turn_id: CHILD },
    })

    expect(useChatStore.getState().turnBySession[CHILD]?.messageId).toBe(CHILD_STEP)
    const step = useChatStore.getState().messagesBySession[CHILD]
      ?.find((m) => m.id === CHILD_STEP)
    expect(step?.tool_calls?.[0]?.result).toEqual({ content: 'noop ok' })
  })
})
