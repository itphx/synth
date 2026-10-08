import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDecision, SynthEvent } from '@itphx/synth-shared';
import type { EventIngestInput, EventIngress } from '../events/ingest.js';
import { ScheduleStore } from '../../storage/schedule-store.js';
import { SchedulerService } from './scheduler.js';

/** Мок ingress: записывает входы, не ходит в Router. */
function makeIngress() {
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
    decision: { kind: 'drop', reason: 'no_route', audited: true } as RouteDecision,
    session: null,
  }));
  return { ingress: { ingest } as unknown as EventIngress, ingest };
}

describe('SchedulerService (AD-051 / AD-089)', () => {
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
    const { ingress, ingest } = makeIngress();
    const svc = new SchedulerService({ scheduleStore: store, ingress, now: () => current });
    await svc.start();
    svc.stop();

    current = new Date('2026-01-01T00:30:00Z');
    const updated = await svc.runNow(schedule.id);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0].dedupKey).toBe(`cron:${schedule.id}:2026-01-01T00:30:00.000Z`);
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
});
