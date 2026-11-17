import { describe, it, expect } from 'vitest'

import { countSessionActivity } from './sessionActivity'
import type { BackgroundRunRecord, Timer } from '@/lib/api/synthApi'
import type { TerminalDto } from '@/lib/api/terminals'

/** Фоновый прогон (процесс или саб-агент). */
function makeRun(
  id: string,
  overrides: Partial<BackgroundRunRecord> = {},
): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 's1',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Терминал (live по умолчанию). */
function makeTerminal(
  id: string,
  overrides: Partial<TerminalDto> = {},
): TerminalDto {
  return {
    id,
    projectId: 'p1',
    sessionId: 's1',
    ownerId: null,
    cwd: '/workspace/demo',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    title: `Terminal ${id}`,
    can_write: true,
    attached_clients: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    exitCode: null,
    signal: null,
    target: null,
    ...overrides,
  }
}

/** Таймер/будильник (активный по умолчанию). */
function makeTimer(
  id: string,
  overrides: Partial<Timer> = {},
): Timer {
  return {
    id,
    kind: 'timer',
    comment: 'напомнить',
    projectId: 'p1',
    sessionId: 's1',
    ownerId: 'u1',
    repeat: { mode: 'once' },
    status: 'active',
    firesAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('countSessionActivity — активная фоновая работа по сессиям', () => {
  it('считает только выполняющиеся прогоны', () => {
    const counts = countSessionActivity(
      [
        makeRun('running-1'),
        makeRun('completed-1', { status: 'completed' }),
        makeRun('failed-1', { status: 'failed' }),
        makeRun('cancelled-1', { status: 'cancelled' }),
        makeRun('orphaned-1', { status: 'orphaned' }),
      ],
      [],
    )

    expect(counts.get('s1')).toEqual({
      processes: 1,
      subagents: 0,
      terminals: 0,
      timers: 0,
      alarms: 0,
    })
  })

  it('саб-агент считается по родительской сессии', () => {
    const counts = countSessionActivity(
      [
        makeRun('child-1', { kind: 'subagent', sessionId: 'parent-1', childSessionId: 'child-1' }),
        makeRun('child-2', { kind: 'subagent', sessionId: 'parent-1', status: 'completed' }),
      ],
      [],
    )

    expect(counts.get('parent-1')).toEqual({
      processes: 0,
      subagents: 1,
      terminals: 0,
      timers: 0,
      alarms: 0,
    })
    expect(counts.has('child-1')).toBe(false)
  })

  it('терминал без сессии не учитывается', () => {
    const counts = countSessionActivity(
      [],
      [makeTerminal('t1', { sessionId: null })],
    )

    expect(counts.size).toBe(0)
  })

  it('завершённый терминал не считается, живой — считается', () => {
    const counts = countSessionActivity(
      [],
      [
        makeTerminal('t-live'),
        makeTerminal('t-exited', { status: 'exited' }),
        makeTerminal('t-closing', { status: 'closing' }),
      ],
    )

    expect(counts.get('s1')).toEqual({
      processes: 0,
      subagents: 0,
      terminals: 2,
      timers: 0,
      alarms: 0,
    })
  })

  it('прогон без сессии-владельца не учитывается', () => {
    const counts = countSessionActivity([makeRun('no-session', { sessionId: '' })], [])

    expect(counts.size).toBe(0)
  })

  it('считает всё вместе по сессиям', () => {
    const counts = countSessionActivity(
      [
        makeRun('p1', { sessionId: 's1' }),
        makeRun('p2', { sessionId: 's1' }),
        makeRun('sub1', { kind: 'subagent', sessionId: 's1' }),
        makeRun('p3', { sessionId: 's2' }),
      ],
      [makeTerminal('t1', { sessionId: 's1' }), makeTerminal('t2', { sessionId: 's2' })],
    )

    expect(counts.get('s1')).toEqual({
      processes: 2,
      subagents: 1,
      terminals: 1,
      timers: 0,
      alarms: 0,
    })
    expect(counts.get('s2')).toEqual({
      processes: 1,
      subagents: 0,
      terminals: 1,
      timers: 0,
      alarms: 0,
    })
  })

  it('пустые входы дают пустую карту', () => {
    expect(countSessionActivity([], []).size).toBe(0)
  })

  // PROP-141: таймеры и будильники.

  it('активные таймеры и будильники считаются по видам', () => {
    const counts = countSessionActivity(
      [],
      [],
      [
        makeTimer('t1', { kind: 'timer' }),
        makeTimer('t2', { kind: 'timer' }),
        makeTimer('a1', { kind: 'alarm' }),
      ],
    )

    expect(counts.get('s1')).toEqual({
      processes: 0,
      subagents: 0,
      terminals: 0,
      timers: 2,
      alarms: 1,
    })
  })

  it('неактивные таймеры активностью не считаются', () => {
    const counts = countSessionActivity(
      [],
      [],
      [
        makeTimer('paused', { status: 'paused' }),
        makeTimer('fired', { status: 'fired' }),
        makeTimer('cancelled', { status: 'cancelled' }),
      ],
    )

    expect(counts.size).toBe(0)
  })

  it('таймер без сессии-получателя не учитывается', () => {
    const counts = countSessionActivity([], [], [makeTimer('no-session', { sessionId: '' })])

    expect(counts.size).toBe(0)
  })

  it('таймеры считаются вместе с прочими видами работы', () => {
    const counts = countSessionActivity(
      [makeRun('p1', { sessionId: 's1' })],
      [makeTerminal('t1', { sessionId: 's1' })],
      [makeTimer('tmr1', { sessionId: 's1' }), makeTimer('al1', { sessionId: 's1', kind: 'alarm' })],
    )

    expect(counts.get('s1')).toEqual({
      processes: 1,
      subagents: 0,
      terminals: 1,
      timers: 1,
      alarms: 1,
    })
  })

  it('без таймеров поведение прежнее (третий аргумент необязателен)', () => {
    const withTimers = countSessionActivity([], [], [])
    const withoutTimers = countSessionActivity([], [])

    expect(withTimers.size).toBe(0)
    expect(withoutTimers.size).toBe(0)
  })
})
