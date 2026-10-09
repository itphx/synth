import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduleJob } from '@itphx/synth-shared';
import { JobStore } from './job-store.js';

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: `job_${Math.random().toString(36).slice(2)}`,
    scheduleId: 'sch_1',
    scheduleName: 'nightly',
    trigger: 'cron',
    status: 'ok',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.100Z',
    durationMs: 100,
    target: { mode: 'bound', sessionId: 's1' },
    ...overrides,
  };
}

describe('JobStore (AD-051)', () => {
  let tmpDir: string;
  let store: JobStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-job-store-'));
    store = new JobStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('append/list: порядок добавления, строки JSONL', async () => {
    await store.append(job({ id: 'job_1' }));
    await store.append(job({ id: 'job_2' }));

    const jobs = await store.list();
    expect(jobs.map((j) => j.id)).toEqual(['job_1', 'job_2']);

    const raw = await readFile(join(tmpDir, 'scheduler', 'jobs.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('пустой файл → []', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('фильтр по scheduleId и limit (последние N)', async () => {
    await store.append(job({ id: 'a1', scheduleId: 'sch_a' }));
    await store.append(job({ id: 'b1', scheduleId: 'sch_b' }));
    await store.append(job({ id: 'a2', scheduleId: 'sch_a' }));
    await store.append(job({ id: 'a3', scheduleId: 'sch_a' }));

    const onlyA = await store.list({ scheduleId: 'sch_a' });
    expect(onlyA.map((j) => j.id)).toEqual(['a1', 'a2', 'a3']);

    const lastTwo = await store.list({ scheduleId: 'sch_a', limit: 2 });
    expect(lastTwo.map((j) => j.id)).toEqual(['a2', 'a3']);

    const globalLast = await store.list({ limit: 1 });
    expect(globalLast.map((j) => j.id)).toEqual(['a3']);
  });

  it('prune удаляет записи старше retention по startedAt', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    await store.append(job({ id: 'old', startedAt: old, finishedAt: old }));
    await store.append(job({ id: 'fresh', startedAt: fresh, finishedAt: fresh }));

    const removed = await store.prune(30);
    expect(removed).toBe(1);
    expect((await store.list()).map((j) => j.id)).toEqual(['fresh']);
  });

  it('prune без удалений файл не трогает и возвращает 0', async () => {
    const fresh = new Date().toISOString();
    await store.append(job({ id: 'fresh', startedAt: fresh, finishedAt: fresh }));
    expect(await store.prune(30)).toBe(0);
    expect((await store.list()).map((j) => j.id)).toEqual(['fresh']);
  });

  it('повреждённые строки пропускаются, валидные читаются', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = join(tmpDir, 'scheduler');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'jobs.jsonl'),
      `${JSON.stringify(job({ id: 'good' }))}\n{not json}\n\n`,
      'utf8',
    );

    const jobs = await store.list();
    expect(jobs.map((j) => j.id)).toEqual(['good']);
  });
});
