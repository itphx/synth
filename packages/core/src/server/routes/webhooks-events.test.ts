/**
 * Событие шины `webhooks.updated` на HTTP-путях реестра подписок.
 *
 * Баг: «подписка, созданная/изменённая/удалённая в другом клиенте или соседней
 * вкладке админки, видна в разделе только после перезагрузки страницы»: раздел
 * `WebhooksSettings` грузит список один раз при монтировании и перечитывает его
 * только после **своих** мутаций, а сервер о чужих молчал.
 *
 * Контракт проверяется здесь целиком:
 * - `POST /` (`create`), `PATCH /:id` (`update`), `DELETE /:id` (`delete`),
 *   `POST /:id/regenerate` (`regenerate`), `POST /:id/revoke` (`revoke`) и
 *   `POST /:id/test` (`test` — тестовая доставка пишет в подписку видимые
 *   `lastStatus`/`lastDeliveryAt`, поэтому тоже публикует);
 * - **не** публикуется при ошибке: 400 (невалидное тело/URL), 409 (конфликт
 *   метки), 404 (нет подписки), 503 (мастер выключен);
 * - payload — только id подписки и вид мутации: signing-секрет (`whsec_…`),
 *   целевой URL (в нём бывает токен получателя) и прочий конфиг подписки в
 *   событие не попадают ни при каких условиях (инвариант 13 `AGENTS.md`).
 *
 * Хук подменён фейком (`onWebhooksChanged` — тот же хук, что у
 * `webhooksChangedPublisher`): тест про контракт фабрики, а не про EventBus
 * (сам шов — `src/events/webhooks-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createWebhookRoutes } from './webhooks.js';
import { WebhookStore } from '../../storage/webhook-store.js';
import { WebhookDeliveryStore } from '../../storage/webhook-delivery-store.js';
import { WebhookService } from '../../engine/webhooks/service.js';
import { EventBus } from '../../events/bus.js';
import { PRIVATE_EGRESS_POLICY } from '../../engine/net/egress-guard.js';
import { publishWebhooksUpdated } from '../../events/webhooks-events.js';
import type { WebhooksChangedInfo } from '../../events/webhooks-events.js';
import type { HostResolver } from '../../engine/mcp/network-policy.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `webhooksChangedPublisher(eventBus)`. */
function webhooksHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: WebhooksChangedInfo) => publishWebhooksUpdated(bus, info);
}

/** DNS не ходит в сеть — резолвер детерминирован (публичный адрес разрешён). */
const resolvePublicHost: HostResolver = async () => ['93.184.216.34'];

/** Mock-auth: requireAuth пропускает и выставляет пользователя. */
const mockAuth = {
  requireAuth: (async (c: Context, next: Next) => {
    c.set('user' as never, { id: 'u-1' } as never);
    await next();
  }) as MiddlewareHandler,
};

