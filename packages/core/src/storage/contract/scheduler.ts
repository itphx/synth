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
