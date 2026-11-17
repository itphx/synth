/**
 * PROP-141 (этап 5, B-2): managed-доступ к таймерам/будильникам.
 *
 * Проверяем матрицу прав (production-модуль `routes/project-access.ts` →
 * `createBackendProjectAccess` — тот же хелпер, что у расписаний):
 * 1. владелец проекта и `EDITOR` — мутируют свои таймеры;
 * 2. `VIEWER` — читает, но не мутирует (инвариант 21);
 * 3. `ADMIN`/`LEAD` — всё (сквозной обзор);
 * 4. чужой — не видит таймер в списке и получает 403 по id;
 * 5. service-key — `timers:read`/`timers:write` + проекция `allowedProjects`;
 *    без scope → 403 `SCOPE_REQUIRED`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileTimerStore,
  FileTimerFiringStore,
  ProjectStore,
  TimerService,
  createTimerRoutes,
} from '@itphx/synth-core';
import type { ProjectRepository } from '@itphx/synth-core';
import { ProjectRole } from '@itphx/synth-shared';
import type { Timer, User } from '@itphx/synth-shared';
import { createBackendProjectAccess } from './project-access.js';
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

type MockUser = User & { roles: string[] };

const USERS: Record<string, MockUser> = {
  admin: makeUser('admin', ['ADMIN']) as MockUser,
  lead: makeUser('lead', ['LEAD']) as MockUser,
  owner: makeUser('owner', ['USER']) as MockUser,
  editor: makeUser('editor', ['USER']) as MockUser,
  viewer: makeUser('viewer', ['USER']) as MockUser,
  stranger: makeUser('stranger', ['USER']) as MockUser,
};

/** Кредентал service-key (ADR-052): синтетический пользователь, скоупы, проекция. */
interface MockServiceCredential {
  keyId: string;
  label: string;
  roles: string[];
  scopes: string[];
  allowedProjects?: string[];
}

const SERVICE_KEY_PREFIX = 'synth_svc_';

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (.+)$/.exec(header ?? '')?.[1];
}

/** Мок-AuthKit: пользователь из `Authorization` (интерактив или service-key). */
function createMockKit(serviceKeys: Map<string, MockServiceCredential>) {
  const resolveUser = (header: string | undefined): MockUser | null => {
    const token = bearerToken(header);
    if (!token) return null;
    if (token.startsWith(SERVICE_KEY_PREFIX)) {
      const credential = serviceKeys.get(token.slice(SERVICE_KEY_PREFIX.length));
      if (!credential) return null;
      return {
        ...makeUser(`service:${credential.keyId}`, credential.roles as User['roles']),
        roles: credential.roles,
      } as MockUser;
    }
    return USERS[token] ?? null;
  };
  const resolveCredential = (header: string | undefined): MockServiceCredential | undefined => {
    const token = bearerToken(header);
    if (!token || !token.startsWith(SERVICE_KEY_PREFIX)) return undefined;
    return serviceKeys.get(token.slice(SERVICE_KEY_PREFIX.length));
  };

  const requireAuth = async (c: Context, next: Next) => {
    const user = resolveUser(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user' as never, user as never);
    const credential = resolveCredential(c.req.header('Authorization'));
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
    getCurrentUser: async (c: Context) => resolveUser(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as User | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as User | undefined)?.roles ?? []).includes(r)),
  };
}