describe('createWebhookRoutes — событие webhooks.updated на write-путях', () => {
  let tmpDir: string;
  let store: WebhookStore;
  let deliveryStore: WebhookDeliveryStore;
  let service: WebhookService;
  let published: PublishedEvent[];

  const makeApp = (opts: { enabled?: boolean } = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/webhooks',
      createWebhookRoutes(mockAuth, { store, deliveryStore, service }, {
        isEnabled: () => opts.enabled ?? true,
        resolvePolicy: async () => PRIVATE_EGRESS_POLICY,
        resolveHost: resolvePublicHost,
        onWebhooksChanged: webhooksHook(published),
      }),
    );
    return app;
  };

  const postJson = (app: Hono, path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Создать подписку «как админ» и вернуть её id. */
  const createSub = async (app: Hono, label = 'billing'): Promise<string> => {
    const res = await postJson(app, '/api/v2/webhooks', {
      label,
      url: 'https://example.com/hook',
      events: ['session.created'],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    return created.id;
  };

  beforeEach(async () => {
    published = [];
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhook-events-'));
    store = new WebhookStore({ dataDir: tmpDir });
    deliveryStore = new WebhookDeliveryStore({ dataDir: tmpDir });
    service = new WebhookService({
      store,
      deliveryStore,
      eventBus: new EventBus(),
      config: {
        enabled: true,
        maxAttempts: 1,
        timeoutMs: 1_000,
        policy: { mode: 'off', list: [], exceptions: [] },
      },
      fetchImpl: async () => new Response(null, { status: 200 }),
      resolveHost: resolvePublicHost,
    });
  });

  afterEach(async () => {
    service.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST / публикует { action: create, subscriptionId } без секрета и URL', async () => {
    const app = makeApp();

    const res = await postJson(app, '/api/v2/webhooks', {
      label: 'billing',
      url: 'https://hooks.example.com/ingest?token=receiver-secret-token',
      events: ['session.created'],
    });

    expect(res.status).toBe(201);
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe('webhooks.updated');
    expect(published[0]!.channel).toBe('instance');
    expect(published[0]!.data).toMatchObject({ action: 'create' });
    expect(typeof published[0]!.data.subscriptionId).toBe('string');

    // Секретов и целевого URL в событии нет.
    const serialized = JSON.stringify(published);
    const created = (await res.json()) as { secret: string };
    expect(serialized).not.toContain(created.secret);
    expect(serialized).not.toContain('whsec_');
    expect(serialized).not.toContain('receiver-secret-token');
    expect(serialized).not.toContain('hooks.example.com');
  });

  it('PATCH /:id публикует { action: update, subscriptionId }', async () => {
    const app = makeApp();
    const id = await createSub(app);
    published.length = 0;

    const res = await app.request(`/api/v2/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'changed', enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'webhooks.updated', data: { action: 'update', subscriptionId: id } },
    ]);
  });

  it('DELETE /:id публикует { action: delete, subscriptionId }', async () => {
    const app = makeApp();
    const id = await createSub(app);
    published.length = 0;

    const res = await app.request(`/api/v2/webhooks/${id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      { channel: 'instance', type: 'webhooks.updated', data: { action: 'delete', subscriptionId: id } },
    ]);
  });

  it('POST /:id/regenerate публикует regenerate (ротация секрета — мутация записи)', async () => {
    const app = makeApp();
    const id = await createSub(app);
    published.length = 0;

    const res = await postJson(app, `/api/v2/webhooks/${id}/regenerate`, {});

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'webhooks.updated',
        data: { action: 'regenerate', subscriptionId: id },
      },
    ]);
    // Новый секрет — только в ответе, не в событии.
    const rotated = (await res.json()) as { secret: string };
    expect(rotated.secret.startsWith('whsec_')).toBe(true);
    expect(JSON.stringify(published)).not.toContain(rotated.secret);
  });

  it('POST /:id/revoke публикует revoke (подписка погашена — видно в списке)', async () => {
    const app = makeApp();
    const id = await createSub(app);
    published.length = 0;

    const res = await postJson(app, `/api/v2/webhooks/${id}/revoke`, {});

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'webhooks.updated', data: { action: 'revoke', subscriptionId: id } },
    ]);
  });

  it('POST /:id/test публикует test (отметка доставки видна в списке)', async () => {
    const app = makeApp();
    const id = await createSub(app);
    published.length = 0;

    const res = await postJson(app, `/api/v2/webhooks/${id}/test`, {});

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'webhooks.updated', data: { action: 'test', subscriptionId: id } },
    ]);
    // Тест действительно обновил видимые поля подписки — иначе сигнала бы не было.
    const sub = await store.get(id);
    expect(sub?.lastStatus).toBe('ok');
    expect(sub?.lastDeliveryAt).toBeTruthy();
  });

  it('ошибки молчат: 400 (тело/URL), 409 (метка), 404 (нет подписки), 503 (мастер выключен)', async () => {
    const app = makeApp();

    // 400 — невалидное тело и незаконный URL.
    expect((await postJson(app, '/api/v2/webhooks', { label: 'x', url: 'not-a-url' })).status).toBe(400);
    expect((await postJson(app, '/api/v2/webhooks', { url: 'https://example.com/h' })).status).toBe(400);
    // 409 — конфликт метки.
    const id = await createSub(app, 'dup');
    published.length = 0;
    expect(
      (await postJson(app, '/api/v2/webhooks', { label: 'DUP', url: 'https://example.com/other' })).status,
    ).toBe(409);
    // 404 — несуществующая подписка на всех путях.
    expect((await app.request('/api/v2/webhooks/whk_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await postJson(app, '/api/v2/webhooks/whk_missing/regenerate', {})).status).toBe(404);
    expect((await postJson(app, '/api/v2/webhooks/whk_missing/revoke', {})).status).toBe(404);
    expect((await postJson(app, '/api/v2/webhooks/whk_missing/test', {})).status).toBe(404);
    expect(
      (
        await app.request('/api/v2/webhooks/whk_missing', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(404);
    expect(published).toEqual([]);

    // 503 — мастер выключатель: мутации не выполняются и молчат.
    const off = makeApp({ enabled: false });
    expect((await postJson(off, '/api/v2/webhooks', { label: 'y', url: 'https://example.com/y' })).status).toBe(503);
    expect((await postJson(off, `/api/v2/webhooks/${id}/revoke`, {})).status).toBe(503);
    expect((await postJson(off, `/api/v2/webhooks/${id}/test`, {})).status).toBe(503);
    expect((await app.request(`/api/v2/webhooks/${id}`, { method: 'DELETE' })).status).toBe(204);
    // Контроль: после ошибок исправная запись событие всё же публикует.
    expect(published.map((e) => e.data.action)).toEqual(['delete']);
  });

  it('пробел в реестре без сервиса доставки: POST /:id/test молчит (404, записи нет)', async () => {
    published = [];
    const app = new Hono();
    app.route(
      '/api/v2/webhooks',
      createWebhookRoutes(
        mockAuth,
        { store, deliveryStore },
        {
          isEnabled: () => true,
          resolvePolicy: async () => PRIVATE_EGRESS_POLICY,
          resolveHost: resolvePublicHost,
          onWebhooksChanged: webhooksHook(published),
        },
      ),
    );
    const id = await createSub(app);
    published.length = 0;

    expect((await postJson(app, `/api/v2/webhooks/${id}/test`, {})).status).toBe(404);
    expect(published).toEqual([]);
  });
});
