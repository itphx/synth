/**
 * ADR-140 Ф2: каталог групп `GET /api/v2/users/groups`.
 *
 * Источник групп — allowlist `auth.oidc.groups.allow`: показываются только те
 * группы, которые вообще можно выдать (дубли схлопываются, порядок — по имени).
 * Доступ — **любой аутентифицированный** пользователь (не только ADMIN), как
 * `/directory`: группы нужны владельцу проекта для выбора участников.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { ProfileStore } from '@itphx/synth-shared';
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

interface GroupsResponse {
  groups: Array<{ name: string }>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

function createApp(groups: readonly string[]): Hono {
  const app = new Hono();
  const kit = createMockKit();
  app.use('*', kit.attachUser as never);
  // Профили маршрут групп не читает — заглушка.
  app.route('/api/v2/users', createUserRoutes(kit as never, {} as ProfileStore, { groups }));
  return app;
}

const get = (app: Hono, path: string, auth?: string): Promise<Response> =>
  Promise.resolve(app.request(path, { headers: auth ? { Authorization: auth } : {} }));

describe('ADR-140 Ф2: GET /api/v2/users/groups', () => {
  it('без аутентификации → 401', async () => {
    const res = await get(createApp(['platform']), '/api/v2/users/groups');
    expect(res.status).toBe(401);
  });

  it('обычный USER получает каталог групп (не только ADMIN)', async () => {
    const res = await get(createApp(['platform', 'sre-oncall']), '/api/v2/users/groups', 'Bearer dev');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsResponse;
    expect(body.total).toBe(2);
    expect(body.groups.map((g) => g.name)).toEqual(['platform', 'sre-oncall']);
  });

  it('дубли схлопываются, группы отсортированы по имени', async () => {
    const res = await get(
      createApp(['platform', 'sre-oncall', 'platform']),
      '/api/v2/users/groups',
      'Bearer dev',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsResponse;
    expect(body.total).toBe(2);
    expect(body.groups.map((g) => g.name)).toEqual(['platform', 'sre-oncall']);
  });

  it('поиск `?q=` — регистронезависимо', async () => {
    const res = await get(
      createApp(['platform', 'sre-oncall']),
      '/api/v2/users/groups?q=SRE',
      'Bearer dev',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsResponse;
    expect(body.total).toBe(1);
    expect(body.groups.map((g) => g.name)).toEqual(['sre-oncall']);
  });

  it('постранично: limit/offset и курсор next_offset', async () => {
    const app = createApp(['platform', 'sre-oncall', 'backend', 'platform']);
    const res = await get(app, '/api/v2/users/groups?limit=1&offset=1', 'Bearer dev');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsResponse;
    expect(body.total).toBe(3);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect(body.groups.map((g) => g.name)).toEqual(['platform']);
    expect(body.next_offset).toBe(2);
  });

  it('некорректный limit → 400 VALIDATION_ERROR', async () => {
    const res = await get(createApp(['platform']), '/api/v2/users/groups?limit=abc', 'Bearer dev');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('пустой allowlist → пустой список (fail-closed)', async () => {
    const res = await get(createApp([]), '/api/v2/users/groups', 'Bearer dev');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsResponse;
    expect(body.total).toBe(0);
    expect(body.groups).toHaveLength(0);
    expect(body.next_offset).toBeNull();
  });
});
