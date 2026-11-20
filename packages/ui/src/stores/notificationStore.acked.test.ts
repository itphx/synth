/**
 * Метка «просмотрено» в `notificationStore` (`ackedTurnBySession`).
 *
 * Метка — вход модели `sessionBadgeState` (`lib/sessionBadgeState.ts`): если
 * ключ сохранённого исхода **совпал** с ключом текущего `status.last_turn`,
 * человек этот исход уже видел. Ключ (`"<outcome>|<at>"`, см. `turnKey`)
 * строится из серверных данных, поэтому расхождение часов клиента и сервера на
 * него не влияет — и метку теперь можно персистить (см. комментарий к полю в
 * сторе).
 *
 * Проверяется: запись и идемпотентность, персист и восстановление (эмуляция
 * перезагрузки страницы — ключевой сценарий бага), ограничение размера карты,
 * очистка при удалении сессии.
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
    /** Все ключи разом — тестам нужно «сохранить и подменить» состояние диска. */
    keys: () => [...data.keys()],
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

import { useNotificationStore, MAX_ACKED_SESSIONS } from './notificationStore'
import { sessionBadgeState, turnKey } from '@/lib/sessionBadgeState'

const STORAGE_KEY = 'synth-ui-notifications'
const TURN_AT = '2026-01-01T12:00:00.000Z'
const COMPLETED_KEY = turnKey({ outcome: 'completed', at: TURN_AT })!
const ERROR_KEY = turnKey({ outcome: 'error', at: TURN_AT })!

beforeEach(() => {
  localStorage.clear()
  useNotificationStore.setState({ ackedTurnBySession: {} })
})

describe('notificationStore — метка «просмотрено»', () => {
  it('без отметки метки нет', () => {
    expect(useNotificationStore.getState().getAckedTurnKey('s1')).toBeUndefined()
  })

  it('markSessionAcked записывает ключ исхода', () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)

    expect(useNotificationStore.getState().getAckedTurnKey('s1')).toBe(COMPLETED_KEY)
    expect(useNotificationStore.getState().ackedTurnBySession).toEqual({ s1: COMPLETED_KEY })
  })

  it('идемпотентно: тот же ключ не переписывает состояние (без лишних рендеров)', () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)
    const state = useNotificationStore.getState()
    state.markSessionAcked('s1', COMPLETED_KEY)

    expect(useNotificationStore.getState().ackedTurnBySession).toBe(state.ackedTurnBySession)
  })

  it('новый исход (другой ключ) перезаписывает метку', () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)
    useNotificationStore.getState().markSessionAcked('s1', ERROR_KEY)

    expect(useNotificationStore.getState().getAckedTurnKey('s1')).toBe(ERROR_KEY)
  })

  it('пустой ключ/пустой id — no-op (отмечать нечего)', () => {
    const state = useNotificationStore.getState()
    state.markSessionAcked('s1', '')
    state.markSessionAcked('', COMPLETED_KEY)

    expect(useNotificationStore.getState().getAckedTurnKey('s1')).toBeUndefined()
    expect(useNotificationStore.getState().ackedTurnBySession).toEqual({})
  })

  it('метки сессий независимы', () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)
    useNotificationStore.getState().markSessionAcked('s2', ERROR_KEY)

    expect(useNotificationStore.getState().getAckedTurnKey('s1')).toBe(COMPLETED_KEY)
    expect(useNotificationStore.getState().getAckedTurnKey('s2')).toBe(ERROR_KEY)
    expect(useNotificationStore.getState().getAckedTurnKey('s3')).toBeUndefined()
  })

  it('clearSessionAcked забывает метку (и не трогает соседние)', () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)
    useNotificationStore.getState().markSessionAcked('s2', ERROR_KEY)

    useNotificationStore.getState().clearSessionAcked('s1')

    expect(useNotificationStore.getState().getAckedTurnKey('s1')).toBeUndefined()
    expect(useNotificationStore.getState().getAckedTurnKey('s2')).toBe(ERROR_KEY)
    // Повторная очистка — no-op (то же состояние).
    const state = useNotificationStore.getState()
    state.clearSessionAcked('s1')
    expect(useNotificationStore.getState().ackedTurnBySession).toBe(state.ackedTurnBySession)
  })
})

describe('notificationStore — persist метки «просмотрено»', () => {
  it('ключ попадает в сохраняемое состояние', () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)
    const raw = localStorage.getItem(STORAGE_KEY)

    expect(raw).not.toBeNull()
    expect(raw!).toContain('ackedTurnBySession')
    expect(raw!).toContain(COMPLETED_KEY)
    expect(raw!).toContain('prefs')
  })

  it('«перезагрузка страницы»: метка восстанавливается из persist', async () => {
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)

    // Перезагрузка = новый инстанс модуля: in-memory часть пуста, данные — из
    // localStorage (тот же диск).
    vi.resetModules()
    const fresh = await import('./notificationStore')

    expect(fresh.useNotificationStore.getState().getAckedTurnKey('s1')).toBe(COMPLETED_KEY)
  })

  it('«перезагрузка» + новая версия бэкенда: битые значения отбрасываются', async () => {
    // Ручная правка/старый формат: значения обязаны быть непустыми строками.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { ackedTurnBySession: { s1: COMPLETED_KEY, s2: 42, s3: '' } },
        version: 0,
      }),
    )

    vi.resetModules()
    const fresh = await import('./notificationStore')

    expect(fresh.useNotificationStore.getState().ackedTurnBySession).toEqual({ s1: COMPLETED_KEY })
  })

  it('стародавний persist без меток не ломает стор', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { prefs: {} }, version: 0 }))

    vi.resetModules()
    const fresh = await import('./notificationStore')

    expect(fresh.useNotificationStore.getState().ackedTurnBySession).toEqual({})
  })
})

