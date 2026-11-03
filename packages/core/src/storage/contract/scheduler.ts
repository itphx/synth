import { describe, expect, it } from 'vitest';
import type { JobRepository, ScheduleRepository } from '../ports/index.js';
import type { ScheduleInput, ScheduleJob } from '@itphx/synth-shared';

const scheduleInput = (name: string): ScheduleInput => ({
  name,
  enabled: true,
  cron: '* * * * *',
  target: { mode: 'bound', sessionId: 'sess-1' },
  prompt: 'tick',
});

function job(id: string, scheduleId: string): ScheduleJob {
  const now = new Date().toISOString();
  return {
    id,
    scheduleId,
    scheduleName: 'j',
    trigger: 'cron',
    status: 'ok',
    startedAt: now,
    finishedAt: now,
    durationMs: 1,
    target: { mode: 'bound', sessionId: 'sess-1' },
  };
}

/** Паспорт порта `ScheduleRepository`. */
export function describeScheduleRepository(
  name: string,
  make: () => Promise<{ repo: ScheduleRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/get/update/remove; неизвестный — null/false; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeNull();
      expect(await repo.remove('none')).toBe(false);

      const created = await repo.create(scheduleInput('first'));
      expect(created.id.startsWith('sch_')).toBe(true);
      expect((await repo.get(created.id))?.name).toBe('first');

      const updated = await repo.update(created.id, { name: 'renamed' });
      expect(updated?.name).toBe('renamed');
      expect(updated?.updatedAt).toBeTruthy();
      expect(await repo.remove(created.id)).toBe(true);
      expect(await repo.get(created.id)).toBeNull();
    });

    it('update: пара триггеров заменяется целиком (cron ↔ every), патч без них не трогает', async () => {
      const { repo } = await make();
      const created = await repo.create(scheduleInput('switch'));
      expect(created.cron).toBe('* * * * *');

      const toEvery = await repo.update(created.id, { every: '15m' });
      expect(toEvery?.cron).toBeUndefined();
      expect(toEvery?.every).toBe('15m');

      // После перечитывания из хранилища старый триггер не воскресает.
      const reloaded = await repo.get(created.id);
      expect(reloaded?.cron).toBeUndefined();
      expect(reloaded?.every).toBe('15m');

      const backToCron = await repo.update(created.id, { cron: '0 9 * * *' });
      expect(backToCron?.cron).toBe('0 9 * * *');
      expect(backToCron?.every).toBeUndefined();
      expect((await repo.get(created.id))?.every).toBeUndefined();

      // Патч без ключей триггера (только name) его не трогает.
      const renamed = await repo.update(created.id, { name: 'renamed-2' });
      expect(renamed?.cron).toBe('0 9 * * *');
      expect(renamed?.every).toBeUndefined();
    });

    it('update: повреждённая запись с обоими триггерами лечится парой', async () => {
      const { repo } = await make();
      // Старое состояние до фикса: в записи остались и cron, и every.
      const corrupt = await repo.create({ ...scheduleInput('corrupt'), cron: '* * * * *', every: '1h' });
      const fixed = await repo.update(corrupt.id, { every: '15m' });
      expect(fixed?.cron).toBeUndefined();
      expect(fixed?.every).toBe('15m');
    });

    it('update: nullable prompt/payload/catchUp очищаются явным undefined, отсутствие ключа — не трогает', async () => {
      const { repo } = await make();
      const created = await repo.create({
        ...scheduleInput('prompted'),
        payload: { source: 'test' },
        catchUp: 'skip',
      });
      expect(created.prompt).toBe('tick');
      expect(created.payload).toEqual({ source: 'test' });
      expect(created.catchUp).toBe('skip');

      const renamed = await repo.update(created.id, { name: 'renamed' });
      expect(renamed?.prompt).toBe('tick');
      expect(renamed?.payload).toEqual({ source: 'test' });
      expect(renamed?.catchUp).toBe('skip');

      const cleared = await repo.update(created.id, {
        prompt: undefined,
        payload: undefined,
        catchUp: undefined,
      });
      expect(cleared?.prompt).toBeUndefined();
      expect(cleared?.payload).toBeUndefined();
      expect(cleared?.catchUp).toBeUndefined();

      const reloaded = await repo.get(created.id);
      expect(reloaded?.prompt).toBeUndefined();
      expect(reloaded?.payload).toBeUndefined();
      expect(reloaded?.catchUp).toBeUndefined();
      // Триггер не задет.
      expect(reloaded?.cron).toBe('* * * * *');
    });

    it('update: ownerId пользовательским патчем не очищается', async () => {
      const { repo } = await make();
      const created = await repo.create({ ...scheduleInput('owned'), ownerId: 'u1' });
      expect(created.ownerId).toBe('u1');

      const patched = await repo.update(created.id, { ownerId: undefined, name: 'renamed' });
      expect(patched?.ownerId).toBe('u1');
      expect((await repo.get(created.id))?.ownerId).toBe('u1');
    });

    it('hasEnabledTargetFor учитывает enabled и mode !== ephemeral', async () => {
      const { repo } = await make();
      const bound = await repo.create({
        name: 'b',
        enabled: true,
        cron: '* * * * *',
        target: { mode: 'bound', sessionId: 'sess-1' },
      });
      expect(await repo.hasEnabledTargetFor('sess-1')).toBe(true);
      await repo.update(bound.id, { enabled: false });
      expect(await repo.hasEnabledTargetFor('sess-1')).toBe(false);

      await repo.create({ name: 'e', enabled: true, cron: '* * * * *', target: { mode: 'ephemeral' } });
      expect(await repo.hasEnabledTargetFor('sess-1')).toBe(false);
    });
  });
}

/** Паспорт порта `JobRepository`. */
export function describeJobRepository(
  name: string,
  make: () => Promise<{ repo: JobRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('append/list(limit, scheduleId); пустая история — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(job('j1', 's1'));
      await repo.append(job('j2', 's1'));
      await repo.append(job('j3', 's2'));

      expect((await repo.list()).map((j) => j.id)).toEqual(['j1', 'j2', 'j3']);
      expect((await repo.list({ scheduleId: 's1' })).map((j) => j.id)).toEqual(['j1', 'j2']);
      expect((await repo.list({ limit: 1 })).map((j) => j.id)).toEqual(['j3']);
    });
  });
}
