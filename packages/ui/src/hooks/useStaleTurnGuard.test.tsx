/**
 * Рантайм-сторож зависших ходов (ADR-118 §5).
 *
 * Индикатор «идёт работа» берётся из живого стора (`turnBySession.status`).
 * Если терминальное событие потерялось, а сервер уже закончил ход, сторож
 * сверяется с `GET /sessions/:id` (`activity.idle` + пустой `status.blocked`) и
 * закрывает ход; при недоступном сервере — по жёсткому таймауту тишины.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMocks = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getSession: apiMocks.getSession, getSessionMessages: vi.fn(), getStickyNotes: vi.fn() } }))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: vi.fn() }))

import {
  runStaleTurnGuardTick,
  useStaleTurnGuard,
  STALE_TURN_GUARD_INTERVAL_MS,
  STALE_TURN_SILENCE_MS,
  STALE_TURN_TIMEOUT_MS,
} from './useStaleTurnGuard'
import { lastEventAtBySession } from '@/stores/transportStore'
import { useChatStore } from '@/stores/chatStore'
import { resetChatStore } from '@/stores/testUtils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const T0 = new Date('2026-11-20T10:00:00.000Z').getTime()

/** Ход, которому `silenceMs` миллисекунд тишины (событий не было). */
function seedHungTurn(silenceMs: number): void {
  lastEventAtBySession.set(SESSION, T0 - silenceMs)
  useChatStore.getState().startTurn(SESSION, { turnId: 't-1', status: 'streaming' })
  // `startTurn` ставит метку «сейчас» — сдвигаем её в прошлое: ход давно идёт.
  useChatStore.getState().patchTurn(SESSION, { startedAt: T0 - silenceMs })
}

function turn() {
  return useChatStore.getState().turnBySession[SESSION]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  resetChatStore()
  lastEventAtBySession.clear()
  apiMocks.getSession.mockResolvedValue({ id: SESSION, activity: { type: 'idle' }, status: { blocked: null } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runStaleTurnGuardTick', () => {
  it('тишина меньше порога — сервер не спрашиваем', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS - 1000)
    const getSession = vi.fn()

    await runStaleTurnGuardTick({ getSession })

    expect(getSession).not.toHaveBeenCalled()
    expect(turn()?.status).toBe('streaming')
  })

  it('тишина больше порога + сервер: idle → ход закрыт', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    const getSession = vi.fn(async () => ({ activity: { type: 'idle' }, status: { blocked: null } }))

    await runStaleTurnGuardTick({ getSession })

    expect(getSession).toHaveBeenCalledWith(SESSION)
    expect(turn()?.status).toBe('stopped')
  })

  it('тишина больше порога + сервер: busy → ход остаётся живым', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    const getSession = vi.fn(async () => ({ activity: { type: 'busy' }, status: { blocked: null } }))

    await runStaleTurnGuardTick({ getSession })

    expect(getSession).toHaveBeenCalledTimes(1)
    expect(turn()?.status).toBe('streaming')
  })

  it('сервер ждёт подтверждения (blocked) — ход не закрываем даже при idle', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    const getSession = vi.fn(async () => ({ activity: { type: 'idle' }, status: { blocked: 'LOCKED' } }))

    await runStaleTurnGuardTick({ getSession })

    expect(turn()?.status).toBe('streaming')
  })

  it('запрос не удался, тишина меньше жёсткого таймаута → ждём следующий тик', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    const getSession = vi.fn(async () => { throw new Error('network down') })

    await runStaleTurnGuardTick({ getSession })

    expect(turn()?.status).toBe('streaming')
  })

  it('запрос не удался, тишина больше жёсткого таймаута → закрываем по таймауту', async () => {
    seedHungTurn(STALE_TURN_TIMEOUT_MS + 10_000)
    const getSession = vi.fn(async () => { throw new Error('network down') })

    await runStaleTurnGuardTick({ getSession })

    expect(turn()?.status).toBe('stopped')
  })

  it('закрытых ходов не трогает', async () => {
    useChatStore.getState().startTurn(SESSION, { turnId: 't-1', status: 'completed' })
    const getSession = vi.fn()

    await runStaleTurnGuardTick({ getSession })

    expect(getSession).not.toHaveBeenCalled()
    expect(turn()?.status).toBe('completed')
  })
})

// ===== Проводка хука: интервал + видимость вкладки =====

const roots: Array<{ root: Root; container: HTMLElement }> = []
let visibility: DocumentVisibilityState = 'visible'

function Probe() {
  useStaleTurnGuard()
  return null
}

async function mount(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => { root.render(<Probe />) })
}

/** Промисы тика — микротаски: fake timers их не двигают, флашим вручную. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => { root.unmount() })
    container.remove()
  }
})

describe('useStaleTurnGuard', () => {
  it('по интервалу закрывает зависший ход (сервер: idle)', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    await mount()

    // Первого тика на монтировании нет — ждём интервал.
    expect(apiMocks.getSession).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(STALE_TURN_GUARD_INTERVAL_MS) })
    await flush()

    expect(apiMocks.getSession).toHaveBeenCalledWith(SESSION)
    expect(turn()?.status).toBe('stopped')
  })

  it('пока вкладка скрыта — тики пропускаются', async () => {
    visibility = 'hidden'
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    await mount()

    await act(async () => { vi.advanceTimersByTime(STALE_TURN_GUARD_INTERVAL_MS * 2) })
    await flush()

    expect(apiMocks.getSession).not.toHaveBeenCalled()
    expect(turn()?.status).toBe('streaming')
  })

  it('возврат видимости — немедленная проверка', async () => {
    visibility = 'hidden'
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    await mount()

    visibility = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()

    expect(apiMocks.getSession).toHaveBeenCalledWith(SESSION)
    expect(turn()?.status).toBe('stopped')
  })

  it('после размонтирования таймеров не остаётся', async () => {
    seedHungTurn(STALE_TURN_SILENCE_MS + 10_000)
    await mount()
    const { root, container } = roots.pop()!
    await act(async () => { root.unmount() })
    container.remove()

    await act(async () => { vi.advanceTimersByTime(STALE_TURN_GUARD_INTERVAL_MS * 3) })
    await flush()

    expect(apiMocks.getSession).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
