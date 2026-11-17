// ADR-051 (срез) / ADR-089 / PROP-141 (этап 5, B-1): backend монтирует
// core-фабрику расписаний; права — **по проекту расписания** (ADR-089 §5.5/§5.8,
// инвариант 21), а не «ADMIN на всё».
//
// Проверяем:
// 1. core-фабрика: guard'ы (`writeGuard`/`runGuard`), валидация тела → 400,
//    отсутствие записи → 404, rate limit на `POST /:id/run`.
// 2. managed-матрица прав (production-модуль `routes/schedules.ts`):
//    ADMIN/LEAD — всё; владелец/EDITOR — мутируют; VIEWER — только читает;
//    чужой — не видит расписание в списке и получает 403.
// 3. Сшивка в createBackendApp: роуты смонтированы, тикер не стартует при
//    `scheduler.enabled: false`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectStore,
  ScheduleStore,
  SchedulerService,
  createSchedulerRoutes,
} from '@itphx/synth-core';
import type { EventIngress, ProjectRepository } from '@itphx/synth-core';
import { ProjectRole } from '@itphx/synth-shared';
import type { ScheduleInput, User } from '@itphx/synth-shared';
import { createBackendApp } from '../app.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { createBackendScheduleAccess } from './schedules.js';
import type { AuthKit } from '../auth/middleware.js';

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
  // PROP-141: проект расписания обязателен (инстансных автоматизаций нет).
  projectId: 'proj_1',
  every: '1h',
  target: { mode: 'bound', sessionId: 's1' },
  prompt: 'ping',
};

/**
 * PROP-141: резолвер «сессия → проект» (composition root) — все сессии теста
 * принадлежат проекту `proj_1`.
 */
const resolveSessionProject = async (): Promise<string | undefined> => 'proj_1';

