/**
 * `lib/chatScrollMemory` — память позиции прокрутки ленты **на сессию**.
 *
 * Зачем: вкладки чата переключаются без размонтирования `MessageList`
 * (`CenterPanel` рендерит `<ChatTab tab={…}>` без `key`), поэтому позиция
 * прокрутки и флаг «приклеен к низу» принадлежат сессии, а не компоненту.
 * Тесты фиксируют контракт памяти: запись/чтение по сессиям, сохранение
 * `atBottom`, нормализацию `scrollTop`, ограничение размера (LRU) и отсутствие
 * записи для неизвестной сессии.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHAT_SCROLL_MEMORY_LIMIT,
  chatScrollMemorySize,
  clearChatScrollMemory,
  forgetChatScroll,
  readChatScroll,
  rememberChatScroll,
} from './chatScrollMemory'

beforeEach(() => {
  clearChatScrollMemory()
})

describe('chatScrollMemory', () => {
  it('для неизвестной сессии записи нет', () => {
    expect(readChatScroll('s-unknown')).toBeNull()
    expect(chatScrollMemorySize()).toBe(0)
  })

  it('запоминает и отдаёт позицию по каждой сессии отдельно', () => {
    rememberChatScroll('s1', { atBottom: false, scrollTop: 1200 })
    rememberChatScroll('s2', { atBottom: true, scrollTop: 8000 })

    expect(readChatScroll('s1')).toEqual({ atBottom: false, scrollTop: 1200 })
    expect(readChatScroll('s2')).toEqual({ atBottom: true, scrollTop: 8000 })
    expect(readChatScroll('s3')).toBeNull()
  })

  it('флаг «приклеен к низу» сохраняется и обновляется', () => {
    rememberChatScroll('s1', { atBottom: true, scrollTop: 500 })
    expect(readChatScroll('s1')?.atBottom).toBe(true)

    rememberChatScroll('s1', { atBottom: false, scrollTop: 300 })
    expect(readChatScroll('s1')).toEqual({ atBottom: false, scrollTop: 300 })
  })

  it('отдаёт копию, а не ссылку на внутреннюю запись', () => {
    rememberChatScroll('s1', { atBottom: true, scrollTop: 100 })
    const state = readChatScroll('s1')!
    state.scrollTop = 999

    expect(readChatScroll('s1')?.scrollTop).toBe(100)
  })

  it('нормализует scrollTop (отрицательное и NaN → 0)', () => {
    rememberChatScroll('s1', { atBottom: false, scrollTop: -50 })
    expect(readChatScroll('s1')?.scrollTop).toBe(0)

    rememberChatScroll('s1', { atBottom: false, scrollTop: Number.NaN })
    expect(readChatScroll('s1')?.scrollTop).toBe(0)
  })

  it('пустой sessionId не пишется', () => {
    rememberChatScroll('', { atBottom: true, scrollTop: 10 })
    expect(chatScrollMemorySize()).toBe(0)
  })

  it('память не растёт бесконечно: держим последние CHAT_SCROLL_MEMORY_LIMIT сессий', () => {
    const total = CHAT_SCROLL_MEMORY_LIMIT + 5
    for (let i = 0; i < total; i += 1) {
      rememberChatScroll(`s${i}`, { atBottom: true, scrollTop: i })
    }

    expect(chatScrollMemorySize()).toBe(CHAT_SCROLL_MEMORY_LIMIT)
    // Самые старые вытеснены, самые свежие — на месте.
    expect(readChatScroll('s0')).toBeNull()
    expect(readChatScroll(`s${total - 1}`)).not.toBeNull()
    expect(readChatScroll(`s${CHAT_SCROLL_MEMORY_LIMIT}`)).not.toBeNull()
  })

  it('повторная запись делает сессию свежей (вытесняется давно не посещённая)', () => {
    for (let i = 0; i < CHAT_SCROLL_MEMORY_LIMIT; i += 1) {
      rememberChatScroll(`s${i}`, { atBottom: true, scrollTop: i })
    }
    // s0 «обновляем» — она не должна вытесняться следующей записью.
    rememberChatScroll('s0', { atBottom: false, scrollTop: 42 })
    rememberChatScroll('fresh', { atBottom: true, scrollTop: 7 })

    expect(chatScrollMemorySize()).toBe(CHAT_SCROLL_MEMORY_LIMIT)
    expect(readChatScroll('s0')).toEqual({ atBottom: false, scrollTop: 42 })
    // Вытеснена самая старая по записи — s1.
    expect(readChatScroll('s1')).toBeNull()
    expect(readChatScroll('fresh')).not.toBeNull()
  })

  it('forgetChatScroll убирает одну сессию, остальные остаются', () => {
    rememberChatScroll('s1', { atBottom: true, scrollTop: 1 })
    rememberChatScroll('s2', { atBottom: false, scrollTop: 2 })

    forgetChatScroll('s1')

    expect(readChatScroll('s1')).toBeNull()
    expect(readChatScroll('s2')).toEqual({ atBottom: false, scrollTop: 2 })
    // Забывание несуществующей сессии — no-op.
    expect(() => forgetChatScroll('nope')).not.toThrow()
  })
})
