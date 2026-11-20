/**
 * Событие шины `events.updated` на HTTP-путях реестра приёма внешних событий.
 *
 * Баг: «привязка, её API-ключ или правило маршрутизации, созданные/изменённые/
 * удалённые в другом клиенте или соседней вкладке админки, видны в разделе
 * "События" только после перезагрузки страницы»: раздел
 * (`EventsAdminSettings`) грузит список привязок один раз, секция правил
 * (`EventRoutesSection`) — свой список, а карточка привязки
 * (`EventBindingKeys`) — метаданные ключей; перечитываются они только после
 * **своих** мутаций, а сервер о чужих молчал — отозванный ключ продолжал
 * выглядеть активным.
 *
 * Контракт проверяется целиком:
 * - привязки: `POST /bindings` (upsert → `binding.create`/`binding.update`),
 *   `DELETE /bindings/:id` → `binding.delete`;
 * - ключи: `POST /bindings/:id/keys` → `key.create`,
 *   `PATCH /bindings/:id/keys/:keyId` → `key.update`,
 *   `POST /bindings/:id/keys/:keyId/revoke` → `key.revoke`,
 *   `DELETE /bindings/:id/keys/:keyId` → `key.delete`;
 * - правила: `POST /routes` (upsert → `route.create`/`route.update`),
 *   `DELETE /routes/:id` → `route.delete`;
 * - **не** публикуется при ошибке: 400 (битое тело, неизвестный агент),
 *   404 (нет привязки/ключа/правила), 403 (write-guard);
 * - payload — только вид мутации и id привязки/правила: **секрета ключа
 *   (`synth_evt_…`), его хеша и id ключа в событии нет** (инвариант 13).
 *
 * Хук подменён фейком (`onEventsChanged` — тот же хук, что у
 * `eventsChangedPublisher`): тест про контракт фабрики, а не про EventBus
 * (сам шов — `src/events/events-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBinding } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import { createEventRoutes } from './events.js';
import type { EventRoutesOptions } from './events.js';
import { EventIngress } from '../../engine/events/ingest.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventApiKeyStore } from '../../storage/event-api-key-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { RouteRuleStore } from '../../storage/route-rule-store.js';
import { publishEventsUpdated } from '../../events/events-events.js';
import type { EventsChangedInfo } from '../../events/events-events.js';

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

/** Тот же путь публикации, что у точки сборки: `eventsChangedPublisher(eventBus)`. */
function eventsHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: EventsChangedInfo) => publishEventsUpdated(bus, info);
}

const passAuth: MiddlewareHandler = async (_c, next) => {
  await next();
};

/** Auth-контракт фабрики: реализован только `requireAuth` (как в прод-вызове). */
const auth = { requireAuth: passAuth } as unknown as AuthKit;

/** Инвариант: приём событий в этих тестах не нужен — заглушка без `handleEvent`. */
function stubIngress(): EventIngress {
  return { ingest: async () => { throw new Error('ingest не используется'); } } as unknown as EventIngress;
}

