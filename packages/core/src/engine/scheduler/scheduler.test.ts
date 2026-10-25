import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDecision, Session, SynthEvent } from '@itphx/synth-shared';
import type { EventIngestInput, EventIngress } from '../events/ingest.js';
import { ScheduleStore } from '../../storage/schedule-store.js';
import { JobStore } from '../../storage/job-store.js';
import { MetricsRegistry } from '../../metrics/registry.js';
import { createSchedulerMetrics } from '../../metrics/collectors/scheduler.js';
import { SchedulerService } from './scheduler.js';
import { HookBus } from '../hooks/hook-bus.js';

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

  it('эмитит schedule_fired до публикации события и без текста задания (ADR-030 Ф0)', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'hooks',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
      prompt: 'секретный текст задания',
    });
    const { ingress, ingest } = makeIngress();
    const hooks = new HookBus();
    const received: Array<Record<string, unknown>> = [];
    hooks.on('schedule_fired', (ctx) => {
      received.push(ctx as unknown as Record<string, unknown>);
    }, { mode: 'async' });
    const emitSpy = vi.spyOn(hooks, 'emitAsync');
    const svc = new SchedulerService({ scheduleStore: store, ingress, hooks, now: () => current });

    await svc.start();
    svc.stop();
    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toEqual({
      scheduleId: schedule.id,
      name: 'hooks',
      target: 'bound',
      trigger: 'cron',
    });
    // Текст задания в хук не попадает — только метаданные расписания.
    expect(JSON.stringify(received[0])).not.toContain('секретный текст задания');
    // Вызов эмита стоит раньше публикации события (hook-подписчики видят срабатывание первыми).
    expect(emitSpy.mock.invocationCallOrder[0]).toBeLessThan(ingest.mock.invocationCallOrder[0]!);
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

describe('SchedulerService × ADR-101 (цель `pipeline` — прямой запуск прогона)', () => {
  let tmpDir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-scheduler-pipeline-'));
    store = new ScheduleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('цель pipeline: runPipeline вызывается с projectId/pipelineId/payload, ingest НЕ вызывается', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'pl',
      enabled: true,
      every: '1h',
      payload: { shared: 'from-schedule', sessionId: 'ses_schedule' },
      target: {
        mode: 'pipeline',
        projectId: 'proj_1',
        pipelineId: 'pl_1',
        version: 3,
        payload: { sessionId: 'ses_target' },
      },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const runPipeline = vi.fn(
      async (_input: {
        projectId: string;
        pipelineId: string;
        version?: number;
        payload: Record<string, unknown>;
        dedupKey: string;
      }) => ({ runId: 'run_1' }),
    );
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      runPipeline,
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    expect(runPipeline).toHaveBeenCalledTimes(1);
    const call = runPipeline.mock.calls[0]![0];
    expect(call.projectId).toBe('proj_1');
    expect(call.pipelineId).toBe('pl_1');
    expect(call.version).toBe(3);
    expect(call.dedupKey).toBe(`cron:${schedule.id}:2026-01-01T01:00`);
    // payload прогона: scheduleId/name + payload расписания + payload цели
    // (payload цели приоритетнее).
    expect(call.payload).toEqual({
      scheduleId: schedule.id,
      name: 'pl',
      shared: 'from-schedule',
      sessionId: 'ses_target',
    });
    // Событие в Router не публикуется — сессия не создаётся.
    expect(ingest).not.toHaveBeenCalled();
  });

  it('цель pipeline: Job ok с decision/pipelineId/runId, markRun ok, nextRunAt пересчитан', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'pl',
      enabled: true,
      every: '1h',
      target: { mode: 'pipeline', projectId: 'proj_1', pipelineId: 'pl_1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress } = makeIngress();
    const runPipeline = vi.fn(async () => ({ runId: 'run_42' }));
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      runPipeline,
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      trigger: 'cron',
      status: 'ok',
      decision: 'pipeline',
      pipelineId: 'pl_1',
      runId: 'run_42',
    });
    expect(jobs[0]!.sessionId).toBeUndefined();

    const after = await store.get(schedule.id);
    expect(after?.lastStatus).toBe('ok');
    expect(after?.lastRunAt).toBe('2026-01-01T01:00:00.000Z');
    expect(after?.nextRunAt).toBe('2026-01-01T02:00:00.000Z');
    expect(after?.lastError).toBeUndefined();
  });

  it('цель pipeline без runner\'а: Job error/reason pipeline_unavailable, ingest НЕ вызывается', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'pl',
      enabled: true,
      every: '1h',
      target: { mode: 'pipeline', projectId: 'proj_1', pipelineId: 'pl_1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    expect(ingest).not.toHaveBeenCalled();
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'error', reason: 'pipeline_unavailable' });
    expect(jobs[0]!.error).toBeTruthy();
    expect((await store.get(schedule.id))?.lastStatus).toBe('error');
  });

  it('цель pipeline: ошибка runner\'а → Job error, guard снят (следующий тик снова запускается)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'pl',
      enabled: true,
      every: '1h',
      target: { mode: 'pipeline', projectId: 'proj_1', pipelineId: 'pl_1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress();
    const runPipeline = vi.fn(async () => {
      throw new Error('pipeline boom');
    });
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      runPipeline,
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs[0]).toMatchObject({ status: 'error', error: 'pipeline boom' });
    expect((await store.get(schedule.id))?.lastStatus).toBe('error');

    // In-flight guard снят — следующий тик снова запускает прогон (не `busy`).
    current = new Date('2026-01-01T02:00:00Z');
    await svc.tick();
    expect(runPipeline).toHaveBeenCalledTimes(2);
    const jobsAfter = await jobStore.list({ scheduleId: schedule.id });
    expect(jobsAfter).toHaveLength(2);
    expect(jobsAfter.some((job) => job.reason === 'busy')).toBe(false);
  });

  it('цель bound по-прежнему идёт через ingest (путь pipeline не меняет)', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'b',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const jobStore = new JobStore({ dataDir: tmpDir });
    const { ingress, ingest } = makeIngress({ kind: 'bound', sessionId: 's1' });
    const runPipeline = vi.fn(
      async (_input: {
        projectId: string;
        pipelineId: string;
        version?: number;
        payload: Record<string, unknown>;
        dedupKey: string;
      }) => ({ runId: 'run_1' }),
    );
    const svc = new SchedulerService({
      scheduleStore: store,
      ingress,
      jobStore,
      runPipeline,
      now: () => current,
    });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T01:00:00Z');
    await svc.tick();

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(runPipeline).not.toHaveBeenCalled();
    const jobs = await jobStore.list({ scheduleId: schedule.id });
    expect(jobs[0]).toMatchObject({ status: 'ok', decision: 'bound' });
  });
});

