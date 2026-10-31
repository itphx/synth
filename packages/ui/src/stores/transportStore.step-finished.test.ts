/**
 * ADR-118 §5: финализация шага — «финал» = смена статуса.
 *
 * Статус шага ставится **сразу** (в момент финала шага), а не после ответа
 * `GET /messages`: иначе индикатор «идёт» висел в середине склеенного блока
 * хода — у уже завершённого шага (тем дольше, чем больше шагов в ходу).
 *
 * Live-части при этом **не** снимаются: карточка инструмента шага должна
 * остаться видимой (ядро публикует `step.finished` **до** запуска тулов,
 * результат приходит позже через `tool_call.result`). Текст/reasoning в
 * финальном сообщении берутся только из dto-частей (`resolveLiveParts`),
 * поэтому «застрявший» текст прошлого шага в блок хода не попадает.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { synthApi } from '@/lib/api/synthApi'
import { createDispatcher } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'
import { buildPartsView, normalizeLiveToolPart, resolveLiveParts } from '@/lib/messageParts'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()
const getSessionMessages = vi.mocked(synthApi.getSessionMessages)

function makeEvent(type: string, sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type, session_id: sessionId, data }
}

/** Запись сервера: шаг сохранён с частями и контентом. */
function serverMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    index: 1,
    id: 'm1',
    ord: 2,
    turn_id: 't1',
    step_index: 0,
    status: 'completed',
    role: 'assistant',
    content: 'Запускаю команду.',
    parts: [{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }],
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:01Z',
    ...overrides,
  }
}

/** Живые части сообщения в сторе (в форме рендера — нормализованные). */
function livePartsOf(messageId: string) {
  const map = useChatStore.getState().partsBySession['s1']?.[messageId]
  return map ? Object.values(map).map(normalizeLiveToolPart) : []
}

beforeEach(() => {
  vi.clearAllMocks()
  getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })
  resetChatStore()
})

