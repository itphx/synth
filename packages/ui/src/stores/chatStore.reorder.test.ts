/**
 * DnD-переупорядочивание очереди в сторе: `reorderPending` ставит элементы по
 * списку серверных id; элементы, которых в списке нет (оптимистичные строки без
 * id), остаются в конце в прежнем порядке.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, type QueuedMessage } from './chatStore'
import { resetChatStore } from './testUtils'

function q(id: string | undefined, content: string): QueuedMessage {
  return { ...(id ? { id } : {}), content }
}

function pending(sid = 's1'): QueuedMessage[] {
  return useChatStore.getState().pendingBySession[sid] ?? []
}

beforeEach(() => {
  resetChatStore()
})

describe('chatStore.reorderPending', () => {
  it('переставляет элементы в порядке ids', () => {
    const store = useChatStore.getState()
    store.setPendingMessages('s1', [q('a', 'первое'), q('b', 'второе'), q('c', 'третье')])

    store.reorderPending('s1', ['c', 'a', 'b'])

    expect(pending().map((m) => m.content)).toEqual(['третье', 'первое', 'второе'])
  })

  it('отсутствующие в ids элементы уходят в конец с сохранением порядка', () => {
    const store = useChatStore.getState()
    store.setPendingMessages('s1', [q('a', 'A'), q('b', 'B'), q('c', 'C'), q(undefined, 'без id')])

    // В ids — только два элемента: остальные (c и строка без id) в конце.
    store.reorderPending('s1', ['b', 'a'])

    expect(pending().map((m) => m.content)).toEqual(['B', 'A', 'C', 'без id'])
  })

  it('неизвестные id игнорируются, дубли не задваивают строки', () => {
    const store = useChatStore.getState()
    store.setPendingMessages('s1', [q('a', 'A'), q('b', 'B')])

    store.reorderPending('s1', ['nope', 'b', 'b', 'a'])

    expect(pending().map((m) => m.content)).toEqual(['B', 'A'])
  })

  it('тот же порядок и пустой список id — состояние не меняется', () => {
    const store = useChatStore.getState()
    store.setPendingMessages('s1', [q('a', 'A'), q('b', 'B')])
    const before = pending()

    store.reorderPending('s1', ['a', 'b'])
    store.reorderPending('s1', [])

    expect(pending()).toBe(before)
  })

  it('нет очереди у сессии — no-op', () => {
    const store = useChatStore.getState()
    store.reorderPending('нет-такой', ['a'])

    expect(pending('нет-такой')).toEqual([])
  })
})
