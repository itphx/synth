/**
 * Регрессия синхронизации между клиентами: снимок истории — источник истины по
 * **составу** ленты. Сообщение, удалённое на сервере, должно исчезнуть после
 * `mergeServerMessages`, а локальные/живые/вклинивающиеся записи — сохраниться.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getStickyNotes: vi.fn().mockResolvedValue({ notes: [] }),
  },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import { mergeServerMessages, applyHistoryPage } from './transportStore'
import { useChatStore, type MessageData } from './chatStore'
import { resetChatStore } from './testUtils'

const SID = 's1'

function message(overrides: Partial<MessageData> & { index: number; content: string }): MessageData {
  return {
    role: 'assistant',
    ord: null,
    turn_id: null,
    status: 'completed',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function ids(messages: MessageData[]): string[] {
  return messages.map((m) => m.id ?? `index:${m.index}`)
}

beforeEach(() => {
  resetChatStore()
})

describe('mergeServerMessages: удаление сообщений по снимку сервера', () => {
  it('сообщение с ord внутри диапазона снимка, которого нет в снимке, исчезает из ленты', () => {
    const kept = message({ index: 0, id: 'm-keep', content: 'осталось', ord: 1 })
    const deleted = message({ index: 1, id: 'm-deleted', content: 'удалено', ord: 2 })
    const newer = message({ index: 2, id: 'm-newer', content: 'новее', ord: 3 })
    useChatStore.getState().setMessages(SID, [kept, deleted, newer])

    mergeServerMessages(SID, [kept, newer])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-keep', 'm-newer'])
  })

  it('сообщение с ord новее max(ord) снимка сохраняется, даже если его нет в снимке', () => {
    // Гонка «снимок старше записи»: снимок снят до материализации сообщения
    // (ход уже закрыт `turn.finished`), поэтому в нём его нет. Такое сообщение
    // заведомо новее снимка — удалять его нельзя.
    const snapshotMsg = message({ index: 0, id: 'm-snapshot', content: 'в снимке', ord: 5 })
    const trailing = message({ index: 1, id: 'm-trailing', content: 'после снимка', ord: 6 })
    useChatStore.getState().setMessages(SID, [snapshotMsg, trailing])

    mergeServerMessages(SID, [snapshotMsg])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual([
      'm-snapshot',
      'm-trailing',
    ])
  })

  it('сообщение с ord внутри диапазона снимка по-прежнему удаляется', () => {
    const first = message({ index: 0, id: 'm-first', content: 'первое', ord: 1 })
    const deleted = message({ index: 1, id: 'm-deleted', content: 'удалено', ord: 2 })
    const last = message({ index: 2, id: 'm-last', content: 'последнее', ord: 3 })
    useChatStore.getState().setMessages(SID, [first, deleted, last])

    mergeServerMessages(SID, [first, last])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-first', 'm-last'])
  })

  it('оптимистичное сообщение (ord == null) сохраняется', () => {
    const optimistic = message({ index: 0, id: 'm-optimistic', content: 'ещё не записано', ord: null })
    useChatStore.getState().setMessages(SID, [optimistic])

    mergeServerMessages(SID, [])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-optimistic'])
  })

  it('вклинивание (steerPending) сохраняется, даже если сервер его ещё не знает', () => {
    const steer = message({
      index: 0,
      id: 'm-steer',
      content: 'вклинивание',
      ord: 3,
      steerPending: true,
    })
    useChatStore.getState().setMessages(SID, [steer])

    mergeServerMessages(SID, [])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-steer'])
  })

  it('живое сообщение (status: streaming) сохраняется', () => {
    const live = message({
      index: 0,
      id: 'm-live',
      content: 'печатается',
      ord: 4,
      status: 'streaming',
    })
    useChatStore.getState().setMessages(SID, [live])

    mergeServerMessages(SID, [])

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-live'])
  })

  it('сообщение без id сохраняется (мержить не по чему)', () => {
    const local = message({ index: 0, content: 'локальное', ord: null })
    useChatStore.getState().setMessages(SID, [local])

    mergeServerMessages(SID, [])

    expect(useChatStore.getState().messagesBySession[SID]).toHaveLength(1)
    expect(useChatStore.getState().messagesBySession[SID]?.[0]?.content).toBe('локальное')
  })

  it('известное сообщение обновляется данными сервера, а не теряется', () => {
    const known = message({ index: 0, id: 'm-1', content: 'старый текст', ord: 1 })
    useChatStore.getState().setMessages(SID, [known])

    mergeServerMessages(SID, [
      message({ index: 0, id: 'm-1', content: 'новый текст', ord: 1 }),
    ])

    const messages = useChatStore.getState().messagesBySession[SID] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('новый текст')
  })
})

/**
 * Пагинация истории: снимок `GET /sessions/:id/messages` — это **страница**.
 *
 * При `has_more: true` снимок покрывает только последние сообщения, поэтому
 * сообщения старше границы страницы удалёнными считать нельзя — иначе догрузка
 * старых страниц «съедалась» бы любым мержем. При `has_more: false` снимок
 * авторитетен по всему составу (прежнее поведение).
 */
