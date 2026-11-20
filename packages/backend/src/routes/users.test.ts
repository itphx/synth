/**
 * ADR-052/O1 × ADR-089: админский user-API — guard «ADMIN или scope `users:read`»
 * и `identities` профиля в деталях пользователя (snake_case).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore } from '@itphx/synth-core';
import { EventBus, INSTANCE_EVENT_CHANNEL } from '@itphx/synth-core';
import type { BusEvent, ProfileData } from '@itphx/synth-shared';
import { createUserRoutes } from './users.js';
import {
  usersChangedPublisher,
  type UsersChangedInfo,
} from '../events/users-events.js';

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

function userFromHeader(header: string | undefined): MockUser | null {
  if (header === 'Bearer admin') return { id: 'admin', username: 'admin', roles: ['ADMIN'] };
  if (header === 'Bearer dev') return { id: 'developer', username: 'developer', roles: ['USER'] };
  return null;
}

function serviceKeyFromHeader(
  header: string | undefined,
): { user: MockUser; scopes: string[] } | null {
  if (header === 'Bearer svc-read') {
    return { user: { id: 'service:svc1', username: 'consent', roles: ['USER'] }, scopes: ['users:read'] };
  }
  if (header === 'Bearer svc-noscope') {
    return { user: { id: 'service:svc2', username: 'consent', roles: ['USER'] }, scopes: [] };
  }
  return null;
}

/** Мини-AuthKit: attachUser-подобная установка пользователя/ключа + requireAdmin. */
function createMockKit() {
  return {
    attachUser: async (c: Context, next: Next) => {
      const svc = serviceKeyFromHeader(c.req.header('Authorization'));
      if (svc) {
        c.set('user', svc.user);
        c.set('serviceKey', {
          keyId: svc.user.id,
          label: svc.user.username,
          roles: svc.user.roles,
          scopes: svc.scopes,
        });
        await next();
        return;
      }
      const user = userFromHeader(c.req.header('Authorization'));
      if (user) c.set('user', user);
      await next();
    },
    requireAuth: async (c: Context, next: Next) => {
      const user = c.get('user') as MockUser | undefined;
      if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
      await next();
    },
    requireAdmin: async (c: Context, next: Next) => {
      const user = c.get('user') as MockUser | undefined;
      if (!user || !user.roles.includes('ADMIN')) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
  };
}

const PROFILE_ID = 'profile-1';

function makeProfile(): ProfileData {
  return {
    id: PROFILE_ID,
    username: 'someone',
    email: 'someone@example.com',
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: '',
    interviewCompleted: true,
    identities: [
      { provider: 'tg', externalId: '450316139', username: 'tguser', displayName: 'TG User', linkedAt: '2026-01-01T00:00:00.000Z', linkedBy: 'local' },
      { provider: 'slack', externalId: 'U123', linkedAt: '2026-01-02T00:00:00.000Z' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('backend user-API — scope users:read и identities (ADR-052/O1)', () => {
  let tmpDir: string;
  let store: FileProfileStore;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-users-routes-'));
    store = new FileProfileStore({ dataDir: tmpDir });
    await store.saveProfile(makeProfile());

    app = new Hono();
    const kit = createMockKit();
    app.use('*', kit.attachUser as never);
    app.route('/api/v2/users', createUserRoutes(kit as never, store));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const get = async (path: string, auth?: string): Promise<Response> =>
    app.request(path, { headers: auth ? { Authorization: auth } : {} });

  it('ADMIN получает детали с identities (snake_case)', async () => {
    const res = await get(`/api/v2/users/${PROFILE_ID}`, 'Bearer admin');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      identities: Array<Record<string, unknown>>;
    };
    expect(body.identities).toEqual([
      {
        provider: 'tg',
        external_id: '450316139',
        username: 'tguser',
        display_name: 'TG User',
        linked_at: '2026-01-01T00:00:00.000Z',
        linked_by: 'local',
      },
      {
        provider: 'slack',
        external_id: 'U123',
        linked_at: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it('service-key со scope users:read → 200', async () => {
    const res = await get(`/api/v2/users/${PROFILE_ID}`, 'Bearer svc-read');
    expect(res.status).toBe(200);
    const body = await res.json() as { identities: unknown[] };
    expect(body.identities).toHaveLength(2);
  });

  it('service-key без scope → 403 SCOPE_REQUIRED', async () => {
    const res = await get(`/api/v2/users/${PROFILE_ID}`, 'Bearer svc-noscope');
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('интерактивный не-ADMIN → 403 FORBIDDEN', async () => {
    const detail = await get(`/api/v2/users/${PROFILE_ID}`, 'Bearer dev');
    expect(detail.status).toBe(403);
    const list = await get('/api/v2/users', 'Bearer dev');
    expect(list.status).toBe(403);
  });

  it('GET / (список) — без identities; доступен ADMIN и scope users:read', async () => {
    const admin = await get('/api/v2/users', 'Bearer admin');
    expect(admin.status).toBe(200);
    const adminBody = await admin.json() as { users: Array<Record<string, unknown>> };
    expect(adminBody.users[0]).not.toHaveProperty('identities');

    const svc = await get('/api/v2/users', 'Bearer svc-read');
    expect(svc.status).toBe(200);
  });

  it('GET /:id не найден → 404', async () => {
    const res = await get('/api/v2/users/missing', 'Bearer admin');
    expect(res.status).toBe(404);
  });
});

/**
 * Инвариант 27: мутация каталога пользователей (managed) публикует
 * `users.updated` в инстансный канал шины — иначе админ-панель «Пользователи»
 * во втором клиенте/вкладке держит снимок до перезагрузки страницы.
 *
 * Проверяем на уровне роутов: ровно один `action` на успешную мутацию, тишина на
 * отказах (400/403/404/409 — записи не было) и **состав payload'а**: ни почты, ни
 * заметок, ни ролей, ни токенов (инвариант 13).
 */
describe('backend user-API — публикация users.updated (инвариант 27)', () => {
  let tmpDir: string;
  let store: FileProfileStore;
  let calls: UsersChangedInfo[];
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-users-events-'));
    store = new FileProfileStore({ dataDir: tmpDir });
    await store.saveProfile(makeProfile());

    calls = [];
    app = new Hono();
    const kit = createMockKit();
    app.use('*', kit.attachUser as never);
    app.route(
      '/api/v2/users',
      createUserRoutes(kit as never, store, { onUsersChanged: (info) => calls.push(info) }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const request = async (
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    auth: string,
    body?: Record<string, unknown>,
  ): Promise<Response> =>
    app.request(path, {
      method,
      headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it('POST → 201 и событие `create` с id созданного пользователя', async () => {
    const res = await request('POST', '/api/v2/users', 'Bearer admin', {
      username: 'newbie',
      email: 'newbie@example.com',
      roles: ['USER'],
      notes: 'секретная заметка',
    });

    expect(res.status).toBe(201);
    const created = await res.json() as { id: string };
    expect(calls).toEqual([{ action: 'create', userId: created.id }]);
  });

  it('PUT → 200 и событие `update` с id профиля', async () => {
    const res = await request('PUT', `/api/v2/users/${PROFILE_ID}`, 'Bearer admin', {
      roles: ['ADMIN'],
      is_active: false,
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ action: 'update', userId: PROFILE_ID }]);
  });

  it('DELETE → 200 и событие `delete` с id профиля', async () => {
    const res = await request('DELETE', `/api/v2/users/${PROFILE_ID}`, 'Bearer admin');

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ action: 'delete', userId: PROFILE_ID }]);
  });

  it('400 (нет имени) — записи не было, событие не публикуется', async () => {
    const res = await request('POST', '/api/v2/users', 'Bearer admin', { email: 'x@example.com' });

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('409 (имя занято) — событие не публикуется', async () => {
    const res = await request('POST', '/api/v2/users', 'Bearer admin', { username: 'someone' });

    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('403 (не ADMIN) — событие не публикуется', async () => {
    const create = await request('POST', '/api/v2/users', 'Bearer dev', { username: 'newbie' });
    const update = await request('PUT', `/api/v2/users/${PROFILE_ID}`, 'Bearer dev', { roles: [] });
    const remove = await request('DELETE', `/api/v2/users/${PROFILE_ID}`, 'Bearer dev');

    expect([create.status, update.status, remove.status]).toEqual([403, 403, 403]);
    expect(calls).toEqual([]);
  });

  it('404 (нет пользователя) — событие не публикуется', async () => {
    const update = await request('PUT', '/api/v2/users/missing', 'Bearer admin', { roles: [] });
    const remove = await request('DELETE', '/api/v2/users/missing', 'Bearer admin');

    expect([update.status, remove.status]).toEqual([404, 404]);
    expect(calls).toEqual([]);
  });

  it('payload события — только id и вид мутации: без почты, заметок, ролей и токенов', async () => {
    const bus = new EventBus();
    const delivered: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];
    bus.subscribeAll((event: BusEvent) => {
      delivered.push({ sessionId: event.sessionId, type: event.type, data: event.data });
    });

    const wired = new Hono();
    const kit = createMockKit();
    wired.use('*', kit.attachUser as never);
    wired.route(
      '/api/v2/users',
      createUserRoutes(kit as never, store, { onUsersChanged: usersChangedPublisher(bus) }),
    );

    const res = await wired.request('/api/v2/users', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'leaky',
        email: 'leaky@example.com',
        roles: ['ADMIN'],
        notes: 'секретная заметка',
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string };

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe(INSTANCE_EVENT_CHANNEL);
    expect(delivered[0]!.type).toBe('users.updated');
    expect(Object.keys(delivered[0]!.data).sort()).toEqual(['action', 'userId']);
    expect(delivered[0]!.data).toEqual({ action: 'create', userId: created.id });

    const serialized = JSON.stringify(delivered[0]!.data);
    expect(serialized).not.toContain('leaky@example.com');
    expect(serialized).not.toContain('секретная заметка');
    expect(serialized).not.toContain('ADMIN');
  });

  it('без хука (`onUsersChanged` не задан) роуты работают как раньше', async () => {
    const plain = new Hono();
    const kit = createMockKit();
    plain.use('*', kit.attachUser as never);
    plain.route('/api/v2/users', createUserRoutes(kit as never, store));

    const res = await plain.request('/api/v2/users', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plain' }),
    });

    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
  });
});
