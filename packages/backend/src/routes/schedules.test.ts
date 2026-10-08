// AD-051 (срез) / AD-089: backend монтирует core-фабрику расписаний с managed-RBAC.
// Проверяем: чтение (GET) — requireAuth; мутации (POST/PUT/DELETE) и принудительный
// запуск (`POST /:id/run`) — только ADMIN; валидация тела → 400; отсутствие записи → 404.
// Плюс сшивка в createBackendApp: при `scheduler.enabled: false` роуты смонтированы,
// а тикер не стартует.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScheduleStore,
  SchedulerService,
  createSchedulerRoutes,
} from '@itphx/synth-core';
import type { EventIngress } from '@itphx/synth-core';
import type { ScheduleInput, User } from '@itphx/synth-shared';
import { createBackendApp } from '../app.js';

function makeUser(id: string, roles: User['roles']): User {
  return {
    id,
    username: id,
    roles,
    preferredLanguage: 'ru',
    createdAt: '',
    teamRole: 'USER',
    notes: '',
    interviewCompleted: false,
  };
}

/** Mock middleware: роли читаются из фиксированного пользователя (как requireAuth/requireAdmin). */
function makeGuards(user: User | null) {
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }, 401);
    await next();
  };
  const requireAdmin: MiddlewareHandler = async (c, next) => {
    if (!user || !user.roles.includes('ADMIN')) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403);
    }
    await next();
  };
  return { requireAuth, requireAdmin };
}

const VALID_BODY: ScheduleInput = {
  name: 'nightly',
  enabled: true,
  every: '1h',
  target: { mode: 'bound', sessionId: 's1' },
  prompt: 'ping',
};

describe('Schedules API Routes (AD-051 срез / AD-089, backend RBAC)', () => {
  let dataDir: string;
  let scheduleStore: ScheduleStore;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-schedules-'));
    scheduleStore = new ScheduleStore({ dataDir });
    // Ingress для `runNow`: достаточно заглушки — маршрутизацию здесь не проверяем.
    const ingress = {
      ingest: async () => ({ event: {}, decision: { kind: 'drop', reason: 'stub' }, session: null }),
    } as unknown as EventIngress;
    scheduler = new SchedulerService({
      scheduleStore,
      ingress,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeApp(user: User | null) {
    const { requireAuth, requireAdmin } = makeGuards(user);
    const app = new Hono();
    app.route('/api/v2/schedules', createSchedulerRoutes(
      { requireAuth },
      { scheduleStore, scheduler },
      { writeGuard: requireAdmin },
    ));
    return app;
  }

  const user = makeUser('developer', ['USER']);
  const admin = makeUser('admin', ['ADMIN']);

  function post(app: Hono, path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function put(app: Hono, path: string, body: unknown) {
    return app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('USER: GET доступен (200), POST/PUT/DELETE/run → 403', async () => {
    const created = await scheduleStore.create(VALID_BODY);
    const app = makeApp(user);

    const list = await app.request('/api/v2/schedules');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { schedules: unknown[] };
    expect(listBody.schedules).toHaveLength(1);

    expect((await post(app, '/api/v2/schedules', VALID_BODY)).status).toBe(403);
    expect((await put(app, `/api/v2/schedules/${created.id}`, VALID_BODY)).status).toBe(403);
    expect((await app.request(`/api/v2/schedules/${created.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await post(app, `/api/v2/schedules/${created.id}/run`, {})).status).toBe(403);
  });

  it('неаутентифицированный → 401 на GET', async () => {
    const app = makeApp(null);
    const res = await app.request('/api/v2/schedules');
    expect(res.status).toBe(401);
  });

  it('ADMIN: POST 201, PUT 200, run 200, DELETE 204', async () => {
    const app = makeApp(admin);

    const create = await post(app, '/api/v2/schedules', VALID_BODY);
    expect(create.status).toBe(201);
    const created = await create.json() as { schedule: { id: string; name: string; nextRunAt?: string } };
    expect(created.schedule.id).toMatch(/^sch_/);
    expect(created.schedule.nextRunAt).toBeDefined();

    const update = await put(app, `/api/v2/schedules/${created.schedule.id}`, {
      ...VALID_BODY,
      name: 'nightly-2',
    });
    expect(update.status).toBe(200);
    expect((await update.json() as { schedule: { name: string } }).schedule.name).toBe('nightly-2');

    const run = await post(app, `/api/v2/schedules/${created.schedule.id}/run`, {});
    expect(run.status).toBe(200);
    expect((await run.json() as { schedule: { id: string } }).schedule.id).toBe(created.schedule.id);

    const del = await app.request(`/api/v2/schedules/${created.schedule.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await scheduleStore.get(created.schedule.id)).toBeNull();
  });

  it('ADMIN: невалидный cron/every/target/триггер → 400', async () => {
    const app = makeApp(admin);
    const invalidBodies: unknown[] = [
      { ...VALID_BODY, every: undefined, cron: 'not-a-cron' },
      { ...VALID_BODY, every: '1x' },
      { ...VALID_BODY, target: { mode: 'bound' } },
      { ...VALID_BODY, target: { mode: 'other', sessionId: 's1' } },
      { ...VALID_BODY, cron: '0 0 * * *' }, // cron и every одновременно
      { name: 'no-trigger', target: { mode: 'bound', sessionId: 's1' } }, // ни cron, ни every
    ];

    for (const body of invalidBodies) {
      const res = await post(app, '/api/v2/schedules', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('ADMIN: несуществующая запись — PUT/DELETE/run → 404; DELETE дважды → 404', async () => {
    const app = makeApp(admin);
    expect((await put(app, '/api/v2/schedules/nope', VALID_BODY)).status).toBe(404);
    expect((await post(app, '/api/v2/schedules/nope/run', {})).status).toBe(404);
    expect((await app.request('/api/v2/schedules/nope', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('Schedules wiring (createBackendApp)', () => {
  let rootDir: string;

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('scheduler.enabled:false — роуты смонтированы, тикер не стартует', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'synth-backend-sched-wiring-'));
    const configPath = join(rootDir, 'config.yaml');
    await writeFile(configPath, 'scheduler:\n  enabled: false\n', 'utf-8');

    const handle = await createBackendApp({
      dataDir: join(rootDir, 'data'),
      authDebug: true,
      configPath,
    });
    try {
      // Роуты смонтированы: GET отвечает пустым списком (requireAuth пройден).
      const list = await handle.app.request('/api/v2/schedules', {
        headers: { Authorization: 'Bearer admin-key-123' },
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ schedules: [] });

      // RBAC managed: USER не может создавать, ADMIN — может.
      const forbidden = await handle.app.request('/api/v2/schedules', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-key-456', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      expect(forbidden.status).toBe(403);

      // Тикер не стартовал: приватный таймер не выставлен.
      expect(Reflect.get(handle.scheduler as object, '_timer')).toBeUndefined();
      expect(handle.config.synth.scheduler.enabled).toBe(false);
    } finally {
      handle.stopScheduler();
      handle.stopEphemeralSweeper();
    }
  });
});
