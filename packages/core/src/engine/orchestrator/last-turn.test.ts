/**
 * Durable-исход последнего хода сессии (`status.lastTurn`).
 *
 * Контракты:
 *  - таблица «терминальный статус сообщения хода → грубый класс исхода»:
 *    `completed`/`interrupted` → `completed`, `limit` (и исполненный шаг-лимит)
 *    → `limit` + `steps_limit`, `stopped` → `stopped`, `cancelled` →
 *    `cancelled`, `error` → `error`;
 *  - причина (`StopReason`, PROP-143) выводится из ключа фоллбека: лимит шагов,
 *    лимит вывода, пустой ответ, отказ прав, пользовательский «Стоп»;
 *  - запись — **точечная мутация** метаданных без `touchUpdatedAt` (служебная
 *    отметка не «оживляет» сессию в списках) и не ломает ход при сбое.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { lastTurnOutcomeFor, recordLastTurn } from './last-turn.js';

describe('lastTurnOutcomeFor — таблица исходов хода', () => {
  it('успешный ход → completed без причины', () => {
    expect(lastTurnOutcomeFor('completed')).toEqual({ outcome: 'completed' });
  });

  it('interrupted (ADR-104: прерывание внутри хода) → completed', () => {
    expect(lastTurnOutcomeFor('interrupted')).toEqual({ outcome: 'completed' });
  });

  it('лимит шагов → limit + steps_limit', () => {
    expect(lastTurnOutcomeFor('limit', { stepLimitReached: true })).toEqual({
      outcome: 'limit',
      reason: 'steps_limit',
    });
    // Статус `limit` без флага (лимит итераций/исчерпанные продолжения):
    // известный ключ уточняет причину, неизвестный/отсутствующий — steps_limit.
    expect(lastTurnOutcomeFor('limit')).toEqual({ outcome: 'limit', reason: 'steps_limit' });
    expect(lastTurnOutcomeFor('limit', { i18nKey: 'session.max_iterations' })).toEqual({
      outcome: 'limit',
      reason: 'steps_limit',
    });
    expect(lastTurnOutcomeFor('limit', { i18nKey: 'session.output_limit_exhausted' })).toEqual({
      outcome: 'limit',
      reason: 'output_limit',
    });
  });

  it('исполненный шаг-лимит приоритетнее статуса сообщения', () => {
    expect(lastTurnOutcomeFor('completed', { stepLimitReached: true })).toEqual({
      outcome: 'limit',
      reason: 'steps_limit',
    });
  });

  it('отказ прав → stopped + denied; ролевой отказ — тоже denied', () => {
    expect(lastTurnOutcomeFor('stopped', { i18nKey: 'session.denied_blocked' })).toEqual({
      outcome: 'stopped',
      reason: 'denied',
    });
    expect(lastTurnOutcomeFor('stopped', { i18nKey: 'session.role_tool_blocked' })).toEqual({
      outcome: 'stopped',
      reason: 'denied',
    });
  });

  it('пользовательский «Стоп» по ключу → stopped_by_user', () => {
    expect(lastTurnOutcomeFor('stopped', { i18nKey: 'session.stopped' })).toEqual({
      outcome: 'stopped',
      reason: 'stopped_by_user',
    });
  });

  it('stopped без известного ключа → stopped без причины', () => {
    expect(lastTurnOutcomeFor('stopped')).toEqual({ outcome: 'stopped' });
  });

  it('ошибка → error; причина известна по ключу (пустой ответ, лимит вывода)', () => {
    expect(lastTurnOutcomeFor('error')).toEqual({ outcome: 'error' });
    expect(lastTurnOutcomeFor('error', { i18nKey: 'session.empty_response' })).toEqual({
      outcome: 'error',
      reason: 'empty',
    });
    expect(lastTurnOutcomeFor('error', { i18nKey: 'session.output_limit' })).toEqual({
      outcome: 'error',
      reason: 'output_limit',
    });
    // Неизвестный ключ не выдумывает причину.
    expect(lastTurnOutcomeFor('error', { i18nKey: 'router.rate_limit_exceeded' })).toEqual({
      outcome: 'error',
    });
  });

  it('отмена хода → cancelled (без причины, если ключа нет)', () => {
    expect(lastTurnOutcomeFor('cancelled')).toEqual({ outcome: 'cancelled' });
  });
});

describe('recordLastTurn — точечная запись в документ сессии', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-last-turn-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('пишет outcome/reason/at в status.lastTurn и не двигает updatedAt', async () => {
    const session = await sessionManager.createSession({ title: 'L' });
    const before = (await sessionManager.getSession(session.id))!.updatedAt;

    const written = await recordLastTurn(sessionManager, session.id, {
      outcome: 'error',
      reason: 'provider_error',
      now: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(written).toEqual({
      outcome: 'error',
      reason: 'provider_error',
      at: '2026-01-02T03:04:05.000Z',
    });
    const after = (await sessionManager.getSession(session.id))!;
    expect(after.status.lastTurn).toEqual(written);
    // Служебная отметка не «оживляет» сессию в списках.
    expect(after.updatedAt).toBe(before);
  });

  it('без причины поле reason в документ не попадает', async () => {
    const session = await sessionManager.createSession({ title: 'L' });

    await recordLastTurn(sessionManager, session.id, { outcome: 'completed' });

    const stored = (await sessionManager.getSession(session.id))!.status.lastTurn!;
    expect(stored.outcome).toBe('completed');
    expect('reason' in stored).toBe(false);
    expect(typeof stored.at).toBe('string');
  });

  it('перезапись: следующий финализатор заменяет значение (поле не копится)', async () => {
    const session = await sessionManager.createSession({ title: 'L' });

    await recordLastTurn(sessionManager, session.id, { outcome: 'error', reason: 'internal' });
    await recordLastTurn(sessionManager, session.id, { outcome: 'completed' });

    const stored = (await sessionManager.getSession(session.id))!.status.lastTurn!;
    expect(stored).toEqual({ outcome: 'completed', at: expect.any(String) });
  });

  it('сессии нет → null (писать некуда, без исключения)', async () => {
    await expect(
      recordLastTurn(sessionManager, 'нет-такой', { outcome: 'completed' }),
    ).resolves.toBeNull();
  });

  it('сбой хранилища не пробрасывается (исход хода — производная отметка)', async () => {
    const failing = {
      mutateMeta: async () => {
        throw new Error('storage down');
      },
    } as unknown as SessionManager;

    await expect(
      recordLastTurn(failing, 'sess', { outcome: 'error', reason: 'provider_error' }),
    ).resolves.toBeNull();
  });
});
