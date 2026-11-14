/**
 * PROP-133 §3.3: каталог пользователей `GET /api/v2/users/directory`.
 *
 * Доступ — любой аутентифицированный (не только ADMIN): владелец проекта
 * физически должен иметь возможность выбрать участников. Ответ — лёгкая
 * проекция `{id, username, display_name}` (без ролей/почты/идентичностей),
 * постраничная (ADR-118 §4), с поиском `?q=`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore } from '@itphx/synth-core';
import type { ProfileData } from '@itphx/synth-shared';
import { createUserRoutes } from './users.js';

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

function createMockKit() {
  return {
    attachUser: async (c: Context, next: Next) => {
      const header = c.req.header('Authorization');
      if (header === 'Bearer admin') {
        c.set('user', { id: 'admin', username: 'admin', roles: ['ADMIN'] });
      } else if (header === 'Bearer dev') {
        c.set('user', { id: 'developer', username: 'developer', roles: ['USER'] });
      }
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

function profile(id: string, username: string, extra: Partial<ProfileData> = {}): ProfileData {
  return {
    id,
    username,
    email: `${username}@example.com`,
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: 'служебная заметка',
    interviewCompleted: true,
    displayName: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('PROP-133: GET /api/v2/users/directory', () => {
  let tmpDir: string;
  let store: FileProfileStore;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-users-directory-'));
    store = new FileProfileStore({ dataDir: tmpDir });
    await store.saveProfile(profile('id-alice', 'alice', { displayName: 'Alice Example' }));
    await store.saveProfile(profile('id-bob', 'bob'));
    await store.saveProfile(profile('id-carol', 'carol', { displayName: 'Carol Example' }));
    await store.saveProfile(profile('id-off', 'off', { isActive: false }));

    app = new Hono();
    const kit = createMockKit();
    app.use('*', kit.attachUser as never);
    app.route('/api/v2/users', createUserRoutes(kit as never, store));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const get = (path: string, auth?: string): Promise<Response> =>
    Promise.resolve(app.request(path, { headers: auth ? { Authorization: auth } : {} }));

  it('обычный USER получает каталог (не только ADMIN)', async () => {
    const res = await get('/api/v2/users/directory', 'Bearer dev');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(body.total).toBe(3);
    expect(body.offset).toBe(0);
    expect(body.next_offset).toBeNull();
    expect(body.users.map((u) => u.username)).toEqual(['alice', 'bob', 'carol']);
  });

  it('в ответе только лёгкая проекция — без ролей/почты/идентичностей', async () => {
    const res = await get('/api/v2/users/directory', 'Bearer dev');
    const body = (await res.json()) as { users: Array<Record<string, unknown>> };
    expect(body.users[0]).toBeDefined();
    expect(Object.keys(body.users[0] ?? {}).sort()).toEqual(['display_name', 'id', 'username']);
  });

  it('неактивные пользователи в каталог не попадают', async () => {
    const res = await get('/api/v2/users/directory', 'Bearer dev');
    const body = (await res.json()) as { users: Array<Record<string, unknown>> };
    expect(body.users.map((u) => u.username)).not.toContain('off');
  });

  it('постранично: limit/offset и курсор next_offset', async () => {
    const first = await get('/api/v2/users/directory?limit=2', 'Bearer dev');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      users: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      next_offset: number | null;
    };
    expect(firstBody.users).toHaveLength(2);
    expect(firstBody.total).toBe(3);
    expect(firstBody.limit).toBe(2);
    expect(firstBody.next_offset).toBe(2);

    const second = await get('/api/v2/users/directory?limit=2&offset=2', 'Bearer dev');
    const secondBody = (await second.json()) as {
      users: Array<Record<string, unknown>>;
      next_offset: number | null;
    };
    expect(secondBody.users).toHaveLength(1);
    expect(secondBody.next_offset).toBeNull();
  });

  it('поиск `?q=` — по username и display_name, регистронезависимо', async () => {
    const byUsername = await get('/api/v2/users/directory?q=ALI', 'Bearer dev');
    const byUsernameBody = (await byUsername.json()) as { users: Array<Record<string, unknown>> };
    expect(byUsernameBody.users.map((u) => u.username)).toEqual(['alice']);

    const byDisplayName = await get('/api/v2/users/directory?q=carol%20example', 'Bearer dev');
    const byDisplayNameBody = (await byDisplayName.json()) as { users: Array<Record<string, unknown>> };
    expect(byDisplayNameBody.users.map((u) => u.username)).toEqual(['carol']);

    const empty = await get('/api/v2/users/directory?q=zzz', 'Bearer dev');
    const emptyBody = (await empty.json()) as { users: unknown[]; total: number };
    expect(emptyBody.users).toHaveLength(0);
    expect(emptyBody.total).toBe(0);
  });

  it('некорректный limit → 400 VALIDATION_ERROR', async () => {
    const res = await get('/api/v2/users/directory?limit=abc', 'Bearer dev');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('без аутентификации → 401', async () => {
    const res = await get('/api/v2/users/directory');
    expect(res.status).toBe(401);
  });

  it('маршрут не перехватывает `GET /users/:id`', async () => {
    const res = await get('/api/v2/users/id-alice', 'Bearer admin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; username: string };
    expect(body.id).toBe('id-alice');
  });
});
