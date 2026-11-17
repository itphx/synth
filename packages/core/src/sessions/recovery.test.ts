import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { SessionRecoveryState } from '@itphx/synth-shared';
import {
  evaluateRecovery,
  recordRecoveryAttempt,
  resetRecoveryState,
  MAX_RECOVERY_ATTEMPT_MARKERS,
  type RecoveryBudgetConfig,
} from './recovery.js';

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

describe('evaluateRecovery (PROP-142 §3)', () => {
  it('пустое состояние — автовосстановление разрешено', () => {
    expect(evaluateRecovery(undefined, BASE_CFG, NOW)).toEqual({ allowed: true });
    expect(evaluateRecovery({ attempts: 0, attemptsAt: [] }, BASE_CFG, NOW)).toEqual({
      allowed: true,
    });
  });

  it('autoResume=false → disabled', () => {
    const decision = evaluateRecovery(undefined, { ...BASE_CFG, autoResume: false }, NOW);
    expect(decision).toEqual({ allowed: false, reason: 'disabled' });
  });

  it('attempts >= maxAttempts → attempts', () => {
    const state: SessionRecoveryState = {
      attempts: 3,
      attemptsAt: [minutesAgo(1)],
    };
    expect(evaluateRecovery(state, BASE_CFG, NOW)).toEqual({
      allowed: false,
      reason: 'attempts',
    });
    // Бюджет не исчерпан — ещё можно.
    expect(evaluateRecovery({ ...state, attempts: 2 }, BASE_CFG, NOW)).toEqual({ allowed: true });
  });

  it('crash-loop: 3 попытки в окне 10 минут при maxRestarts=3 → crash_loop', () => {
    const state: SessionRecoveryState = {
      attempts: 2,
      attemptsAt: [minutesAgo(9), minutesAgo(5), minutesAgo(1)],
    };
    expect(evaluateRecovery(state, BASE_CFG, NOW)).toEqual({
      allowed: false,
      reason: 'crash_loop',
    });
  });

  it('попытки вне окна не считаются crash-loop', () => {
    const state: SessionRecoveryState = {
      attempts: 2,
      attemptsAt: [minutesAgo(60), minutesAgo(30), minutesAgo(11)],
    };
    expect(evaluateRecovery(state, BASE_CFG, NOW)).toEqual({ allowed: true });
  });

  it('невалидные метки времени игнорируются', () => {
    const state: SessionRecoveryState = {
      attempts: 0,
      attemptsAt: ['не дата', minutesAgo(1)],
    };
    expect(evaluateRecovery(state, BASE_CFG, NOW)).toEqual({ allowed: true });
  });

  it('мусорное состояние (attemptsAt не массив) не роняет проверку', () => {
    const state = { attempts: 0, attemptsAt: 'мусор' } as unknown as SessionRecoveryState;
    expect(evaluateRecovery(state, BASE_CFG, NOW)).toEqual({ allowed: true });
  });

  it('проверка попыток идёт раньше crash-loop', () => {
    const state: SessionRecoveryState = {
      attempts: 5,
      attemptsAt: [minutesAgo(1), minutesAgo(2), minutesAgo(3)],
    };
    expect(evaluateRecovery(state, BASE_CFG, NOW)).toEqual({
      allowed: false,
      reason: 'attempts',
    });
  });
});

describe('recordRecoveryAttempt / resetRecoveryState (PROP-142 §3)', () => {
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-recovery-'));
    manager = new SessionManager(new FileStore({ dataDir: tmpDir }), { instanceId: 'owner-current' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('счётчик растёт, метки копятся, lastAt проставляется', async () => {
    const session = await manager.createSession({ title: 'Recovery' });

    const first = await recordRecoveryAttempt(manager, session.id, NOW);
    expect(first.attempts).toBe(1);
    expect(first.attemptsAt).toEqual([NOW.toISOString()]);
    expect(first.lastAt).toBe(NOW.toISOString());

    const second = await recordRecoveryAttempt(
      manager,
      session.id,
      new Date(NOW.getTime() + 60_000),
    );
    expect(second.attempts).toBe(2);
    expect(second.attemptsAt).toHaveLength(2);
    expect(second.lastAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());

    const stored = (await manager.getSession(session.id))!;
    expect(stored.status.recovery).toEqual(second);
  });

  it('метки попыток ограничены хвостом (≤ 10)', async () => {
    const session = await manager.createSession({ title: 'Recovery tail' });

    let state!: SessionRecoveryState;
    for (let i = 0; i < MAX_RECOVERY_ATTEMPT_MARKERS + 5; i += 1) {
      state = await recordRecoveryAttempt(
        manager,
        session.id,
        new Date(NOW.getTime() + i * 60_000),
      );
    }

    expect(state.attempts).toBe(MAX_RECOVERY_ATTEMPT_MARKERS + 5);
    expect(state.attemptsAt).toHaveLength(MAX_RECOVERY_ATTEMPT_MARKERS);
    // Хвост: самые свежие метки, самая ранняя из хвоста — 6-я попытка.
    expect(state.attemptsAt[0]).toBe(
      new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    );
    expect(state.lastAt).toBe(
      new Date(NOW.getTime() + (MAX_RECOVERY_ATTEMPT_MARKERS + 4) * 60_000).toISOString(),
    );
  });

  it('updatedAt сессии не двигается (служебная отметка)', async () => {
    const session = await manager.createSession({ title: 'Recovery updatedAt' });
    const before = (await manager.getSession(session.id))!.updatedAt;

    await recordRecoveryAttempt(manager, session.id, NOW);

    const after = (await manager.getSession(session.id))!.updatedAt;
    expect(after).toBe(before);
  });

  it('resetRecoveryState убирает поле, evaluate снова разрешает', async () => {
    const session = await manager.createSession({ title: 'Recovery reset' });
    await recordRecoveryAttempt(manager, session.id, NOW);

    const denied = evaluateRecovery(
      (await manager.getSession(session.id))!.status.recovery,
      { ...BASE_CFG, maxAttempts: 1 },
      NOW,
    );
    expect(denied).toEqual({ allowed: false, reason: 'attempts' });

    await resetRecoveryState(manager, session.id);

    const stored = (await manager.getSession(session.id))!;
    expect(stored.status.recovery).toBeUndefined();
    expect(evaluateRecovery(stored.status.recovery, BASE_CFG, NOW)).toEqual({ allowed: true });
  });

  it('resetRecoveryState на сессии без счётчика — no-op', async () => {
    const session = await manager.createSession({ title: 'Recovery reset noop' });
    const before = (await manager.getSession(session.id))!.updatedAt;

    await resetRecoveryState(manager, session.id);

    const stored = (await manager.getSession(session.id))!;
    expect(stored.status.recovery).toBeUndefined();
    expect(stored.updatedAt).toBe(before);
  });

  it('несуществующая сессия — понятная ошибка', async () => {
    await expect(recordRecoveryAttempt(manager, 'нет-такой', NOW)).rejects.toThrow(/не найдена/);
    await expect(resetRecoveryState(manager, 'нет-такой')).rejects.toThrow(/не найдена/);
  });
});
