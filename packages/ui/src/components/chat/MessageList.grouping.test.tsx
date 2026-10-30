import { describe, it, expect } from 'vitest'
import { groupMessagesByTurn } from './MessageList'
import type { MessageData } from '@/stores/chatStore'

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

/**
 * ADR-118 §1: группировка ленты по ходу (`turn_id`).
 *
 * Единица рендера — группа-ход: сегменты одного хода склеиваются (заголовок
 * агента/модели — только у первого), вставленная user-реплика разделяет
 * сегменты; порядок — по `ord` (тай-брейк по `id`).
 */
describe('groupMessagesByTurn', () => {
  it('склеивает сегменты одного хода в одну группу', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0 }),
      msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1 }),
      msg({ id: 'a3', index: 3, ord: 12, turn_id: 't1', step_index: 2 }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.turnId).toBe('t1')
    expect(groups[0]!.messages.map((m) => m.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('сортирует сообщения по ord, а не по порядку массива', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'b', index: 2, ord: 20, turn_id: 't2' }),
      msg({ id: 'a', index: 1, ord: 15, turn_id: 't1' }),
      msg({ id: 'c', index: 3, ord: 21, turn_id: 't2' }),
    ])

    expect(groups.map((g) => g.turnId)).toEqual(['t1', 't2'])
    expect(groups[1]!.messages.map((m) => m.id)).toEqual(['b', 'c'])
  })

  it('при равном ord — тай-брейк по id', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'zzz', index: 2, ord: 5, turn_id: 't1' }),
      msg({ id: 'aaa', index: 1, ord: 5, turn_id: 't1' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.messages.map((m) => m.id)).toEqual(['aaa', 'zzz'])
  })

  it('вставленная user-реплика разделяет сегменты хода', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', role: 'assistant' }),
      msg({ id: 'u1', index: 2, ord: 11, turn_id: 't1', role: 'user' }),
      msg({ id: 'a2', index: 3, ord: 12, turn_id: 't1', role: 'assistant' }),
    ])

    expect(groups).toHaveLength(3)
    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([['a1'], ['u1'], ['a2']])
    // Первый сегмент каждой группы — с заголовком, остальные «компактные».
    expect(groups.map((g) => g.messages[0]!.id)).toEqual(['a1', 'u1', 'a2'])
  })

  it('сообщения без turn_id не склеиваются', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'm1', index: 0, ord: 1, role: 'user' }),
      msg({ id: 'm2', index: 1, ord: 2, role: 'assistant' }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.turnId === null)).toBe(true)
  })

  it('разные ходы — разные группы', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1' }),
      msg({ id: 'a2', index: 2, ord: 11, turn_id: 't2' }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.turnId)).toEqual(['t1', 't2'])
  })
})
