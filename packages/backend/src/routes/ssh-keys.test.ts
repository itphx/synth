// ADR-076 §T5: backend монтирует core-фабрики SSH-ключей с managed-RBAC.
// Проверяем: запись (POST/PATCH/DELETE) — только ADMIN, чтение (GET) — USER;
// flat и nested пути смонтированы как в `app.ts`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SSHKeyStore,
  createSshKeyRoutes,
  createAgentSshKeyRoutes,
  crypto,
} from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

const SAMPLE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nbackend-secret\n-----END OPENSSH PRIVATE KEY-----';

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

describe('SSH Keys API Routes (ADR-076 §T5, backend RBAC)', () => {
  let dataDir: string;
  let store: SSHKeyStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-sshkeys-'));
    store = new SSHKeyStore({ dataDir });
  });

  afterEach(async () => {
    crypto.clearMasterKeyCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeApp(user: User | null) {
    const { requireAuth, requireAdmin } = makeGuards(user);
    const app = new Hono();
    app.route('/api/v2/ssh-keys', createSshKeyRoutes({ requireAuth }, store, {
      writeGuard: requireAdmin,
    }));
    app.route(
      '/api/v2/agents/:agentId/ssh-keys',
      createAgentSshKeyRoutes({ requireAuth }, store, { writeGuard: requireAdmin }),
    );
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

  function patch(app: Hono, path: string, body: unknown) {
    return app.request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('USER: GET доступен (200), POST/PATCH/DELETE → 403', async () => {
    const created = await store.create({ name: 'seed', privateKey: SAMPLE_KEY });
    const app = makeApp(user);

    const list = await app.request('/api/v2/ssh-keys');
    expect(list.status).toBe(200);
    const get = await app.request(`/api/v2/ssh-keys/${created.id}`);
    expect(get.status).toBe(200);

    const create = await post(app, '/api/v2/ssh-keys', { name: 'x', privateKey: SAMPLE_KEY });
    expect(create.status).toBe(403);
    const update = await patch(app, `/api/v2/ssh-keys/${created.id}`, { name: 'y' });
    expect(update.status).toBe(403);
    const del = await app.request(`/api/v2/ssh-keys/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(403);

    const nestedPost = await post(app, '/api/v2/agents/a1/ssh-keys', {
      name: 'n',
      privateKey: SAMPLE_KEY,
    });
    expect(nestedPost.status).toBe(403);
    const nestedDel = await app.request(`/api/v2/agents/a1/ssh-keys/${created.id}`, {
      method: 'DELETE',
    });
    expect(nestedDel.status).toBe(403);
  });

  it('неаутентифицированный → 401 на GET', async () => {
    const app = makeApp(null);
    const res = await app.request('/api/v2/ssh-keys');
    expect(res.status).toBe(401);
  });

  it('ADMIN: POST 201, PATCH 200, DELETE 204; nested POST 201', async () => {
    const app = makeApp(admin);

    const create = await post(app, '/api/v2/ssh-keys', { name: 'adm', privateKey: SAMPLE_KEY });
    expect(create.status).toBe(201);
    const id = (await create.json() as { id: string }).id;

    const update = await patch(app, `/api/v2/ssh-keys/${id}`, { name: 'adm-2' });
    expect(update.status).toBe(200);
    expect((await update.json() as { name: string }).name).toBe('adm-2');

    const nested = await post(app, '/api/v2/agents/a1/ssh-keys', {
      name: 'nested',
      privateKey: SAMPLE_KEY,
    });
    expect(nested.status).toBe(201);
    const nestedId = (await nested.json() as { id: string }).id;
    expect(await store.get(nestedId)).not.toBeNull();

    const del = await app.request(`/api/v2/ssh-keys/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await store.get(id)).toBeNull();
  });

  it('USER: GET nested-роута доступен (200)', async () => {
    await store.create({ name: 'a', privateKey: SAMPLE_KEY, agentIds: ['a1'] });
    const app = makeApp(user);
    const res = await app.request('/api/v2/agents/a1/ssh-keys');
    expect(res.status).toBe(200);
    expect((await res.json() as unknown[])).toHaveLength(1);
  });
});