describe('Managed: права на таймеры — по проекту (PROP-141, этап 5 B-2)', () => {
  let tmpDir: string;
  let timers: FileTimerStore;
  let firings: FileTimerFiringStore;
  let service: TimerService;
  let projectStore: ProjectStore;
  let projectId: string;
  let otherProjectId: string;
  let serviceKeys: Map<string, MockServiceCredential>;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-timers-'));
    timers = new FileTimerStore({ dataDir: tmpDir });
    firings = new FileTimerFiringStore({ dataDir: tmpDir });
    service = new TimerService({ timers, firings, deliver: async () => {} });

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

    serviceKeys = new Map<string, MockServiceCredential>([
      ['reader', {
        keyId: 'svk_reader',
        label: 'reader',
        roles: [],
        scopes: ['timers:read'],
        allowedProjects: [projectId],
      }],
      ['reader-all', {
        keyId: 'svk_reader_all',
        label: 'reader-all',
        roles: [],
        scopes: ['timers:read'],
      }],
      ['writer', {
        keyId: 'svk_writer',
        label: 'writer',
        roles: [],
        scopes: ['timers:write'],
        allowedProjects: [projectId],
      }],
      ['noscope', {
        keyId: 'svk_noscope',
        label: 'noscope',
        roles: [],
        scopes: [],
      }],
    ]);

    const kit = createMockKit(serviceKeys);
    // Тот же production-модуль, что монтирует `app/mount-routes.ts`.
    const access = createBackendProjectAccess({
      auth: kit as unknown as AuthKit,
      projectStore: projectStore as unknown as ProjectRepository,
    });

    app = new Hono();
    // `attachUser` в managed кладёт пользователя в контекст — так же и здесь.
    app.use('*', async (c, next) => {
      const token = bearerToken(c.req.header('Authorization'));
      if (!token) return next();
      if (token.startsWith(SERVICE_KEY_PREFIX)) {
        const credential = serviceKeys.get(token.slice(SERVICE_KEY_PREFIX.length));
        if (credential) {
          c.set('user' as never, {
            ...makeUser(`service:${credential.keyId}`, credential.roles as User['roles']),
            roles: credential.roles,
          } as never);
          c.set('serviceKey' as never, credential as never);
        }
        return next();
      }
      const user = USERS[token];
      if (user) c.set('user' as never, user as never);
      await next();
    });
    app.route('/api/v2/timers', createTimerRoutes(
      { requireAuth: kit.requireAuth as unknown as never },
      { timerService: service, timers, firings },
      {
        writeGuard: kit.requireAuth as unknown as never,
        // Сессия `s1` — в первом проекте, `s2` — во втором (чужой для ключа).
        resolveSessionProject: async (id) =>
          id === 's1' ? projectId : id === 's2' ? otherProjectId : undefined,
        authorizeProject: access.authorizeProject,
        listVisibleProjectIds: access.listVisibleProjectIds,
      },
    ));
  });

  afterEach(async () => {
    await service.stop();
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

  const body = () => ({
    kind: 'timer',
    comment: 'напомнить',
    sessionId: 's1',
    repeat: { mode: 'once' },
    delaySec: 600,
  });

  /** Создать таймер портом (фикстуры матрицы). */
  const seed = async (overrides: Partial<Timer> = {}): Promise<Timer> =>
    timers.create({
      kind: 'timer',
      comment: 'c',
      projectId,
      sessionId: 's1',
      ownerId: 'owner',
      repeat: { mode: 'once' },
      status: 'active',
      firesAt: '2030-01-01T00:00:00.000Z',
      ...overrides,
    });

  const listComments = async (token: string): Promise<string[]> => {
    const res = await req('/api/v2/timers', token);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { timers: { comment: string }[] };
    return payload.timers.map((timer) => timer.comment);
  };

  it('владелец проекта: создаёт, правит, ставит на паузу и удаляет таймер', async () => {
    const create = await post('/api/v2/timers', 'owner', body());
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { timer: { id: string } }).timer.id;

    const patch = await req(`/api/v2/timers/${id}`, 'owner', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'новое' }),
    });
    expect(patch.status).toBe(200);

    expect((await post(`/api/v2/timers/${id}/pause`, 'owner')).status).toBe(200);
    expect((await req(`/api/v2/timers/${id}`, 'owner', { method: 'DELETE' })).status).toBe(204);
  });

  it('EDITOR проекта: создаёт, правит и удаляет таймер', async () => {
    const create = await post('/api/v2/timers', 'editor', body());
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { timer: { id: string } }).timer.id;

    const patch = await req(`/api/v2/timers/${id}`, 'editor', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'edited' }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json() as { timer: { comment: string } }).timer.comment).toBe('edited');

    expect((await req(`/api/v2/timers/${id}`, 'editor', { method: 'DELETE' })).status).toBe(204);
  });

  it('VIEWER проекта: читает, но не мутирует (403)', async () => {
    const created = await seed({ comment: 'таймер' });
    expect(await listComments('viewer')).toEqual(['таймер']);

    expect((await post('/api/v2/timers', 'viewer', body())).status).toBe(403);
    expect((await req(`/api/v2/timers/${created.id}`, 'viewer', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'x' }),
    })).status).toBe(403);
    expect((await post(`/api/v2/timers/${created.id}/pause`, 'viewer')).status).toBe(403);
    expect((await req(`/api/v2/timers/${created.id}`, 'viewer', { method: 'DELETE' })).status).toBe(403);

    // Запись не изменилась.
    expect((await timers.get(created.id))?.comment).toBe('таймер');
  });

  it('ADMIN/LEAD: видят все таймеры и мутируют чужие', async () => {
    const created = await seed({ comment: 'таймер' });
    for (const actor of ['admin', 'lead']) {
      expect(await listComments(actor)).toEqual(['таймер']);
      expect((await post(`/api/v2/timers/${created.id}/pause`, actor)).status).toBe(200);
    }
  });

  it('чужой пользователь: не видит таймер в списке и получает 403 по id', async () => {
    await seed({ comment: 'таймер' });
    expect(await listComments('stranger')).toEqual([]);

    const created = await seed({ comment: 'таймер' });
    expect((await req(`/api/v2/timers/${created.id}/firings`, 'stranger')).status).toBe(403);
    expect((await req(`/api/v2/timers/${created.id}`, 'stranger', { method: 'DELETE' })).status).toBe(403);
    expect((await post(`/api/v2/timers/${created.id}/resume`, 'stranger')).status).toBe(403);
  });

  it('service-key с timers:read читает свой проект, чужой — не видит', async () => {
    await seed({ comment: 'таймер' });
    const token = `${SERVICE_KEY_PREFIX}reader`;
    expect(await listComments(token)).toEqual(['таймер']);

    await seed({ comment: 'чужой', projectId: otherProjectId, sessionId: 's2' });
    expect(await listComments(token)).toEqual(['таймер']);
  });

  it('service-key с timers:write создаёт и мутирует таймер своего проекта', async () => {
    const token = `${SERVICE_KEY_PREFIX}writer`;
    const create = await post('/api/v2/timers', token, body());
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { timer: { id: string } }).timer.id;

    expect((await post(`/api/v2/timers/${id}/pause`, token)).status).toBe(200);
    expect((await req(`/api/v2/timers/${id}`, token, { method: 'DELETE' })).status).toBe(204);
  });

  it('service-key без scope → 403 SCOPE_REQUIRED', async () => {
    const res = await req('/api/v2/timers', `${SERVICE_KEY_PREFIX}noscope`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SCOPE_REQUIRED');
  });

  it('service-key без проекции в allowedProjects → 403', async () => {
    const res = await post('/api/v2/timers', `${SERVICE_KEY_PREFIX}reader`, {
      ...body(),
      sessionId: 's2',
    });
    expect(res.status).toBe(403);
  });
});
