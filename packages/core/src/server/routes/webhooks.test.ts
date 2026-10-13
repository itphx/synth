import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createWebhookRoutes } from './webhooks.js';
import type { WebhookRoutesOptions } from './webhooks.js';
import { WebhookStore } from '../../storage/webhook-store.js';
import { WebhookDeliveryStore } from '../../storage/webhook-delivery-store.js';
import { WebhookService } from '../../engine/webhooks/service.js';
import { EventBus } from '../../events/bus.js';

/** Mock-auth: requireAuth пропускает и выставляет пользователя. */
const mockAuth = {
  requireAuth: (async (c: Context, next: Next) => {
    c.set('user' as never, { id: 'u-9' } as never);
    await next();
  }) as MiddlewareHandler,
};

describe('Webhooks API Routes (AD-052, этап II)', () => {
  let tmpDir: string;
  let store: WebhookStore;
  let deliveryStore: WebhookDeliveryStore;
  let service: WebhookService;

  const makeApp = (opts: WebhookRoutesOptions = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/webhooks',
      createWebhookRoutes(mockAuth, { store, deliveryStore, service }, opts),
    );
    return app;
  };

  const postJson = (app: Hono, path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhook-routes-'));
    store = new WebhookStore({ dataDir: tmpDir });
    deliveryStore = new WebhookDeliveryStore({ dataDir: tmpDir });
    service = new WebhookService({
      store,
      deliveryStore,
      eventBus: new EventBus(),
      config: { enabled: true, maxAttempts: 1, timeoutMs: 1_000, allowPrivateTargets: true },
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
  });

  afterEach(async () => {
    service.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET / — пустой список', async () => {
    const res = await makeApp().request('/api/v2/webhooks');
    expect(res.status).toBe(200);
    expect((await res.json() as { subscriptions: unknown[] }).subscriptions).toEqual([]);
  });

  it('POST / — создание (секрет единожды, createdBy из контекста)', async () => {
    const app = makeApp({ isEnabled: () => true });
    const res = await postJson(app, '/api/v2/webhooks', {
      label: 'billing',
      url: 'https://example.com/hook',
      events: ['session.created'],
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; secret: string; secretPrefix: string; createdBy: string };
    expect(created.id).toMatch(/^whk_/);
    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.secretPrefix.endsWith('…')).toBe(true);
    expect(created.createdBy).toBe('u-9');

    // Список без секрета.
    const list = await (await app.request('/api/v2/webhooks')).json() as { subscriptions: Array<Record<string, unknown>> };
    expect(list.subscriptions[0]!.secret).toBeUndefined();
  });

  it('POST / — невалидный URL/паттерн → 400; дубликат label → 409', async () => {
    const app = makeApp({ isEnabled: () => true });
    expect((await postJson(app, '/api/v2/webhooks', { label: 'x', url: 'not-a-url' })).status).toBe(400);
    expect((await postJson(app, '/api/v2/webhooks', { label: 'x', url: 'https://e.com', events: ['bad pattern'] })).status).toBe(400);

    expect((await postJson(app, '/api/v2/webhooks', { label: 'dup', url: 'https://example.com/a' })).status).toBe(201);
    const dup = await postJson(app, '/api/v2/webhooks', { label: ' DUP ', url: 'https://example.com/b' });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('POST / — SSRF: приватный IP / http отклоняются', async () => {
    const app = makeApp({ isEnabled: () => true });
    expect((await postJson(app, '/api/v2/webhooks', { label: 'p', url: 'https://127.0.0.1/hook' })).status).toBe(400);
    expect((await postJson(app, '/api/v2/webhooks', { label: 'h', url: 'http://example.com/hook' })).status).toBe(400);

    // allowPrivateTargets снимает ограничения.
    const dev = makeApp({ isEnabled: () => true, allowPrivateTargets: true });
    expect((await postJson(dev, '/api/v2/webhooks', { label: 'dev', url: 'http://127.0.0.1/hook' })).status).toBe(201);
  });

  it('мастер-выключатель: мутации/тест → 503, чтение — 200', async () => {
    const app = makeApp({ isEnabled: () => false });
    expect((await postJson(app, '/api/v2/webhooks', { label: 'x', url: 'https://example.com' })).status).toBe(503);
    expect((await app.request('/api/v2/webhooks')).status).toBe(200);
    // POST /:id/test при выключенном мастере → 503 (подписка не важна).
    expect((await postJson(app, '/api/v2/webhooks/whk_x/test', {})).status).toBe(503);
  });

  it('GET/PATCH/DELETE/revoke/regenerate — жизненный цикл', async () => {
    const app = makeApp({ isEnabled: () => true });
    const created = await (await postJson(app, '/api/v2/webhooks', { label: 'lc', url: 'https://example.com/lc' })).json() as { id: string; secret: string };

    expect((await app.request(`/api/v2/webhooks/${created.id}`)).status).toBe(200);
    expect((await app.request('/api/v2/webhooks/whk_missing')).status).toBe(404);

    const patched = await app.request(`/api/v2/webhooks/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'updated', events: ['session.*'] }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json() as { description: string }).description).toBe('updated');

    const revoked = await postJson(app, `/api/v2/webhooks/${created.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as { enabled: boolean }).enabled).toBe(false);

    const rotated = await postJson(app, `/api/v2/webhooks/${created.id}/regenerate`, {});
    expect(rotated.status).toBe(200);
    const newSecret = (await rotated.json() as { secret: string }).secret;
    expect(newSecret.startsWith('whsec_')).toBe(true);
    expect(newSecret).not.toBe(created.secret);

    expect((await app.request(`/api/v2/webhooks/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/v2/webhooks/${created.id}`)).status).toBe(404);
  });

  it('POST /:id/test — тестовая доставка; GET /:id/deliveries — журнал', async () => {
    const app = makeApp({ isEnabled: () => true });
    const created = await (await postJson(app, '/api/v2/webhooks', { label: 't', url: 'https://example.com/t' })).json() as { id: string };

    const test = await postJson(app, `/api/v2/webhooks/${created.id}/test`, {});
    expect(test.status).toBe(200);
    const delivery = await test.json() as { status: string; eventType: string; id: string };
    expect(delivery.status).toBe('ok');
    expect(delivery.eventType).toBe('webhook.test');

    const list = await (await app.request(`/api/v2/webhooks/${created.id}/deliveries?limit=10`)).json() as {
      deliveries: Array<{ id: string }>;
    };
    expect(list.deliveries).toHaveLength(1);
    expect(list.deliveries[0]!.id).toBe(delivery.id);

    // Тест несуществующей подписки → 404.
    expect((await postJson(app, '/api/v2/webhooks/whk_missing/test', {})).status).toBe(404);
  });

  it('writeGuard применяется к мутациям, readGuard — к чтению', async () => {
    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const app = makeApp({ isEnabled: () => true, writeGuard: deny, readGuard: mockAuth.requireAuth });
    expect((await postJson(app, '/api/v2/webhooks', { label: 'x', url: 'https://example.com' })).status).toBe(403);
    expect((await app.request('/api/v2/webhooks')).status).toBe(200);
  });
});
