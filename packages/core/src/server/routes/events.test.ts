import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { RouteDecision, Session } from '@itphx/synth-shared';
import { createEventRoutes } from './events.js';
import type { EventRoutesOptions } from './events.js';
import { EventIngress } from '../../engine/events/ingest.js';
import type { RequestSessionService } from '../../engine/events/request-session.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventApiKeyStore } from '../../storage/event-api-key-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { RouteRuleStore } from '../../storage/route-rule-store.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createIngress(decision: RouteDecision, session: Session | null): EventIngress {
  const service = {
    handleEvent: vi.fn(async () => ({ decision, session })),
  } as unknown as RequestSessionService;
  return new EventIngress({ requestSessionService: service });
}

describe('Events API Routes (AD-089)', () => {
  let tmpDir: string;
  let bindingStore: EventBindingStore;
  let apiKeyStore: EventApiKeyStore;
  let journal: EventJournalStore;
  let routeRuleStore: RouteRuleStore;

  const makeApp = (ingress: EventIngress, opts: EventRoutesOptions = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/events',
      createEventRoutes(createMockAuth(), { ingress, bindingStore, apiKeyStore, journal, routeRuleStore }, opts),
    );
    return app;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-event-routes-'));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
    apiKeyStore = new EventApiKeyStore({ dataDir: tmpDir });
    journal = new EventJournalStore({ dataDir: tmpDir });
    routeRuleStore = new RouteRuleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST / — валидное событие → 201 { event, decision, sessionId }', async () => {
    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));

    const res = await app.request('/api/v2/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'telegram', type: 'message', payload: { text: 'hi' } }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.event.id.startsWith('evt_')).toBe(true);
    expect(body.event.source).toBe('telegram');
    expect(body.decision).toEqual({ kind: 'bound', sessionId: 's1' });
    expect(body.sessionId).toBe('s1');
    // Внутренние поля сессии не утекают.
    expect(body.session).toBeUndefined();
  });

  it('POST / — drop без сессии → sessionId null', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const res = await app.request('/api/v2/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'webhook', type: 'callback' }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.sessionId).toBeNull();
  });

  it('POST / — невалидное тело → 400 VALIDATION_ERROR', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const res = await app.request('/api/v2/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message' }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST / — не-JSON тело → 400 VALIDATION_ERROR', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const res = await app.request('/api/v2/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
  });

  it('GET /bindings — список', async () => {
    await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));

    const res = await app.request('/api/v2/events/bindings');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0].source).toBe('telegram');
  });

  it('POST /bindings — upsert: 201 при создании, 200 при обновлении', async () => {
    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));
    const payload = { source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' };

    const first = await app.request('/api/v2/events/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const created: any = await first.json();
    expect(created.id.startsWith('bnd_')).toBe(true);

    const second = await app.request('/api/v2/events/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, sessionId: 's2' }),
    });
    expect(second.status).toBe(200);
    const updated: any = await second.json();
    expect(updated.id).toBe(created.id);
    expect(updated.sessionId).toBe('s2');

    const list = await (await app.request('/api/v2/events/bindings')).json() as any;
    expect(list.bindings).toHaveLength(1);
  });

  it('POST /bindings — невалидный mode → 400 VALIDATION_ERROR', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const res = await app.request('/api/v2/events/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'telegram', mode: 'drop' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE /bindings/:id — 204 затем 404', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));

    const removed = await app.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);

    const again = await app.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    const body: any = await again.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /routes — пустой список и после создания', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const empty = await app.request('/api/v2/events/routes');
    expect(empty.status).toBe(200);
    expect((await empty.json() as { rules: unknown[] }).rules).toEqual([]);

    await routeRuleStore.upsert({
      priority: 0,
      enabled: true,
      match: { source: 'ci' },
      target: { mode: 'ephemeral' },
    });

    const list = await app.request('/api/v2/events/routes');
    const body = await list.json() as { rules: Array<{ id: string; match: { source?: string } }> };
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.match.source).toBe('ci');
  });

  it('POST /routes — создание 201, upsert по id 200', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));
    const payload = { match: { source: 'ci' }, target: { mode: 'ephemeral', agentTemplate: '' } };

    const created = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(201);
    const rule = await created.json() as { id: string; priority: number; enabled: boolean };
    expect(rule.id.startsWith('rule_')).toBe(true);
    // Дефолты схемы применяются.
    expect(rule.priority).toBe(0);
    expect(rule.enabled).toBe(true);

    const updated = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, id: rule.id, priority: 5, name: 'rules-2' }),
    });
    expect(updated.status).toBe(200);
    const updatedRule = await updated.json() as { id: string; priority: number; name?: string };
    expect(updatedRule.id).toBe(rule.id);
    expect(updatedRule.priority).toBe(5);
    expect(updatedRule.name).toBe('rules-2');
    // Список по-прежнему содержит одну запись — upsert, не дубль.
    expect((await (await app.request('/api/v2/events/routes')).json() as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it('POST /routes — невалидное тело → 400 VALIDATION_ERROR', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));
    const res = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match: { source: 'ci' }, target: { mode: 'bogus' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /routes — bound с несуществующей сессией → 400', async () => {
    const app = makeApp(
      createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null),
      { sessionExists: async () => false },
    );
    const res = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match: { source: 'ci' }, target: { mode: 'bound', sessionId: 's-missing' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /routes — bound с существующей сессией → 201', async () => {
    const app = makeApp(
      createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null),
      { sessionExists: async (id) => id === 's-1' },
    );
    const res = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match: { type: 'ci_event' }, target: { mode: 'bound', sessionId: 's-1' } }),
    });
    expect(res.status).toBe(201);
  });

  it('POST /routes — неизвестный agentTemplate → 400 unknownAgent', async () => {
    const app = makeApp(
      createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null),
      { resolveAgentTemplate: (t) => (t === 'assistant' ? 'assistant' : null) },
    );
    const res = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        match: { source: 'ci' },
        target: { mode: 'ephemeral', agentTemplate: 'ghost' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message?: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // Известный агент — 201.
    const ok = await app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        match: { source: 'ci' },
        target: { mode: 'ephemeral', agentTemplate: 'assistant' },
      }),
    });
    expect(ok.status).toBe(201);
  });

  it('DELETE /routes/:id — 204 затем 404 ruleNotFound', async () => {
    const created = await routeRuleStore.upsert({
      priority: 0,
      enabled: true,
      match: { source: 'ci' },
      target: { mode: 'ephemeral' },
    });
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const removed = await app.request(`/api/v2/events/routes/${created.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(await routeRuleStore.get(created.id)).toBeNull();

    const again = await app.request(`/api/v2/events/routes/${created.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect((await again.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('GET /journal — записи и лимит', async () => {
    for (let i = 0; i < 3; i += 1) {
      await journal.record({
        ts: new Date(Date.now() + i).toISOString(),
        event: { id: `evt_${i}`, source: 'ci', type: 'ci_event', payload: {}, identity: {}, dedupKey: `k${i}`, ts: new Date().toISOString() },
        decision: { kind: 'drop', reason: 'no_route', audited: true },
      });
    }
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const all = await app.request('/api/v2/events/journal');
    expect(all.status).toBe(200);
    const allBody: any = await all.json();
    expect(allBody.entries).toHaveLength(3);

    const limited = await app.request('/api/v2/events/journal?limit=2');
    const limitedBody: any = await limited.json();
    expect(limitedBody.entries).toHaveLength(2);
    expect(limitedBody.entries[1].event.id).toBe('evt_2');
  });

  // --- AD-089/AD-052: API-ключи привязок и приём события по ключу ---

  /** Ingress с захватом аргументов `handleEvent` (для проверки forced binding). */
  function capturingIngress(decision: RouteDecision, session: Session | null) {
    const handleEvent = vi.fn(async () => ({ decision, session }));
    const service = { handleEvent } as unknown as RequestSessionService;
    return { ingress: new EventIngress({ requestSessionService: service }), handleEvent };
  }

  function keyApp(
    opts: EventRoutesOptions,
    ingress: EventIngress = createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session),
  ) {
    return makeApp(ingress, opts);
  }

  function postJson(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('POST /bindings/:id/keys — 404 без привязки, 201 с ключом (секрет единожды, без hash)', async () => {
    const app = keyApp({});
    const missing = await postJson(app, '/api/v2/events/bindings/bnd_missing/keys', { description: 'd' });
    expect(missing.status).toBe(404);

    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const res = await postJson(app, `/api/v2/events/bindings/${binding.id}/keys`, { name: 'bot', description: 'telegram bot' });
    expect(res.status).toBe(201);
    const created: any = await res.json();
    expect(created.id).toMatch(/^eak_/);
    expect(created.bindingId).toBe(binding.id);
    expect(created.description).toBe('telegram bot');
    expect(created.createdBy).toBe('unknown');
    expect(created.key.startsWith('synth_evt_')).toBe(true);
    expect(created.prefix.endsWith('…')).toBe(true);
    expect(created.hash).toBeUndefined();
  });

  it('POST /bindings/:id/keys — обязательное description → 400', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const app = keyApp({});
    const res = await postJson(app, `/api/v2/events/bindings/${binding.id}/keys`, { name: 'no-desc' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /keys — метаданные без секрета и hash; DELETE 204/404', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    await apiKeyStore.create({ bindingId: binding.id, description: 'd', createdBy: 'u-1' });
    const app = keyApp({});

    const list = await app.request(`/api/v2/events/bindings/${binding.id}/keys`);
    expect(list.status).toBe(200);
    const keys = (await list.json() as { keys: any[] }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBeUndefined();
    expect(keys[0].hash).toBeUndefined();
    expect(keys[0].createdBy).toBe('u-1');

    const keyId = keys[0].id as string;
    expect((await app.request(`/api/v2/events/bindings/${binding.id}/keys/${keyId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/v2/events/bindings/${binding.id}/keys/${keyId}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('POST / по ключу привязки: source из привязки, forced binding, 201', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:9', mode: 'bound', sessionId: 's-bound' });
    const created = await apiKeyStore.create({ bindingId: binding.id, description: 'd', createdBy: 'u-1' });

    const { ingress, handleEvent } = capturingIngress({ kind: 'bound', sessionId: 's-bound' }, { id: 's-bound' } as Session);
    const app = keyApp({
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
      touchApiKey: (id) => apiKeyStore.touch(id),
    }, ingress);

    const res = await postJson(app, '/api/v2/events', { type: 'message', payload: { text: 'hi' } }, { Authorization: `Bearer ${created.key}` });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.event.source).toBe('telegram');
    expect(body.event.identity.chatKey).toBe('chat:telegram:9');
    expect(body.sessionId).toBe('s-bound');

    expect(handleEvent).toHaveBeenCalledOnce();
    const call = handleEvent.mock.calls[0]! as unknown as [any, { binding?: { id: string } }];
    expect(call[0].source).toBe('telegram');
    expect(call[1].binding?.id).toBe(binding.id);

    // lastUsedAt проставлен best-effort отметкой touch.
    const list = await (await app.request(`/api/v2/events/bindings/${binding.id}/keys`)).json() as { keys: any[] };
    expect(typeof list.keys[0].lastUsedAt).toBe('string');
  });

  it('POST / по ключу: source противоречит привязке → 400; неверный ключ → 401', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:9', mode: 'bound', sessionId: 's-bound' });
    const created = await apiKeyStore.create({ bindingId: binding.id, description: 'd', createdBy: 'u-1' });

    const { ingress } = capturingIngress({ kind: 'bound', sessionId: 's-bound' }, { id: 's-bound' } as Session);
    const app = keyApp({
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
    }, ingress);

    const mismatch = await postJson(app, '/api/v2/events', { source: 'other', type: 'message' }, { Authorization: `Bearer ${created.key}` });
    expect(mismatch.status).toBe(400);

    const bad = await postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: 'Bearer synth_evt_nope' });
    expect(bad.status).toBe(401);
  });

  it('POST / по ключу: в funnel прокидывается audit { keyId }', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:11', mode: 'bound', sessionId: 's-bound' });
    const created = await apiKeyStore.create({ bindingId: binding.id, description: 'd', createdBy: 'u-1' });

    const { ingress, handleEvent } = capturingIngress({ kind: 'bound', sessionId: 's-bound' }, { id: 's-bound' } as Session);
    const app = keyApp({
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
    }, ingress);

    await postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: `Bearer ${created.key}` });
    const call = handleEvent.mock.calls[0]! as unknown as [any, { audit?: { keyId?: string; principalId?: string } }];
    expect(call[1].audit?.keyId).toBe(created.id);
    expect(call[1].audit?.principalId).toBeUndefined();
  });

  it('POST / без ключа: audit не передаётся (обратная совместимость)', async () => {
    const { ingress, handleEvent } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({}, ingress);

    await postJson(app, '/api/v2/events', { source: 'telegram', type: 'message' });
    const call = handleEvent.mock.calls[0]! as unknown as [any, { audit?: unknown }];
    expect(call[1].audit).toBeUndefined();
  });

  it('GET /keys: keyReadGuard ограничивает чтение (default — requireAuth)', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:12', mode: 'bound', sessionId: 's1' });
    await apiKeyStore.create({ bindingId: binding.id, description: 'd', createdBy: 'u-1' });

    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
    const guarded = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session), { keyReadGuard: deny });
    expect((await guarded.request(`/api/v2/events/bindings/${binding.id}/keys`)).status).toBe(403);

    // Без keyReadGuard — requireAuth (mock пропускает) → 200.
    const open = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));
    expect((await open.request(`/api/v2/events/bindings/${binding.id}/keys`)).status).toBe(200);
  });

  it('DELETE /bindings/:id каскадно удаляет ключи', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    await apiKeyStore.create({ bindingId: binding.id, description: 'd', createdBy: 'u-1' });
    expect(await apiKeyStore.listByBinding(binding.id)).toHaveLength(1);

    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));
    expect((await app.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await apiKeyStore.listByBinding(binding.id)).toHaveLength(0);
  });
});
