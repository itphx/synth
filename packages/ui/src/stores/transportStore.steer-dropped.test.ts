import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте стора, а Node/vitest без
// --localstorage-file его не даёт — ставим заглушку до импорта useUIStore.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

// Моки внешних зависимостей диспетчера: сетевых вызовов и toast быть не должно.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSession: vi.fn().mockResolvedValue({ id: 's1', project_id: 'p1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { notifyMessage } from '@/hooks/useNotification'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(sessionId: string, data: Record<string, unknown>): WSEvent {
  return { type: 'steer.dropped', session_id: sessionId, data }
}

/** Последний тост (аргумент `notifyMessage`). */
function lastNotify(): { text: string; type: string; category: string; sessionId?: string } {
  const calls = (notifyMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls[calls.length - 1]![0] as { text: string; type: string; category: string; sessionId?: string }
}

describe('transportStore — steer.dropped (ADR-104, решение 2026-10-28)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ход остановлен: тост-предупреждение с причиной и количеством', () => {
    dispatch(makeEvent('s-steer-abort', { reason: 'aborted', dropped_count: 2, stream_id: 'str-abort' }))

    expect(notifyMessage).toHaveBeenCalledTimes(1)
    const notify = lastNotify()
    expect(notify.type).toBe('warning')
    expect(notify.category).toBe('system')
    expect(notify.sessionId).toBe('s-steer-abort')
    expect(notify.text).toContain('2')
  })

  it('ход закончился: тост объясняет, что сообщение не применено', () => {
    dispatch(makeEvent('s-steer-ended', { reason: 'turn_ended', dropped_count: 1, stream_id: 'str-ended' }))

    expect(notifyMessage).toHaveBeenCalledTimes(1)
    expect(lastNotify().type).toBe('warning')
    expect(lastNotify().text).toContain('1')
  })

  it('лимит инъекций на ход — тоже предупреждение (причина по умолчанию)', () => {
    dispatch(makeEvent('s-steer-limit', { dropped_count: 3 }))

    expect(notifyMessage).toHaveBeenCalledTimes(1)
    expect(lastNotify().type).toBe('warning')
    expect(lastNotify().text).toContain('3')
  })

  it('повторное такое же событие подряд не дублирует тост', () => {
    const event = { reason: 'turn_ended', dropped_count: 4, stream_id: 'str-dup' }
    dispatch(makeEvent('s-steer-dup', event))
    dispatch(makeEvent('s-steer-dup', event))

    expect(notifyMessage).toHaveBeenCalledTimes(1)
  })

  it('другая причина — отдельный тост', () => {
    dispatch(makeEvent('s-steer-mixed', { reason: 'aborted', dropped_count: 1, stream_id: 'str-mixed' }))
    dispatch(makeEvent('s-steer-mixed', { reason: 'turn_ended', dropped_count: 1, stream_id: 'str-mixed' }))

    expect(notifyMessage).toHaveBeenCalledTimes(2)
  })
})
