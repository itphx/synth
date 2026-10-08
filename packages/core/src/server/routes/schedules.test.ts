import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { RouteDecision, SynthEvent } from '@itphx/synth-shared';
import { createSchedulerRoutes } from './schedules.js';
import type { SchedulerRoutesAuth } from './schedules.js';
import { ScheduleStore } from '../../storage/schedule-store.js';
import { SchedulerService } from '../../engine/scheduler/scheduler.js';
import type { EventIngestInput, EventIngress } from '../../engine/events/ingest.js';

const auth = {
  requireAuth: async (_c: Context, next: Next) => {
    await next();
  },
} as unknown as SchedulerRoutesAuth;

function makeIngress() {
  const ingest = vi.fn(async (input: EventIngestInput) => ({
    event: { source: input.source, type: input.type, dedupKey: input.dedupKey } as SynthEvent,
    decision: { kind: 'drop', reason: 'no_route', audited: true } as RouteDecision,
    session: null,
  }));
  return { ingress: { ingest } as unknown as EventIngress, ingest };
}

describe('Schedules API Routes (AD-051 / AD-089)', () => {
  let tmpDir: string;
  let store: ScheduleStore;
  let scheduler: SchedulerService;
  let ingest: ReturnType<typeof makeIngress>['ingest'];

  const makeApp = (writeGuard = auth.requireAuth) => {
    const app = new Hono();
    app.route(
      '/api/v2/schedules',
      createSchedulerRoutes(auth, { scheduleStore: store, scheduler }, { writeGuard }),
    );
    return app;
  };

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sched-routes-'));
    store = new ScheduleStore({ dataDir: tmpDir });
    const mock = makeIngress();
    ingest = mock.ingest;
    scheduler = new SchedulerService({
      scheduleStore: store,
      ingress: mock.ingress,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
  });

  afterEach(async () => {
    scheduler.stop();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET / — пустой список и после создания', async () => {
    const app = makeApp();
    const empty = await app.request('/api/v2/schedules');
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { schedules: unknown[] }).schedules).toEqual([]);

    await store.create({ name: 'x', enabled: true, every: '1h', target: { mode: 'bound', sessionId: 's1' } });
    const list = await app.request('/api/v2/schedules');
    expect(((await list.json()) as { schedules: unknown[] }).schedules).toHaveLength(1);
  });

  it('POST / — 201 и вычисленный nextRunAt (every)', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'job', every: '1h', target: { mode: 'bound', sessionId: 's1' } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { schedule: { id: string; enabled: boolean; nextRunAt?: string } };
    expect(body.schedule.id.startsWith('sch_')).toBe(true);
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.nextRunAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('POST / — 201 с cron', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'c', cron: '*/5 * * * *', target: { mode: 'queue', sessionId: 'o1' } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { schedule: { nextRunAt?: string } };
    expect(body.schedule.nextRunAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('POST / — не задан ни cron, ни every → 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'x', target: { mode: 'bound', sessionId: 's1' } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST / — заданы оба cron и every → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', {
        name: 'x',
        cron: '* * * * *',
        every: '1h',
        target: { mode: 'bound', sessionId: 's1' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('POST / — некорректное cron-выражение → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'x', cron: 'not-a-cron', target: { mode: 'bound', sessionId: 's1' } }),
    );
    expect(res.status).toBe(400);
  });

  it('POST / — некорректный интервал → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'x', every: '1w', target: { mode: 'bound', sessionId: 's1' } }),
    );
    expect(res.status).toBe(400);
  });

  it('POST / — невалидный target → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'x', every: '1h', target: { mode: 'bound' } }),
    );
    expect(res.status).toBe(400);
  });

  it('POST / — не-JSON тело → 400', async () => {
    const app = makeApp();
    const res = await app.request('/api/v2/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('PUT /:id — обновление и 404 для неизвестного', async () => {
    const app = makeApp();
    const created = await store.create({
      name: 'old',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });

    const res = await app.request(
      `/api/v2/schedules/${created.id}`,
      json('PUT', { name: 'new', enabled: false, every: '30m', target: { mode: 'bound', sessionId: 's2' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedule: { name: string; enabled: boolean } };
    expect(body.schedule.name).toBe('new');
    expect(body.schedule.enabled).toBe(false);

    const missing = await app.request(
      '/api/v2/schedules/sch_missing',
      json('PUT', { name: 'x', every: '1h', target: { mode: 'bound', sessionId: 's1' } }),
    );
    expect(missing.status).toBe(404);
  });

  it('DELETE /:id — 204 затем 404', async () => {
    const app = makeApp();
    const created = await store.create({
      name: 'del',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });

    expect((await app.request(`/api/v2/schedules/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/v2/schedules/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('POST /:id/run — принудительный запуск; 404 для неизвестного', async () => {
    const app = makeApp();
    const created = await store.create({
      name: 'run',
      enabled: true,
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });

    const res = await app.request(`/api/v2/schedules/${created.id}/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedule: { lastStatus?: string } };
    expect(body.schedule.lastStatus).toBe('ok');
    expect(ingest).toHaveBeenCalledTimes(1);

    const missing = await app.request('/api/v2/schedules/sch_missing/run', { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  it('writeGuard применяется к мутациям', async () => {
    const deny = async (c: Context) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const app = makeApp(deny as never);
    const res = await app.request(
      '/api/v2/schedules',
      json('POST', { name: 'x', every: '1h', target: { mode: 'bound', sessionId: 's1' } }),
    );
    expect(res.status).toBe(403);
  });
});