describe('transportStore dispatcher: финализация шага (ADR-118 §5)', () => {
  it('step.finished подтягивает историю — части шага берутся из истории', async () => {
    getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [serverMessage()] })

    // Шаг начался: сообщение создано, live-части накапливаются.
    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))

    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()

    // Шаг финализирован.
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    await vi.waitFor(() => {
      expect(getSessionMessages).toHaveBeenCalledWith('s1')
    })

    // Сообщение в стере — по серверу: части/контент из истории.
    const messages = useChatStore.getState().messagesBySession['s1'] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.status).toBe('completed')
    expect(messages[0]!.parts).toEqual([{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }])
    expect(messages[0]!.content).toBe('Запускаю команду.')
  })

  it('при сетевой ошибке истории live-части сохраняются — текст шага не теряется', async () => {
    getSessionMessages.mockRejectedValue(new Error('network down'))

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    await vi.waitFor(() => {
      expect(getSessionMessages).toHaveBeenCalled()
    })
    // Живые части на месте — текст шага остался виден.
    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()
  })

  it('статус шага выставляется сразу — не дожидаясь ответа getSessionMessages', async () => {
    let resolveFetch: (value: unknown) => void = () => {}
    getSessionMessages.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve }) as never,
    )

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    // Запрос истории ещё в полёте — статус уже финальный: индикатор «идёт»
    // гаснет в момент финала шага, а не после ответа `GET /messages`.
    const pending = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
    expect(pending.status).toBe('completed')
    // Текст шага при этом виден: live-части на месте и служат фоллбеком.
    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()
    const view = buildPartsView(pending.parts, resolveLiveParts(livePartsOf('m1'), {
      isLive: false,
      dtoParts: pending.parts,
    }), { content: pending.content })
    expect(view.text).toBe('Запускаю команду.')

    resolveFetch({ session_id: 's1', messages: [serverMessage()] })
    await vi.waitFor(() => {
      const done = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
      expect(done.status).toBe('completed')
      expect(done.parts).toEqual([{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }])
    })
  })

  it('история вернулась без шага — live-части остаются (текст не пропадает насовсем)', async () => {
    // Сервер сохраняет шаг асинхронно: запрос истории успешен, но записи ещё нет.
    getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [] })

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    await vi.waitFor(() => {
      expect(getSessionMessages).toHaveBeenCalled()
      const message = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
      expect(message.status).toBe('completed')
    })
    // Live-части не сняты: только из них сейчас берётся текст шага.
    expect(useChatStore.getState().partsBySession['s1']?.['m1']).toBeDefined()
  })

  it('карточка инструмента шага остаётся в рендере после step.finished; результат тула её обновляет', async () => {
    // Ядро сохранило шаг (текст в dto) — tool-части в dto ещё нет.
    getSessionMessages.mockResolvedValue({ session_id: 's1', messages: [serverMessage()] })

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    dispatch(makeEvent('part.delta', 's1', {
      messageId: 'm1',
      partId: 'msg:text:0',
      field: 'text',
      delta: 'Запускаю команду.',
    }))
    // Вызов инструмента приходит в шаге (`part.updated`, id = callId).
    dispatch(makeEvent('part.updated', 's1', {
      messageId: 'm1',
      partId: 'call-1',
      part: {
        id: 'call-1',
        type: 'tool_use',
        data: { id: 'call-1', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"ls"}' } },
      },
    }))
    // Финал шага — **до** запуска тулов.
    dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1', status: 'completed' }))

    // Статус — сразу, не дожидаясь ответа истории.
    expect(useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!.status).toBe('completed')

    // Тул отработал — результат приходит позже.
    dispatch(makeEvent('tool_call.result', 's1', {
      call_id: 'call-1',
      result: { content: 'file.txt' },
    }))

    await vi.waitFor(() => {
      expect(getSessionMessages).toHaveBeenCalledWith('s1')
    })

    const state = useChatStore.getState()
    const message = state.messagesBySession['s1']!.find((m) => m.id === 'm1')!
    expect(message.status).toBe('completed')
    // Части текста шага пришли из истории.
    expect(message.parts).toEqual([{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }])

    // Live-части шага не сняты — карточка инструмента остаётся в рендере.
    const resolved = resolveLiveParts(livePartsOf('m1'), { isLive: false, dtoParts: message.parts })
    expect(resolved?.some((p) => p.type === 'tool_use')).toBe(true)

    const view = buildPartsView(message.parts, resolved, { content: message.content })
    // Текст шага — один раз (из dto), без live-дубликата.
    expect(view.text).toBe('Запускаю команду.')
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({ callId: 'call-1', name: 'execute_shell', status: 'done' })
    expect(view.toolCalls[0]!.result?.content).toBe('file.txt')
  })

  it('пачка step.finished схлопывается в ≤ 2 загрузки истории, данные применяются', async () => {
    let calls = 0
    const resolvers: Array<(value: unknown) => void> = []
    getSessionMessages.mockImplementation(() => {
      calls += 1
      return new Promise((resolve) => { resolvers.push(resolve) }) as never
    })

    dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: 0, messageId: 'm1' }))
    // Tool-loop: каждый шаг хода — своё сообщение и свой финал.
    for (let i = 0; i < 5; i += 1) {
      dispatch(makeEvent('step.started', 's1', { turnId: 't1', stepIndex: i, messageId: `m${i + 1}` }))
      dispatch(makeEvent('step.finished', 's1', { turnId: 't1', stepIndex: i, messageId: `m${i + 1}`, status: 'completed' }))
    }

    // Запрос уже идёт — второй не запускается (single-flight).
    expect(calls).toBe(1)

    // Завершение текущего прогона запускает ровно один trailing-прогон.
    await vi.waitFor(() => expect(resolvers.length).toBe(1))
    resolvers[0]!({ session_id: 's1', messages: [] })
    await vi.waitFor(() => expect(calls).toBe(2))
    resolvers[1]!({ session_id: 's1', messages: [serverMessage()] })

    await vi.waitFor(() => {
      const message = useChatStore.getState().messagesBySession['s1']!.find((m) => m.id === 'm1')!
      expect(message.status).toBe('completed')
      expect(message.parts).toEqual([{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }])
    })
    expect(calls).toBeLessThanOrEqual(2)
  })
})