describe('notificationStore — ограничение роста карты', () => {
  it(`не более ${MAX_ACKED_SESSIONS} сессий: вытесняются самые старые записи`, () => {
    const total = MAX_ACKED_SESSIONS + 25
    for (let i = 0; i < total; i += 1) {
      useNotificationStore.getState().markSessionAcked(`s${i}`, COMPLETED_KEY)
    }

    const map = useNotificationStore.getState().ackedTurnBySession
    expect(Object.keys(map)).toHaveLength(MAX_ACKED_SESSIONS)
    // Первые 25 вытеснены, последняя — на месте.
    expect(map.s0).toBeUndefined()
    expect(map.s24).toBeUndefined()
    expect(map.s25).toBe(COMPLETED_KEY)
    expect(map[`s${total - 1}`]).toBe(COMPLETED_KEY)
  })

  it('повторная отметка сессии переставляет её в конец (активная не вытесняется первой)', () => {
    // Заполняем карту ровно до предела, затем трогаем самую старую сессию.
    for (let i = 0; i < MAX_ACKED_SESSIONS; i += 1) {
      useNotificationStore.getState().markSessionAcked(`s${i}`, COMPLETED_KEY)
    }
    useNotificationStore.getState().markSessionAcked('s0', ERROR_KEY)
    // Новая сессия вытеснит самую старую по порядку записи — это `s1`, не `s0`.
    useNotificationStore.getState().markSessionAcked('fresh', COMPLETED_KEY)

    const map = useNotificationStore.getState().ackedTurnBySession
    expect(Object.keys(map)).toHaveLength(MAX_ACKED_SESSIONS)
    expect(map.s0).toBe(ERROR_KEY)
    expect(map.s1).toBeUndefined()
    expect(map.fresh).toBe(COMPLETED_KEY)
  })

  it('разросшаяся карта из localStorage обрезается при восстановлении', async () => {
    const huge: Record<string, string> = {}
    for (let i = 0; i < MAX_ACKED_SESSIONS + 50; i += 1) huge[`s${i}`] = COMPLETED_KEY
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { ackedTurnBySession: huge }, version: 0 }))

    vi.resetModules()
    const fresh = await import('./notificationStore')

    const map = fresh.useNotificationStore.getState().ackedTurnBySession
    expect(Object.keys(map)).toHaveLength(MAX_ACKED_SESSIONS)
    expect(map.s49).toBeUndefined()
    expect(map.s50).toBe(COMPLETED_KEY)
  })
})

/**
 * Ключевой сценарий бага владельца: завершённые **уже просмотренные** сессии
 * снова красились после обновления страницы (метка жила только в памяти).
 *
 * Теперь метка — ключ исхода, сравниваемый на равенство, поэтому она
 * переживает reload и при этом не «залипает»: новый ход даёт новый ключ.
 */
describe('notificationStore — регресс: цвет после перезагрузки страницы', () => {
  const session = (at: string) => ({
    id: 's1',
    parent_id: null,
    todos: [],
    status: { blocked: null, last_turn: { outcome: 'completed' as const, at } },
    pending_approvals: 0,
    activity: { type: 'idle' as const },
  })
  const live = {
    streaming: false,
    queuePending: 0,
    queueStalled: false,
    hasOpenQuestion: false,
    approvalRequests: 0,
  }
  const tone = (s: ReturnType<typeof session>, ackedTurnKey?: string) =>
    sessionBadgeState({
      session: s,
      live,
      ackedTurnKey: ackedTurnKey ?? null,
    }).labelTone

  it('после reload просмотренное завершение НЕ зелёное, а новый исход — зелёный', async () => {
    // 1. Человек посмотрел завершённый ход — ChatTab записал ключ.
    useNotificationStore.getState().markSessionAcked('s1', COMPLETED_KEY)
    expect(tone(session(TURN_AT), useNotificationStore.getState().getAckedTurnKey('s1'))).toBe(
      'neutral',
    )

    // 2. Перезагрузка страницы: новый инстанс модуля, состояние — из persist.
    vi.resetModules()
    const fresh = await import('./notificationStore')

    // 3. Просмотренное завершение больше не красится (баг был здесь).
    expect(
      tone(session(TURN_AT), fresh.useNotificationStore.getState().getAckedTurnKey('s1')),
    ).toBe('neutral')

    // 4. Новый ход даёт новый `at` → другой ключ → зелёный возвращается.
    const newTurnAt = '2026-01-02T09:00:00.000Z'
    expect(
      tone(session(newTurnAt), fresh.useNotificationStore.getState().getAckedTurnKey('s1')),
    ).toBe('success')
  })

  it('ошибка: просмотренная после reload не красная, новая — красная', async () => {
    useNotificationStore.getState().markSessionAcked('s1', ERROR_KEY)

    vi.resetModules()
    const fresh = await import('./notificationStore')
    const acked = fresh.useNotificationStore.getState().getAckedTurnKey('s1')

    const errorSession = (at: string) => ({
      id: 's1',
      parent_id: null,
      todos: [],
      status: { blocked: null, last_turn: { outcome: 'error' as const, at } },
      pending_approvals: 0,
      activity: { type: 'idle' as const },
    })
    expect(sessionBadgeState({ session: errorSession(TURN_AT), live, ackedTurnKey: acked }).labelTone)
      .toBe('neutral')
    expect(
      sessionBadgeState({
        session: errorSession('2026-01-02T09:00:00.000Z'),
        live,
        ackedTurnKey: acked,
      }).labelTone,
    ).toBe('error')
  })
})
