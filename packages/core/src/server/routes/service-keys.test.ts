import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createServiceKeyRoutes } from './service-keys.js';
import type { ServiceKeyRoutesOptions } from './service-keys.js';
import { ServiceApiKeyStore } from '../../storage/service-api-key-store.js';

/** Mock-auth: requireAuth пропускает и выставляет пользователя. */
const mockAuth = {
  requireAuth: (async (c: Context, next: Next) => {
    c.set('user' as never, { id: 'u-9' } as never);
    await next();
  }) as MiddlewareHandler,
};

describe('Service Keys API Routes (AD-052, этап I)', () => {
  let tmpDir: string;
  let store: ServiceApiKeyStore;

  const makeApp = (opts: ServiceKeyRoutesOptions = {}) => {
    const app = new Hono();
    app.route('/api/v2/service-keys', createServiceKeyRoutes(mockAuth, { store }, opts));
    return app;
  };

  const postJson = (app: Hono, path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-service-key-routes-'));
    store = new ServiceApiKeyStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET / — пустой список', async () => {
    const res = await makeApp().request('/api/v2/service-keys');
    expect(res.status).toBe(200);
    expect((await res.json() as { keys: unknown[] }).keys).toEqual([]);
  });

  it('POST / — создание (секрет единожды, createdBy из контекста)', async () => {
    const app = makeApp();
    const res = await postJson(app, '/api/v2/service-keys', {
      label: 'gateway',
      scopes: ['events:ingest'],
      allowedProjects: ['p1'],
    });
    expect(res.status).toBe(201);
    const created = await res.json() as {
      id: string; label: string; key: string; prefix: string; createdBy: string; allowedProjects?: string[];
    };
    expect(created.id).toMatch(/^svk_/);
    expect(created.key.startsWith('synth_svc_')).toBe(true);
    expect(created.prefix.endsWith('…')).toBe(true);
    expect(created.createdBy).toBe('u-9');
    expect(created.allowedProjects).toEqual(['p1']);
  });

  it('POST / — невалидные scope/label → 400; дубликат label → 409 CONFLICT', async () => {
    const app = makeApp();
    expect((await postJson(app, '/api/v2/service-keys', { scopes: ['events:ingest'] })).status).toBe(400);
    expect((await postJson(app, '/api/v2/service-keys', { label: 'x', scopes: ['bogus:read'] })).status).toBe(400);

    const first = await postJson(app, '/api/v2/service-keys', { label: 'shared', scopes: ['events:ingest'] });
    expect(first.status).toBe(201);
    const dup = await postJson(app, '/api/v2/service-keys', { label: ' SHARED ', scopes: ['events:ingest'] });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('GET /:id — метаданные и 404', async () => {
    const app = makeApp();
    const created = await (await postJson(app, '/api/v2/service-keys', { label: 'g', scopes: ['llm:chat'] })).json() as { id: string; key: string };
    const res = await app.request(`/api/v2/service-keys/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toBeUndefined();

    expect((await app.request('/api/v2/service-keys/svk_missing')).status).toBe(404);
  });

  it('GET /scopes — каталог из shared; литерал не перехватывается /:id (порядок роутов)', async () => {
    const res = await makeApp().request('/api/v2/service-keys/scopes');
    // 200 (а не 404 от `/:id`) подтверждает порядок объявления роутов.
    expect(res.status).toBe(200);
    const body = await res.json() as { scopes: string[]; families: string[]; roles: string[] };
    expect(body.scopes).toContain('events:ingest');
    expect(body.scopes).toContain('addons:install');
    expect(body.scopes).toContain('users:read');
    expect(body.families).toContain('events');
    expect(body.families).toContain('sessions');
    expect(body.roles).toEqual(['ADMIN', 'USER', 'LEAD', 'AUDITOR']);
  });

  it('GET /scopes — тот же readGuard, что у GET /', async () => {
    const deny = (async (c: Context) => c.json({ error: { code: 'FORBIDDEN' } }, 403)) as MiddlewareHandler;
    const app = makeApp({ readGuard: deny });
    expect((await app.request('/api/v2/service-keys/scopes')).status).toBe(403);
    expect((await app.request('/api/v2/service-keys')).status).toBe(403);
  });

  it('PATCH /:id — обновление и сброс; 404; конфликт 409', async () => {
    const app = makeApp();
    const a = await (await postJson(app, '/api/v2/service-keys', { label: 'alpha', scopes: ['events:ingest'], rateLimitPerMinute: 5 })).json() as { id: string };
    await postJson(app, '/api/v2/service-keys', { label: 'beta', scopes: ['events:ingest'] });

    const patch = (id: string, body: unknown) => app.request(`/api/v2/service-keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const ok = await patch(a.id, { description: 'new', rateLimitPerMinute: null });
    expect(ok.status).toBe(200);
    const updated = await ok.json() as { label: string; description?: string; rateLimitPerMinute?: number };
    expect(updated.description).toBe('new');
    expect(updated.rateLimitPerMinute).toBeUndefined();

    expect((await patch('svk_missing', { description: 'x' })).status).toBe(404);
    const conflict = await patch(a.id, { label: 'BETA' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('POST /:id/revoke — мягкий отзыв; resolve больше не срабатывает; 404', async () => {
    const app = makeApp();
    const created = await (await postJson(app, '/api/v2/service-keys', { label: 'g', scopes: ['events:ingest'] })).json() as { id: string; key: string };

    const revoke = await app.request(`/api/v2/service-keys/${created.id}/revoke`, { method: 'POST' });
    expect(revoke.status).toBe(200);
    const body = await revoke.json() as { id: string; revokedAt?: string };
    expect(typeof body.revokedAt).toBe('string');
    expect(await store.resolveBySecret(created.key)).toBeNull();

    expect((await app.request('/api/v2/service-keys/svk_missing/revoke', { method: 'POST' })).status).toBe(404);
  });

  it('DELETE /:id — 204 затем 404', async () => {
    const app = makeApp();
    const created = await (await postJson(app, '/api/v2/service-keys', { label: 'g', scopes: ['events:ingest'] })).json() as { id: string };
    expect((await app.request(`/api/v2/service-keys/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/v2/service-keys/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('readGuard/writeGuard ограничивают доступ', async () => {
    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const app = makeApp({ readGuard: deny, writeGuard: deny });
    expect((await app.request('/api/v2/service-keys')).status).toBe(403);
    expect((await postJson(app, '/api/v2/service-keys', { label: 'g', scopes: ['events:ingest'] })).status).toBe(403);
  });
});
