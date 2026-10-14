/**
 * AD-052/O1 × AD-089: админский user-API — guard «ADMIN или scope `users:read`»
 * и `identities` профиля в деталях пользователя (snake_case).
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

describe('backend user-API — scope users:read и identities (AD-052/O1)', () => {
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