describe('SchedulerService × ADR-094 (метрики Job)', () => {
  let tmpDir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-scheduler-metrics-'));
    store = new ScheduleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('runNow (manual) → synth_scheduler_jobs_total{outcome="ok"}, без дрейфа', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const schedule = await store.create({
      name: 'metrics-manual',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const registry = new MetricsRegistry();
    const onJob = vi.fn(createSchedulerMetrics(registry));
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, onJob, now: () => current });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T00:30:00Z');
    await svc.runNow(schedule.id);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(onJob).toHaveBeenCalledTimes(1);
    const info = onJob.mock.calls[0]![0];
    expect(info.status).toBe('ok');
    expect(info.driftSec).toBeUndefined();

    const text = registry.render().text;
    expect(text).toContain('synth_scheduler_jobs_total{outcome="ok"} 1');
    // manual не задаёт дрейф — серия не создаётся.
    expect(text).not.toMatch(/synth_scheduler_drift_seconds\s+[0-9]/);
  });

  it('cron → дрейф (факт − план) и outcome=ok; ошибка — outcome=error', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    await store.create({
      name: 'metrics-cron',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const registry = new MetricsRegistry();
    const onJob = vi.fn(createSchedulerMetrics(registry));
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, onJob, now: () => current });
    await svc.start();
    svc.stop();

    // Старт на 90 с позже планового времени (01:00).
    current = new Date('2026-01-01T01:01:30Z');
    await svc.tick(new Date('2026-01-01T01:00:00Z'));

    expect(onJob).toHaveBeenCalledTimes(1);
    expect(onJob.mock.calls[0]![0]).toMatchObject({ status: 'ok', driftSec: 90 });
    let text = registry.render().text;
    expect(text).toContain('synth_scheduler_jobs_total{outcome="ok"} 1');
    expect(text).toContain('synth_scheduler_drift_seconds 90');

    // Ошибка публикации — error.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingest.mockRejectedValueOnce(new Error('boom'));
    current = new Date('2026-01-01T02:00:00Z');
    await svc.tick();
    expect(onJob).toHaveBeenCalledTimes(2);
    expect(onJob.mock.calls[1]![0]).toMatchObject({ status: 'error' });
    text = registry.render().text;
    expect(text).toContain('synth_scheduler_jobs_total{outcome="error"} 1');
  });
});
