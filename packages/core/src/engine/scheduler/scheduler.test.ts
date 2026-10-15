import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDecision, Session, SynthEvent } from '@itphx/synth-shared';
import type { EventIngestInput, EventIngress } from '../events/ingest.js';
import { ScheduleStore } from '../../storage/schedule-store.js';
import { JobStore } from '../../storage/job-store.js';
import { SchedulerService } from './scheduler.js';

/** Мок ingress: записывает входы, не ходит в Router. */
function makeIngress(
  decision: RouteDecision = { kind: 'bound', sessionId: 's1' },
  session: Session | null = null,
) {
  const ingest = vi.fn(async (input: EventIngestInput) => ({
    event: {
      id: 'evt_test',
      source: input.source,
      type: input.type,
      payload: input.payload,
      identity: input.identity ?? {},
      dedupKey: input.dedupKey ?? '',
      ts: input.ts ?? new Date().toISOString(),
    } as SynthEvent,
    decision,
    session,
  }));
  return { ingress: { ingest } as unknown as EventIngress, ingest };
}

describe('SchedulerService (ADR-051 / ADR-089)', () => {
  let tmpDir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-scheduler-'));
    store = new ScheduleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('every: старт планирует nextRunAt, тик публикует событие и пересчитывает', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'e',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
      prompt: 'ping',
    });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });

    await svc.start();
    svc.stop();
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T01:00:00.000Z');

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    expect(ingest).toHaveBeenCalledTimes(1);
    const call = ingest.mock.calls[0]![0];
    expect(call.source).toBe('cron');
    expect(call.type).toBe('schedule_fired');
    expect(call.payload).toMatchObject({ scheduleId: schedule.id, name: 'e', text: 'ping' });
    expect(call.dedupKey).toBe(`cron:${schedule.id}:2026-01-01T01:00`);

    const after = await store.get(schedule.id);
    expect(after?.lastStatus).toBe('ok');
    expect(after?.lastRunAt).toBe('2026-01-01T01:00:00.000Z');
    expect(after?.nextRunAt).toBe('2026-01-01T02:00:00.000Z');
  });

  it('cron: срабатывание по выражению */5', async () => {
    let current = new Date('2026-01-01T10:00:00Z');
    const schedule = await store.create({
      name: 'c',
      enabled: true,
      cron: '*/5 * * * *',
      target: { mode: 'ephemeral', agentTemplate: 'triage', ttl: '30m' },
    });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });
    await svc.start();
    svc.stop();
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T10:05:00.000Z');

    current = new Date('2026-01-01T10:05:00Z');
    await svc.tick();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T10:10:00.000Z');
  });

  it('выключенное расписание не публикует событие и не имеет nextRunAt', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'off',
      enabled: false,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });

    await svc.start();
    svc.stop();
    expect((await store.get(schedule.id))?.nextRunAt).toBeUndefined();

    current = new Date('2026-01-02T00:00:00Z');
    await svc.tick();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('ошибка публикации фиксируется как error и не роняет тик', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'boom',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const { ingress, ingest } = makeIngress();
    ingest.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await expect(svc.tick()).resolves.toBeUndefined();

    const after = await store.get(schedule.id);
    expect(after?.lastStatus).toBe('error');
    expect(after?.lastError).toBe('boom');
    expect(after?.nextRunAt).toBe('2026-01-01T02:00:00.000Z');
  });

  it('runNow публикует событие вне расписания с уникальным dedup-ключом', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'now',
      enabled: true,
      every: '1h',
      target: { mode: 'queue', sessionId: 'owner-1' },
    });
    const { ingress, ingest } = makeIngress({ kind: 'queue', owner: 'owner-1', reason: 'schedule' });
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T00:30:00Z');
    const updated = await svc.runNow(schedule.id);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0].dedupKey).toBe(`cron:${schedule.id}:manual:2026-01-01T00:30:00.000Z`);
    expect(updated?.lastRunAt).toBe('2026-01-01T00:30:00.000Z');
    expect(updated?.nextRunAt).toBe('2026-01-01T01:30:00.000Z');
    expect(updated?.lastStatus).toBe('ok');
  });

  it('runNow неизвестного id → null', async () => {
    const { ingress } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => new Date() });
    expect(await svc.runNow('sch_missing')).toBeNull();
  });

  it('нет catch-up: пропущенные срабатывания не догоняются', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'no-catchup',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });
    await svc.start();
    svc.stop();

    // Простой 3 часа: наступило три «срабатывания», но догоняем только одно.
    current = new Date('2026-01-01T03:00:00Z');
    await svc.tick();
    await svc.tick();

    expect(ingest).toHaveBeenCalledTimes(1);
    const after = await store.get(schedule.id);
    expect(after?.nextRunAt).toBe('2026-01-01T04:00:00.000Z');
  });

  it('tick лениво планирует расписание без nextRunAt (create после старта)', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });

    const schedule = await store.create({
      name: 'lazy',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });

    await svc.tick();
    expect(ingest).not.toHaveBeenCalled();
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T01:00:00.000Z');

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('невалидная конфигурация помечается error, сервис не падает', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schedule = await store.create({
      name: 'bad-cron',
      enabled: true,
      cron: 'bad',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const { ingress } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => new Date('2026-01-01T00:00:00Z') });
    await svc.start();
    svc.stop();

    const after = await store.get(schedule.id);
    expect(after?.lastStatus).toBe('error');
  });

  it('Job пишется при обычном срабатывании: trigger cron, decision/sessionId', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'job',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress } = makeIngress({ kind: 'bound', sessionId: 's1' }, { id: 'sess_1' } as unknown as Session);
    const svc = new SchedulerService({ scheduleStore: store, ingress, jobStore, now: () => current });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      trigger: 'cron',
      status: 'ok',
      decision: 'bound',
      sessionId: 'sess_1',
    });
    expect(jobs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(jobs[0]!.startedAt <= jobs[0]!.finishedAt).toBe(true);
  });

  it('drop-решение Router → Job skipped с reason и lastStatus skipped', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'd',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress } = makeIngress({ kind: 'drop', reason: 'no_route', audited: true });
    const svc = new SchedulerService({ scheduleStore: store, ingress, jobStore, now: () => current });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs[0]).toMatchObject({ status: 'skipped', decision: 'drop', reason: 'no_route' });
    expect((await store.get(schedule.id))?.lastStatus).toBe('skipped');
  });

  it('catch-up skip: Job skipped missed и nextRunAt сдвинут от текущего момента', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'cu',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, jobStore, now: () => current });
    await svc.start();
    svc.stop(); // nextRunAt = 01:00

    current = new Date('2026-01-01T03:00:00Z');
    await svc.start();
    svc.stop();

    expect(ingest).not.toHaveBeenCalled();
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ trigger: 'catchup', status: 'skipped', reason: 'missed' });
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T04:00:00.000Z');
  });

  it('catch-up once (дефолт deps): одно догоняющее срабатывание trigger catchup', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'cu-once',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      catchUp: 'once',
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T03:00:00Z');
    await svc.start();
    svc.stop();

    expect(ingest).toHaveBeenCalledTimes(1);
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ trigger: 'catchup', status: 'ok' });
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T04:00:00.000Z');
  });

  it('catchUp расписания переопределяет дефолт deps', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'cu-skip',
      enabled: true,
      every: '1h',
      catchUp: 'skip',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      catchUp: 'once',
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T03:00:00Z');
    await svc.start();
    svc.stop();

    expect(ingest).not.toHaveBeenCalled();
    expect((await jobStore.list({ scheduleId: schedule.id }))[0]).toMatchObject({
      status: 'skipped',
      reason: 'missed',
    });
  });

  it('in-flight guard: повторный запуск → Job skipped busy', async () => {
    const current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'busy',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const ingest = vi.fn(async (input: EventIngestInput) => {
      calls += 1;
      if (calls === 1) await gate;
      return {
        event: {
          id: 'evt',
          source: input.source,
          type: input.type,
          payload: input.payload,
          identity: input.identity ?? {},
          dedupKey: input.dedupKey ?? '',
          ts: current.toISOString(),
        } as SynthEvent,
        decision: { kind: 'drop', reason: 'no_route', audited: true } as RouteDecision,
        session: null,
      };
    });
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress: { ingest } as unknown as EventIngress,
      jobStore,
      now: () => current,
    });

    const first = svc.runNow(schedule.id);
    // Ждём наблюдаемого факта: первый прогон уже ушёл в ingress (in-flight guard).
    await vi.waitFor(() => {
      expect(ingest).toHaveBeenCalled();
    });
    const second = await svc.runNow(schedule.id); // in-flight → busy
    release();
    await first;

    expect(second?.id).toBe(schedule.id);
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs.some((j) => j.status === 'skipped' && j.reason === 'busy')).toBe(true);
  });

  it('runNow: trigger manual и force в payload (в т.ч. выключенное расписание)', async () => {
    const current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'off',
      enabled: false,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, jobStore, now: () => current });

    const updated = await svc.runNow(schedule.id);
    expect(updated).not.toBeNull();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0].payload).toMatchObject({ force: true, scheduleId: schedule.id });
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs[0]).toMatchObject({ trigger: 'manual' });
  });

  it('start вызывает prune Job-истории по retention', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const jobStore = new JobStore({ dataDir: tmpDir });
    await jobStore.append({
      id: 'job_old',
      scheduleId: 'sch_x',
      scheduleName: 'x',
      trigger: 'cron',
      status: 'ok',
      startedAt: old,
      finishedAt: old,
      durationMs: 0,
      target: { mode: 'bound', sessionId: 's1' },
    });

    const { ingress } = makeIngress();
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      jobRetentionDays: 30,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await svc.start();
    svc.stop();

    expect(await jobStore.list()).toEqual([]);
  });

  it('leader: не лидер — тикер не стартует, nextRunAt не планируется', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schedule = await store.create({
      name: 'e',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const { ingress, ingest } = makeIngress();
    const leader = { acquire: vi.fn(async () => false), touch: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    const svc = new SchedulerService({ scheduleStore: store, ingress, leader });

    await svc.start();
    expect(leader.acquire).toHaveBeenCalledOnce();
    // Не лидер: catch-up/планирование не выполнялись.
    expect((await store.get(schedule.id))?.nextRunAt).toBeUndefined();

    await svc.tick();
    expect(ingest).not.toHaveBeenCalled();
    // touch всё равно вызывается на тике (best-effort heartbeat).
    expect(leader.touch).toHaveBeenCalled();

    svc.stop();
    // release не вызывается: лидером не были.
    expect(leader.release).not.toHaveBeenCalled();
  });

  it('leader: лидер — start/tick вызывают touch, stop — release', async () => {
    const schedule = await store.create({
      name: 'e',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const { ingress } = makeIngress();
    const leader = { acquire: vi.fn(async () => true), touch: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      leader,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    await svc.start();
    expect((await store.get(schedule.id))?.nextRunAt).toBe('2026-01-01T01:00:00.000Z');

    await svc.tick(new Date('2026-01-01T01:00:00Z'));
    expect(leader.touch).toHaveBeenCalled();

    svc.stop();
    expect(leader.release).toHaveBeenCalledOnce();
  });
});
