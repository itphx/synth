/**
 * PROP-142 §3: планировщик автовосстановления при старте инстанса.
 *
 * Контракты:
 *  - основная сессия → `resume-main`, дочерняя (`parentId`/`subagent`) →
 *    `resume-child`;
 *  - отказ по бюджету → `deny` с причиной (`disabled`/`attempts`/
 *    `crash_loop`), приоритет — `attempts` перед `crash_loop`;
 *  - порядок планов совпадает с порядком сессий во входе;
 *  - бюджет собирается из секции `recovery` конфига, при её отсутствии —
 *    дефолты.
 */
import { describe, it, expect } from 'vitest';
import type { SessionRecoveryState } from '@itphx/synth-shared';
import type { RecoveryBudgetConfig } from './recovery.js';
import {
  planBootRecovery,
  isChildSession,
  resolveRecoveryBudget,
  DEFAULT_RECOVERY_BUDGET,
} from './recovery-boot.js';

const BASE_CFG: RecoveryBudgetConfig = {
  autoResume: true,
  maxAttempts: 3,
  windowMinutes: 10,
  maxRestarts: 3,
};

const NOW = new Date('2026-11-18T12:00:00.000Z');

/** Метка попытки «N минут назад» относительно `NOW`. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe('planBootRecovery: вид возобновления (PROP-142 §3)', () => {
  it('основная сессия → resume-main', () => {
    const plans = planBootRecovery({
      sessions: [{ id: 's1' }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'resume-main', sessionId: 's1' }]);
  });

  it('дочерняя сессия (parentId) → resume-child', () => {
    const plans = planBootRecovery({
      sessions: [{ id: 'c1', parentId: 's1' }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'resume-child', sessionId: 'c1' }]);
  });

  it('дочерняя сессия (sessionOrigin=subagent) → resume-child', () => {
    const plans = planBootRecovery({
      sessions: [{ id: 'c2', sessionOrigin: 'subagent' }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'resume-child', sessionId: 'c2' }]);
  });

  it('порядок планов совпадает с порядком сессий во входе', () => {
    const plans = planBootRecovery({
      sessions: [{ id: 'a' }, { id: 'b', parentId: 'a' }, { id: 'c' }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans.map((p) => [p.action, p.sessionId])).toEqual([
      ['resume-main', 'a'],
      ['resume-child', 'b'],
      ['resume-main', 'c'],
    ]);
  });

  it('isChildSession: оба признака дочерней сессии', () => {
    expect(isChildSession({})).toBe(false);
    expect(isChildSession({ sessionOrigin: 'user' })).toBe(false);
    expect(isChildSession({ parentId: 'p' })).toBe(true);
    expect(isChildSession({ sessionOrigin: 'subagent' })).toBe(true);
  });
});

describe('planBootRecovery: отказ по бюджету (PROP-142 §3)', () => {
  it('autoResume=false → deny(disabled)', () => {
    const plans = planBootRecovery({
      sessions: [{ id: 's1' }, { id: 'c1', parentId: 's1' }],
      config: { ...BASE_CFG, autoResume: false },
      now: NOW,
    });
    expect(plans).toEqual([
      { action: 'deny', sessionId: 's1', reason: 'disabled' },
      { action: 'deny', sessionId: 'c1', reason: 'disabled' },
    ]);
  });

  it('attempts >= maxAttempts → deny(attempts)', () => {
    const recovery: SessionRecoveryState = { attempts: 3, attemptsAt: [minutesAgo(1)] };
    const plans = planBootRecovery({
      sessions: [{ id: 's1', recovery }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'deny', sessionId: 's1', reason: 'attempts' }]);
  });

  it('попыток в окне >= maxRestarts → deny(crash_loop)', () => {
    const recovery: SessionRecoveryState = {
      attempts: 2,
      attemptsAt: [minutesAgo(9), minutesAgo(5), minutesAgo(1)],
    };
    const plans = planBootRecovery({
      sessions: [{ id: 's1', recovery }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'deny', sessionId: 's1', reason: 'crash_loop' }]);
  });

  it('приоритет: исчерпанные попытки проверяются раньше crash-loop', () => {
    const recovery: SessionRecoveryState = {
      attempts: 5,
      attemptsAt: [minutesAgo(1), minutesAgo(2), minutesAgo(3)],
    };
    const plans = planBootRecovery({
      sessions: [{ id: 's1', recovery }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'deny', sessionId: 's1', reason: 'attempts' }]);
  });

  it('бюджет ребёнка — тот же, что у основной сессии', () => {
    const recovery: SessionRecoveryState = { attempts: 3, attemptsAt: [minutesAgo(1)] };
    const plans = planBootRecovery({
      sessions: [{ id: 'c1', parentId: 's1', recovery }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'deny', sessionId: 'c1', reason: 'attempts' }]);
  });

  it('попытки вне окна crash-loop не блокируют возобновление', () => {
    const recovery: SessionRecoveryState = {
      attempts: 2,
      attemptsAt: [minutesAgo(60), minutesAgo(30), minutesAgo(11)],
    };
    const plans = planBootRecovery({
      sessions: [{ id: 's1', recovery }],
      config: BASE_CFG,
      now: NOW,
    });
    expect(plans).toEqual([{ action: 'resume-main', sessionId: 's1' }]);
  });
});

describe('resolveRecoveryBudget (секция `recovery` конфига)', () => {
  it('секция не найдена → дефолты', () => {
    expect(resolveRecoveryBudget(undefined)).toEqual(DEFAULT_RECOVERY_BUDGET);
    expect(resolveRecoveryBudget({})).toEqual(DEFAULT_RECOVERY_BUDGET);
  });

  it('сама секция recovery', () => {
    const budget = resolveRecoveryBudget({
      autoResume: false,
      maxAttempts: 5,
      crashLoop: { windowMinutes: 30, maxRestarts: 7 },
    });
    expect(budget).toEqual({
      autoResume: false,
      maxAttempts: 5,
      windowMinutes: 30,
      maxRestarts: 7,
    });
  });

  it('объект с полем recovery', () => {
    const budget = resolveRecoveryBudget({
      recovery: { autoResume: true, maxAttempts: 2, crashLoop: { windowMinutes: 5, maxRestarts: 2 } },
    });
    expect(budget).toEqual({
      autoResume: true,
      maxAttempts: 2,
      windowMinutes: 5,
      maxRestarts: 2,
    });
  });

  it('объект с полем synth.recovery (managed-конфиг)', () => {
    const budget = resolveRecoveryBudget({
      synth: {
        recovery: { autoResume: false, maxAttempts: 1, crashLoop: { windowMinutes: 2, maxRestarts: 2 } },
      },
    });
    expect(budget).toEqual({
      autoResume: false,
      maxAttempts: 1,
      windowMinutes: 2,
      maxRestarts: 2,
    });
  });

  it('невалидные значения → дефолт (fail-safe)', () => {
    const budget = resolveRecoveryBudget({
      recovery: { autoResume: 'да', maxAttempts: 0, crashLoop: { windowMinutes: -1 } },
    });
    expect(budget).toEqual(DEFAULT_RECOVERY_BUDGET);
  });
});
