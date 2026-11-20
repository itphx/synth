/**
 * Метка «просмотрено» в `notificationStore` (`ackedAtBySession`).
 *
 * Метка — вход модели `sessionBadgeState` (`lib/sessionBadgeState.ts`):
 * исход последнего хода старше метки считается прочитанным. Она локальна
 * (per-browser), монотонна (повторный просмотр не откатывает более позднюю
 * метку) и намеренно **не персистится** — см. комментарий к полю в сторе.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) пишет в localStorage — в Node/vitest его нет.
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

import { useNotificationStore } from './notificationStore'

beforeEach(() => {
  useNotificationStore.setState({ ackedAtBySession: {} })
})

describe('notificationStore — метка «просмотрено»', () => {
  it('без отметки метки нет', () => {
    expect(useNotificationStore.getState().getAckedAt('s1')).toBeUndefined()
  })

  it('markSessionAcked ставит текущее время', () => {
    const before = Date.now()
    useNotificationStore.getState().markSessionAcked('s1')
    const ackedAt = useNotificationStore.getState().getAckedAt('s1')

    expect(ackedAt).toBeDefined()
    expect(ackedAt!).toBeGreaterThanOrEqual(before)
    expect(ackedAt!).toBeLessThanOrEqual(Date.now())
  })

  it('метка только растёт: повторный вызов с меньшим временем её не откатывает', () => {
    useNotificationStore.getState().markSessionAcked('s1', 2_000)
    useNotificationStore.getState().markSessionAcked('s1', 1_000)

    expect(useNotificationStore.getState().getAckedAt('s1')).toBe(2_000)
  })

  it('равное время не переписывает состояние (те же ссылки — без лишних рендеров)', () => {
    useNotificationStore.getState().markSessionAcked('s1', 1_500)
    const state = useNotificationStore.getState()
    state.markSessionAcked('s1', 1_500)

    expect(useNotificationStore.getState().ackedAtBySession).toBe(state.ackedAtBySession)
  })

  it('метки сессий независимы', () => {
    useNotificationStore.getState().markSessionAcked('s1', 1_000)
    useNotificationStore.getState().markSessionAcked('s2', 5_000)

    expect(useNotificationStore.getState().getAckedAt('s1')).toBe(1_000)
    expect(useNotificationStore.getState().getAckedAt('s2')).toBe(5_000)
    expect(useNotificationStore.getState().getAckedAt('s3')).toBeUndefined()
  })

  it('в persist попадают только предпочтения — метки остаются runtime', () => {
    useNotificationStore.getState().markSessionAcked('s1', 1_000)
    const raw = globalThis.localStorage.getItem('synth-ui-notifications')

    expect(raw).not.toBeNull()
    expect(raw!).not.toContain('ackedAtBySession')
    expect(raw!).toContain('prefs')
  })
})