describe('mergeServerMessages: пагинация истории', () => {
  it('сообщение старше границы страницы сохраняется (has_more: true)', () => {
    const older = message({ index: 0, id: 'm-old', content: 'старое', ord: 1, seq: 1 })
    const newer = message({ index: 1, id: 'm-new', content: 'новое', ord: 2, seq: 2 })
    useChatStore.getState().setMessages(SID, [older, newer])

    mergeServerMessages(SID, [newer], { hasMore: true })

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-old', 'm-new'])
  })

  it('удалённое на сервере сообщение внутри страницы исчезает (has_more: true)', () => {
    const first = message({ index: 0, id: 'm-first', content: 'первое', ord: 1, seq: 1 })
    const deleted = message({ index: 1, id: 'm-deleted', content: 'удалено', ord: 2, seq: 2 })
    const newer = message({ index: 2, id: 'm-new', content: 'новое', ord: 3, seq: 3 })
    useChatStore.getState().setMessages(SID, [first, deleted, newer])

    // Снимок страницы: сообщение `seq: 2` на сервере удалено.
    mergeServerMessages(SID, [first, newer], { hasMore: true })

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-first', 'm-new'])
  })

  it('без has_more снимок авторитетен — старое сообщение удаляется', () => {
    const older = message({ index: 0, id: 'm-old', content: 'старое', ord: 1, seq: 1 })
    const newer = message({ index: 1, id: 'm-new', content: 'новое', ord: 2, seq: 2 })
    useChatStore.getState().setMessages(SID, [older, newer])

    mergeServerMessages(SID, [newer], { hasMore: false })

    expect(ids(useChatStore.getState().messagesBySession[SID] ?? [])).toEqual(['m-new'])
  })

  it('applyHistoryPage не сбрасывает курсор после догрузки старых страниц (expanded)', () => {
    // Пользователь уже догрузил старую страницу; снимок последней страницы о
    // ней не знает — сдвигать курсор нельзя, иначе страницы станут
    // недостижимыми/«омолодятся».
    useChatStore.getState().setHistoryPage(SID, { hasMore: true, nextBefore: 5, expanded: true })

    applyHistoryPage(SID, {
      messages: [message({ index: 0, id: 'm-new', content: 'новое', ord: 9, seq: 9 })],
      session_id: SID,
      has_more: true,
      next_before: 9,
    })

    expect(useChatStore.getState().historyPageBySession[SID]).toEqual({
      hasMore: true,
      nextBefore: 5,
      expanded: true,
    })
  })

  it('пока старые не догружались, курсор обновляется снимком (история выросла)', () => {
    // Первая загрузка была при короткой истории (`has_more: false`) — после
    // роста истории курсор обязан обновиться, иначе кнопка «залипает».
    useChatStore.getState().setHistoryPage(SID, { hasMore: false, nextBefore: null, expanded: false })

    applyHistoryPage(SID, {
      messages: [message({ index: 0, id: 'm-new', content: 'новое', ord: 9, seq: 9 })],
      session_id: SID,
      has_more: true,
      next_before: 9,
    })

    expect(useChatStore.getState().historyPageBySession[SID]).toEqual({
      hasMore: true,
      nextBefore: 9,
      expanded: false,
    })
  })

  it('повторный снимок с теми же значениями не пересоздаёт запись курсора', () => {
    // Снимок приходит на каждый `step.finished`/`mergeHistory`: без no-op guard
    // каждый раз создавался бы новый объект → лишние перерендеры ленты.
    useChatStore.getState().setHistoryPage(SID, { hasMore: true, nextBefore: 5, expanded: false })
    const before = useChatStore.getState().historyPageBySession[SID]

    applyHistoryPage(SID, {
      messages: [message({ index: 0, id: 'm-new', content: 'новое', ord: 9, seq: 9 })],
      session_id: SID,
      has_more: true,
      next_before: 5,
    })

    expect(useChatStore.getState().historyPageBySession[SID]).toBe(before)
  })
})