describe('createEventRoutes — событие events.updated на write-путях', () => {
  let tmpDir: string;
  let bindingStore: EventBindingStore;
  let apiKeyStore: EventApiKeyStore;
  let journal: EventJournalStore;
  let routeRuleStore: RouteRuleStore;
  let published: PublishedEvent[];

  const makeApp = (opts: EventRoutesOptions = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/events',
      createEventRoutes(
        auth,
        { ingress: stubIngress(), bindingStore, apiKeyStore, journal, routeRuleStore },
        { onEventsChanged: eventsHook(published), ...opts },
      ),
    );
    return app;
  };

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** Привязка через API (событие создания не интересует — его сбрасываем). */
  const createBinding = async (app: Hono, body: Record<string, unknown> = {}): Promise<EventBinding> => {
    const res = await app.request('/api/v2/events/bindings', {
      ...json({ source: 'telegram', mode: 'bound', ...body }),
      method: 'POST',
    });
    expect(res.status).toBeLessThan(300);
    const binding = (await res.json()) as EventBinding;
    published.length = 0;
    return binding;
  };

  const createKey = async (app: Hono, bindingId: string) => {
    const res = await app.request(
      `/api/v2/events/bindings/${bindingId}/keys`,
      json({ label: 'ci-key' }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key?: string; hash?: string };
    published.length = 0;
    return created;
  };

  beforeEach(async () => {
    published = [];
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-events-events-'));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
    apiKeyStore = new EventApiKeyStore({ dataDir: tmpDir });
    journal = new EventJournalStore({ dataDir: tmpDir });
    routeRuleStore = new RouteRuleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Привязки ─────────────────────────────────────────────────────────────
  it('POST /bindings — создание публикует { action: binding.create, bindingId }', async () => {
    const app = makeApp();

    const res = await app.request('/api/v2/events/bindings', json({ source: 'telegram', mode: 'bound' }));

    expect(res.status).toBe(201);
    const binding = (await res.json()) as EventBinding;
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'binding.create', bindingId: binding.id },
      },
    ]);
  });

  it('POST /bindings — upsert существующей (source+chatKey) публикует binding.update', async () => {
    const app = makeApp();
    const first = await createBinding(app, { chatKey: 'chat-1' });

    const res = await app.request(
      '/api/v2/events/bindings',
      json({ source: 'telegram', chatKey: 'chat-1', mode: 'ephemeral' }),
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as EventBinding;
    // id сохраняется — значит это правка видимой записи, а не новая карточка.
    expect(updated.id).toBe(first.id);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'binding.update', bindingId: first.id },
      },
    ]);
  });

  it('DELETE /bindings/:id публикует { action: binding.delete, bindingId }', async () => {
    const app = makeApp();
    const binding = await createBinding(app);

    const res = await app.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'binding.delete', bindingId: binding.id },
      },
    ]);
  });

  // ── API-ключи привязки ───────────────────────────────────────────────────
  it('POST /bindings/:id/keys публикует key.create без секрета, хеша и id ключа', async () => {
    const app = makeApp();
    const binding = await createBinding(app);

    const res = await app.request(
      `/api/v2/events/bindings/${binding.id}/keys`,
      json({ label: 'ci-key' }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key?: string };
    // Секрет и хеш в ответе есть (показ единожды) — но в событие не попадают.
    expect(typeof created.key).toBe('string');
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'key.create', bindingId: binding.id },
      },
    ]);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain(created.key!);
    expect(serialized).not.toContain(created.id);
    expect(serialized).not.toContain('ci-key');
    expect(serialized).not.toContain('hash');
    expect(serialized).not.toContain('synth_evt_');
  });

  it('PATCH /bindings/:id/keys/:keyId публикует key.update', async () => {
    const app = makeApp();
    const binding = await createBinding(app);
    const key = await createKey(app, binding.id);

    const res = await app.request(`/api/v2/events/bindings/${binding.id}/keys/${key.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'renamed' }),
    });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'key.update', bindingId: binding.id },
      },
    ]);
    expect(JSON.stringify(published)).not.toContain('renamed');
  });

  it('POST /bindings/:id/keys/:keyId/revoke публикует key.revoke (статус виден в списке)', async () => {
    const app = makeApp();
    const binding = await createBinding(app);
    const key = await createKey(app, binding.id);

    const res = await app.request(
      `/api/v2/events/bindings/${binding.id}/keys/${key.id}/revoke`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'key.revoke', bindingId: binding.id },
      },
    ]);
  });

  it('DELETE /bindings/:id/keys/:keyId публикует key.delete', async () => {
    const app = makeApp();
    const binding = await createBinding(app);
    const key = await createKey(app, binding.id);

    const res = await app.request(`/api/v2/events/bindings/${binding.id}/keys/${key.id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'key.delete', bindingId: binding.id },
      },
    ]);
  });

  // ── Правила маршрутизации ────────────────────────────────────────────────
  const ruleBody = (extra: Record<string, unknown> = {}) => ({
    priority: 1,
    enabled: true,
    match: { source: 'telegram' },
    target: { mode: 'bound', sessionId: 's1' },
    ...extra,
  });

  it('POST /routes — создание публикует { action: route.create, routeId }', async () => {
    const app = makeApp();

    const res = await app.request('/api/v2/events/routes', json(ruleBody()));

    expect(res.status).toBe(201);
    const rule = (await res.json()) as { id: string };
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'route.create', routeId: rule.id },
      },
    ]);
  });

  it('POST /routes с id — upsert публикует route.update (в т.ч. тумблер enabled)', async () => {
    const app = makeApp();
    const created = (await (
      await app.request('/api/v2/events/routes', json(ruleBody()))
    ).json()) as { id: string };
    published.length = 0;

    const res = await app.request(
      '/api/v2/events/routes',
      json(ruleBody({ id: created.id, enabled: false })),
    );

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'route.update', routeId: created.id },
      },
    ]);
  });

  it('DELETE /routes/:id публикует { action: route.delete, routeId }', async () => {
    const app = makeApp();
    const created = (await (
      await app.request('/api/v2/events/routes', json(ruleBody()))
    ).json()) as { id: string };
    published.length = 0;

    const res = await app.request(`/api/v2/events/routes/${created.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'events.updated',
        data: { action: 'route.delete', routeId: created.id },
      },
    ]);
  });

  // ── Молчание на ошибках ──────────────────────────────────────────────────
  it('ошибки молчат: 400 (тело/неизвестный агент), 404 (нет записи), 403 (guard)', async () => {
    const app = makeApp({ resolveAgentTemplate: () => null });
    const binding = await createBinding(app);
    const key = await createKey(app, binding.id);

    // 400 — битые тела.
    expect((await app.request('/api/v2/events/bindings', json({ mode: 'bound' }))).status).toBe(400);
    expect((await app.request('/api/v2/events/bindings', json({ source: 'tg' }))).status).toBe(400);
    expect((await app.request('/api/v2/events/routes', json({ match: {} }))).status).toBe(400);
    expect(
      (await app.request('/api/v2/events/bindings/' + binding.id + '/keys', json({}))).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/api/v2/events/bindings/${binding.id}/keys/${key.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: '' }),
        })
      ).status,
    ).toBe(400);
    // 400 — неизвестный шаблон агента в ephemeral-цели.
    expect(
      (
        await app.request(
          '/api/v2/events/routes',
          json({ match: {}, target: { mode: 'ephemeral', agentTemplate: 'nope' } }),
        )
      ).status,
    ).toBe(400);
    // 404 — записи нет.
    expect((await app.request('/api/v2/events/bindings/nope', { method: 'DELETE' })).status).toBe(404);
    expect(
      (await app.request('/api/v2/events/bindings/nope/keys', json({ label: 'x' }))).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/v2/events/bindings/${binding.id}/keys/nope`, { method: 'DELETE' }))
        .status,
    ).toBe(404);
    expect(
      (await app.request('/api/v2/events/routes/nope', { method: 'DELETE' })).status,
    ).toBe(404);
    expect(published).toEqual([]);

    // 403 — write-guard (в managed это ADMIN/LEAD): записи нет, события нет.
    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const guarded = makeApp({ writeGuard: deny });
    expect((await guarded.request('/api/v2/events/bindings', json({ source: 'tg', mode: 'bound' }))).status)
      .toBe(403);
    expect((await guarded.request('/api/v2/events/routes', json(ruleBody()))).status).toBe(403);
    expect((await guarded.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' })).status)
      .toBe(403);
    expect(published).toEqual([]);

    // Контроль: после ошибок исправная запись событие всё же публикует.
    expect((await app.request('/api/v2/events/routes', json(ruleBody()))).status).toBe(201);
    expect(published.map((e) => e.data.action)).toEqual(['route.create']);
  });

  it('каждый запрос — ровно одно событие', async () => {
    const app = makeApp();
    const binding = await createBinding(app);

    await app.request(`/api/v2/events/bindings/${binding.id}/keys`, json({ label: 'a' }));
    const rule = (await (
      await app.request('/api/v2/events/routes', json(ruleBody()))
    ).json()) as { id: string };

    expect(published).toHaveLength(2);
    expect(published.every((e) => e.channel === 'instance')).toBe(true);
    expect(published.every((e) => e.type === 'events.updated')).toBe(true);
    expect(published.map((e) => e.data.action)).toEqual(['key.create', 'route.create']);
    expect(published[1]!.data.routeId).toBe(rule.id);
  });

  it('без хука (onEventsChanged не передан) фабрика работает как раньше', async () => {
    const app = new Hono();
    app.route(
      '/api/v2/events',
      createEventRoutes(
        auth,
        { ingress: stubIngress(), bindingStore, apiKeyStore, journal, routeRuleStore },
        {},
      ),
    );

    const res = await app.request('/api/v2/events/bindings', json({ source: 'telegram', mode: 'bound' }));

    expect(res.status).toBe(201);
    expect(published).toEqual([]);
  });
});