describe('Schedules API Routes (ADR-051 срез / ADR-089, core-фабрика)', () => {
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
      { writeGuard: requireAdmin, resolveSessionProject },
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

  it('guard на мутации (writeGuard): USER — GET 200, POST/PUT/DELETE/run → 403', async () => {
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

  it('ADMIN: run под rate limit (`runMiddleware`) → 429 после лимита', async () => {
    const { requireAuth, requireAdmin } = makeGuards(admin);
    const rateLimited = new Hono();
    rateLimited.route('/api/v2/schedules', createSchedulerRoutes(
      { requireAuth },
      { scheduleStore, scheduler },
      {
        writeGuard: requireAdmin,
        runGuard: requireAdmin,
        runMiddleware: [createRateLimiter(2, 60_000)],
        resolveSessionProject,
      },
    ));
    const created = await scheduleStore.create(VALID_BODY);

    expect((await post(rateLimited, `/api/v2/schedules/${created.id}/run`, {})).status).toBe(200);
    expect((await post(rateLimited, `/api/v2/schedules/${created.id}/run`, {})).status).toBe(200);
    const limited = await post(rateLimited, `/api/v2/schedules/${created.id}/run`, {});
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// Managed: права — по проекту расписания (PROP-141, этап 5 B-1)
// ---------------------------------------------------------------------------

type MockUser = User & { roles: string[] };

const USERS: Record<string, MockUser> = {
  admin: makeUser('admin', ['ADMIN']) as MockUser,
  lead: makeUser('lead', ['LEAD']) as MockUser,
  owner: makeUser('owner', ['USER']) as MockUser,
  editor: makeUser('editor', ['USER']) as MockUser,
  viewer: makeUser('viewer', ['USER']) as MockUser,
  stranger: makeUser('stranger', ['USER']) as MockUser,
};

/**
 * Кредентал service-key (ADR-052): синтетический пользователь `service:<keyId>`,
 * скоупы и проекция `allowedProjects`.
 */
interface MockServiceCredential {
  keyId: string;
  label: string;
  roles: string[];
  scopes: string[];
  allowedProjects?: string[];
}

/** Префикс секрета service-key (как в core `isServiceKeySecret`). */
const SERVICE_KEY_PREFIX = 'synth_svc_';

/** Резолверы запроса: пользователь (интерактив или service-key) и кредентал. */
interface MockIdentity {
  resolveUser: (header: string | undefined) => MockUser | null;
  resolveCredential: (header: string | undefined) => MockServiceCredential | undefined;
}

/** Токен из заголовка `Authorization: Bearer …`. */
function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (.+)$/.exec(header ?? '')?.[1];
}

function userFromHeader(header: string | undefined): MockUser | null {
  const token = bearerToken(header);
  return token ? USERS[token] ?? null : null;
}

/**
 * Мок-AuthKit: пользователь из `Authorization` (интерактив или service-key),
 * роли из фикстуры; service-key кладёт в контекст и кредентал (ADR-052) —
 * его читают scope-гейт и проектная проекция.
 */
function createMockKit(identity: MockIdentity = {
  resolveUser: userFromHeader,
  resolveCredential: () => undefined,
}) {
  const requireAuth = async (c: Context, next: Next) => {
    const user = identity.resolveUser(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user' as never, user as never);
    const credential = identity.resolveCredential(c.req.header('Authorization'));
    if (credential) c.set('serviceKey' as never, credential as never);
    await next();
  };
  return {
    requireAuth,
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = c.get('user') as MockUser | undefined;
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    getCurrentUser: async (c: Context) => identity.resolveUser(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as User | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as User | undefined)?.roles ?? []).includes(r)),
  };
}

describe('Managed: права на расписания — по проекту (PROP-141, этап 5)', () => {
  let tmpDir: string;
  let scheduleStore: ScheduleStore;
  let scheduler: SchedulerService;
  let projectStore: ProjectStore;
  let projectId: string;
  let otherProjectId: string;
  let serviceKeys: Map<string, MockServiceCredential>;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-sched-access-'));
    scheduleStore = new ScheduleStore({ dataDir: tmpDir });
    const ingress = {
      ingest: async () => ({ event: {}, decision: { kind: 'drop', reason: 'stub' }, session: null }),
    } as unknown as EventIngress;
    scheduler = new SchedulerService({
      scheduleStore,
      ingress,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    // Проект: владелец `owner`, участники `editor` (EDITOR) и `viewer` (VIEWER).
    projectStore = new ProjectStore({ dataDir: tmpDir });
    const project = projectStore.create('Shared', 'owner');
    project.members['editor'] = ProjectRole.EDITOR;
    project.members['viewer'] = ProjectRole.VIEWER;
    await projectStore.save(project);
    projectId = project.id;

    // Второй проект — «чужой» для ключей с проекцией `allowedProjects`.
    const other = projectStore.create('Other', 'stranger');
    await projectStore.save(other);
    otherProjectId = other.id;

    // service-key (ADR-052): скоупы и проекция.
    serviceKeys = new Map<string, MockServiceCredential>([
      ['reader', {
        keyId: 'svk_reader',
        label: 'reader',
        roles: [],
        scopes: ['schedules:read'],
        allowedProjects: [projectId],
      }],
      ['reader-all', {
        keyId: 'svk_reader_all',
        label: 'reader-all',
        roles: [],
        scopes: ['schedules:read'],
      }],
      ['writer', {
        keyId: 'svk_writer',
        label: 'writer',
        roles: [],
        scopes: ['schedules:write'],
        allowedProjects: [projectId],
      }],
      ['noscope', {
        keyId: 'svk_noscope',
        label: 'noscope',
        roles: [],
        scopes: [],
      }],
    ]);

    const identity: MockIdentity = {
      resolveUser: (header) => {
        const token = bearerToken(header);
        if (!token) return null;
        if (token.startsWith(SERVICE_KEY_PREFIX)) {
          const credential = serviceKeys.get(token.slice(SERVICE_KEY_PREFIX.length));
          if (!credential) return null;
          return {
            ...makeUser(`service:${credential.keyId}`, credential.roles),
            roles: credential.roles,
          } as MockUser;
        }
        return USERS[token] ?? null;
      },
      resolveCredential: (header) => {
        const token = bearerToken(header);
        if (!token || !token.startsWith(SERVICE_KEY_PREFIX)) return undefined;
        return serviceKeys.get(token.slice(SERVICE_KEY_PREFIX.length));
      },
    };

    const kit = createMockKit(identity);
    // Тот же production-модуль, что монтирует `app/mount-routes.ts`.
    const access = createBackendScheduleAccess({
      auth: kit as unknown as AuthKit,
      projectStore: projectStore as unknown as ProjectRepository,
    });

    app = new Hono();
    // `attachUser` в managed кладёт пользователя в контекст — так же и здесь.
    app.use('*', async (c, next) => {
      const user = identity.resolveUser(c.req.header('Authorization'));
      if (user) c.set('user' as never, user as never);
      const credential = identity.resolveCredential(c.req.header('Authorization'));
      if (credential) c.set('serviceKey' as never, credential as never);
      await next();
    });
    app.route('/api/v2/schedules', createSchedulerRoutes(
      { requireAuth: kit.requireAuth as unknown as never },
      { scheduleStore, scheduler },
      {
        writeGuard: kit.requireAuth as unknown as never,
        runGuard: kit.requireAuth as unknown as never,
        // Сессия `s1` — в первом проекте, `s2` — во втором (чужом для ключа).
        resolveSessionProject: async (id) =>
          id === 's1' ? projectId : id === 's2' ? otherProjectId : undefined,
        authorizeProject: access.authorizeProject,
        listVisibleProjectIds: access.listVisibleProjectIds,
      },
    ));
  });

  afterEach(async () => {
    scheduler.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const req = (
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      }),
    );

  const post = (path: string, token: string, body: unknown = {}) =>
    req(path, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const put = (path: string, token: string, body: unknown) =>
    req(path, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const body = (): ScheduleInput => ({
    name: 'nightly',
    enabled: true,
    every: '1h',
    target: { mode: 'bound', sessionId: 's1' },
    prompt: 'ping',
  });

  const listNames = async (token: string): Promise<string[]> => {
    const res = await req('/api/v2/schedules', token);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { schedules: { name: string }[] };
    return payload.schedules.map((schedule) => schedule.name);
  };

  it('владелец проекта: создаёт, правит и удаляет расписание', async () => {
    const create = await post('/api/v2/schedules', 'owner', body());
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { schedule: { id: string } }).schedule.id;

    const update = await put(`/api/v2/schedules/${id}`, 'owner', { ...body(), name: 'nightly-2' });
    expect(update.status).toBe(200);

    const del = await req(`/api/v2/schedules/${id}`, 'owner', { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('EDITOR проекта: создаёт, правит и удаляет расписание', async () => {
    const create = await post('/api/v2/schedules', 'editor', body());
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { schedule: { id: string } }).schedule.id;

    const update = await put(`/api/v2/schedules/${id}`, 'editor', { ...body(), name: 'edited' });
    expect(update.status).toBe(200);
    expect((await update.json() as { schedule: { name: string } }).schedule.name).toBe('edited');

    const del = await req(`/api/v2/schedules/${id}`, 'editor', { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('VIEWER проекта: читает, но не мутирует (403)', async () => {
    const created = await scheduleStore.create({ ...body(), projectId });
    expect(await listNames('viewer')).toEqual(['nightly']);

    expect((await post('/api/v2/schedules', 'viewer', body())).status).toBe(403);
    expect((await put(`/api/v2/schedules/${created.id}`, 'viewer', body())).status).toBe(403);
    expect((await req(`/api/v2/schedules/${created.id}`, 'viewer', { method: 'DELETE' })).status).toBe(403);
    expect((await post(`/api/v2/schedules/${created.id}/run`, 'viewer')).status).toBe(403);

    // Запись не изменилась.
    expect((await scheduleStore.get(created.id))?.name).toBe('nightly');
  });

  it('ADMIN/LEAD: видят все расписания и мутируют чужие', async () => {
    const created = await scheduleStore.create({ ...body(), projectId });

    for (const actor of ['admin', 'lead']) {
      expect(await listNames(actor)).toHaveLength(1);
      expect((await post(`/api/v2/schedules/${created.id}/run`, actor)).status).toBe(200);
      const update = await put(`/api/v2/schedules/${created.id}`, actor, { ...body(), name: `by-${actor}` });
      expect(update.status).toBe(200);
    }
  });

  it('чужой пользователь: расписание не видно в списке и недоступно (403)', async () => {
    const created = await scheduleStore.create({ ...body(), projectId });

    // В списке чужого расписания нет.
    expect(await listNames('stranger')).toEqual([]);

    // Чтение истории и мутации — отказ.
    const jobs = await req(`/api/v2/schedules/${created.id}/jobs`, 'stranger');
    expect(jobs.status).toBe(403);
    expect((await post('/api/v2/schedules', 'stranger', body())).status).toBe(403);
    expect((await put(`/api/v2/schedules/${created.id}`, 'stranger', body())).status).toBe(403);
    expect((await req(`/api/v2/schedules/${created.id}`, 'stranger', { method: 'DELETE' })).status).toBe(403);
    expect((await post(`/api/v2/schedules/${created.id}/run`, 'stranger')).status).toBe(403);

    // Запись на месте.
    expect(await scheduleStore.get(created.id)).not.toBeNull();
  });

  it('собственное расписание (ownerId) видно и без доступа к проекту', async () => {
    await scheduleStore.create({ ...body(), name: 'mine', projectId: 'proj_other', ownerId: 'stranger' });

    expect(await listNames('stranger')).toEqual(['mine']);
  });

  it('GET /:id/jobs — чтение по правам на проект', async () => {
    const created = await scheduleStore.create({ ...body(), projectId });

    for (const actor of ['owner', 'editor', 'viewer', 'admin', 'lead']) {
      const res = await req(`/api/v2/schedules/${created.id}/jobs`, actor);
      expect(res.status, actor).toBe(200);
    }
  });

  // --- service-key (ADR-052): скоупы + проекция `allowedProjects` ------------

  it('service-key со scope schedules:read и allowedProjects — видит только свой проект', async () => {
    await scheduleStore.create({ ...body(), projectId });
    await scheduleStore.create({ ...body(), name: 'other', projectId: otherProjectId });

    expect(await listNames(`${SERVICE_KEY_PREFIX}reader`)).toEqual(['nightly']);
  });

  it('service-key без allowedProjects — видит все расписания (прежнее поведение)', async () => {
    await scheduleStore.create({ ...body(), projectId });
    await scheduleStore.create({ ...body(), name: 'other', projectId: otherProjectId });

    expect((await listNames(`${SERVICE_KEY_PREFIX}reader-all`)).sort()).toEqual([
      'nightly',
      'other',
    ]);
  });

  it('service-key со scope schedules:write — создаёт и правит в своём проекте', async () => {
    const key = `${SERVICE_KEY_PREFIX}writer`;

    const create = await post('/api/v2/schedules', key, body());
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { schedule: { id: string } }).schedule.id;

    const update = await put(`/api/v2/schedules/${id}`, key, { ...body(), name: 'by-key' });
    expect(update.status).toBe(200);
    expect((await update.json() as { schedule: { name: string } }).schedule.name).toBe('by-key');
  });

  it('service-key: проект вне allowedProjects — 403', async () => {
    const key = `${SERVICE_KEY_PREFIX}writer`;
    const foreign = await post('/api/v2/schedules', key, {
      ...body(),
      target: { mode: 'bound', sessionId: 's2' },
    });
    expect(foreign.status).toBe(403);
  });

  it('service-key без scope schedules:write — мутация → 403 (SCOPE_REQUIRED)', async () => {
    const res = await post('/api/v2/schedules', `${SERVICE_KEY_PREFIX}noscope`, body());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SCOPE_REQUIRED');
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

      // Проект + сессия — цель расписания (PROP-141: проект обязателен).
      const project = await handle.app.request('/api/v2/projects', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-key-456', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Schedules wiring' }),
      });
      expect(project.status).toBe(201);
      const projectId = ((await project.json()) as { id: string }).id;

      const session = await handle.app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-key-456', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sched', projectId }),
      });
      expect(session.status).toBe(201);
      const sessionId = ((await session.json()) as { id: string }).id;

      const scheduleBody = {
        name: 'nightly',
        every: '1h',
        target: { mode: 'bound', sessionId },
      };

      // Владелец проекта — создаёт (прежний `requireAdmin` снят, PROP-141).
      const created = await handle.app.request('/api/v2/schedules', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-key-456', 'Content-Type': 'application/json' },
        body: JSON.stringify(scheduleBody),
      });
      expect(created.status).toBe(201);
      const scheduleId = ((await created.json()) as { schedule: { id: string } }).schedule.id;

      // ADMIN — тоже (сквозной обзор).
      const adminRun = await handle.app.request(`/api/v2/schedules/${scheduleId}/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-key-123' },
      });
      expect(adminRun.status).toBe(200);

      // Чужой пользователь (не участник проекта) — отказ.
      const forbidden = await handle.app.request('/api/v2/schedules', {
        method: 'POST',
        headers: { Authorization: 'Bearer auditor-key-012', 'Content-Type': 'application/json' },
        body: JSON.stringify(scheduleBody),
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
