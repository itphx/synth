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

function createIngress(decision: RouteDecision, session: Session | null, identityHint?: { code: string; expiresAt: string }): EventIngress {
  const service = {
    handleEvent: vi.fn(async () => ({ decision, session, ...(identityHint ? { identityHint } : {}) })),
  } as unknown as RequestSessionService;
  return new EventIngress({ requestSessionService: service });
}

describe('Events API Routes (ADR-089)', () => {
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

  // --- ADR-089 (claim-flow): identityHint в ответе POST /events ---

  it('POST / — неизвестный отправитель → ответ содержит identityHint', async () => {
    const hint = { code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' };
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null, hint));

    const res = await app.request('/api/v2/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'telegram', type: 'message', identity: { principalId: 'tg:1' } }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.identityHint).toEqual(hint);
    // Контракт не сломан.
    expect(body.event).toBeDefined();
    expect(body.decision).toBeDefined();
    expect(body.sessionId).toBeNull();
    expect(body.session).toBeUndefined();
  });

  it('POST / — известный отправитель → ответ БЕЗ identityHint', async () => {
    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));

    const res = await app.request('/api/v2/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'telegram', type: 'message' }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.identityHint).toBeUndefined();
    expect(body.sessionId).toBe('s1');
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

  // --- ADR-052: scope-гейт записи правил (зонтичный `automation:install`) ---

  /** Приложение с service-key в контексте (scope-гейт срабатывает по нему). */
  function scopedApp(cred: { roles: string[]; scopes: string[] }) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('serviceKey' as never, {
        keyId: 'svk_1',
        label: 'installer',
        roles: cred.roles,
        scopes: cred.scopes,
      } as never);
      await next();
    });
    app.route(
      '/api/v2/events',
      createEventRoutes(
        createMockAuth(),
        { ingress: createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null), bindingStore, apiKeyStore, journal, routeRuleStore },
        {},
      ),
    );
    return app;
  }

  const postRoute = (app: Hono, target: unknown) =>
    app.request('/api/v2/events/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match: { source: 'ci' }, target }),
    });

  it('POST /routes — service-key со scope routes:write → 201', async () => {
    const app = scopedApp({ roles: ['USER'], scopes: ['routes:write'] });
    const res = await postRoute(app, { mode: 'ephemeral', agentTemplate: '' });
    expect(res.status).toBe(201);
  });

  it('POST /routes — service-key со scope automation:install → 201 (зонтичный скоуп)', async () => {
    const app = scopedApp({ roles: ['USER'], scopes: ['automation:install'] });
    const res = await postRoute(app, { mode: 'ephemeral', agentTemplate: '' });
    expect(res.status).toBe(201);
  });

  it('POST /routes — service-key со scope addons:install → 403 SCOPE_REQUIRED (права не расширились)', async () => {
    const app = scopedApp({ roles: ['USER'], scopes: ['addons:install'] });
    const res = await postRoute(app, { mode: 'ephemeral', agentTemplate: '' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('POST /routes — интерактивные креды (без service-key) — no-op: 201', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));
    const res = await postRoute(app, { mode: 'ephemeral', agentTemplate: '' });
    expect(res.status).toBe(201);
  });

  // --- ADR-089: ссылка на шаг пайплайна в цели правила ---

  it('POST /routes — цель с pipeline (ephemeral/bind) принимается и сохраняется', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));

    const ephemeral = await postRoute(app, {
      mode: 'ephemeral',
      agentTemplate: '',
      pipeline: { id: 'pl_1', step: 'publish' },
    });
    expect(ephemeral.status).toBe(201);
    const ephemeralRule = await ephemeral.json() as { target: { pipeline?: { id: string; step: string } } };
    expect(ephemeralRule.target.pipeline).toEqual({ id: 'pl_1', step: 'publish' });

    const bind = await postRoute(app, {
      mode: 'bind',
      agentTemplate: '',
      pipeline: { id: 'pl_1', step: 'publish' },
    });
    expect(bind.status).toBe(201);
    const bindRule = await bind.json() as { target: { pipeline?: { id: string; step: string } } };
    expect(bindRule.target.pipeline).toEqual({ id: 'pl_1', step: 'publish' });
  });

  it('POST /routes — pipeline в bound-цели отвергается (400 VALIDATION_ERROR)', async () => {
    const app = makeApp(createIngress({ kind: 'drop', reason: 'no_route', audited: true }, null));
    const res = await postRoute(app, {
      mode: 'bound',
      sessionId: 's-1',
      pipeline: { id: 'pl_1', step: 'publish' },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
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

  // --- ADR-089/ADR-052: API-ключи привязок и приём события по ключу ---

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
    const missing = await postJson(app, '/api/v2/events/bindings/bnd_missing/keys', { label: 'd' });
    expect(missing.status).toBe(404);

    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const res = await postJson(app, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'bot', description: 'telegram bot' });
    expect(res.status).toBe(201);
    const created: any = await res.json();
    expect(created.id).toMatch(/^eak_/);
    expect(created.bindingId).toBe(binding.id);
    expect(created.label).toBe('bot');
    expect(created.description).toBe('telegram bot');
    expect(created.createdBy).toBe('unknown');
    expect(created.key.startsWith('synth_evt_')).toBe(true);
    expect(created.prefix.endsWith('…')).toBe(true);
    expect(created.hash).toBeUndefined();
  });

  it('POST /bindings/:id/keys — обязательный label → 400', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const app = keyApp({});
    const res = await postJson(app, `/api/v2/events/bindings/${binding.id}/keys`, { description: 'no-label' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /bindings/:id/keys — дубликат label (глобально) → 409 CONFLICT', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const app = keyApp({});
    const first = await postJson(app, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'shared' });
    expect(first.status).toBe(201);
    const dup = await postJson(app, `/api/v2/events/bindings/${binding.id}/keys`, { label: ' SHARED ' });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('PATCH /bindings/:id/keys/:keyId — обновление, 404, конфликт метки', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const a = await apiKeyStore.create({ bindingId: binding.id, label: 'alpha', createdBy: 'u-1' });
    await apiKeyStore.create({ bindingId: binding.id, label: 'beta', createdBy: 'u-1' });
    const app = keyApp({});

    const patch = (keyId: string, body: unknown) => app.request(
      `/api/v2/events/bindings/${binding.id}/keys/${keyId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );

    const ok = await patch(a.id, { description: 'new', rateLimitPerMinute: 5 });
    expect(ok.status).toBe(200);
    const updated = await ok.json() as { label: string; description?: string; rateLimitPerMinute?: number };
    expect(updated.label).toBe('alpha');
    expect(updated.description).toBe('new');
    expect(updated.rateLimitPerMinute).toBe(5);

    expect((await patch('eak_missing', { label: 'x' })).status).toBe(404);

    const conflict = await patch(a.id, { label: 'BETA' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe('CONFLICT');

    const invalid = await patch(a.id, { rateLimitPerMinute: -1 });
    expect(invalid.status).toBe(400);
  });

  it('POST /bindings/:id/keys/:keyId/revoke — 200 и 404', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'bot', createdBy: 'u-1' });
    const app = keyApp({});

    const revoke = await app.request(
      `/api/v2/events/bindings/${binding.id}/keys/${created.id}/revoke`,
      { method: 'POST' },
    );
    expect(revoke.status).toBe(200);
    const body: any = await revoke.json();
    expect(body.id).toBe(created.id);
    expect(typeof body.revokedAt).toBe('string');
    expect(await apiKeyStore.resolveBySecret(created.key)).toBeNull();

    const missing = await app.request(
      `/api/v2/events/bindings/${binding.id}/keys/eak_missing/revoke`,
      { method: 'POST' },
    );
    expect(missing.status).toBe(404);
  });

  it('POST / — per-key rate limit (у ключа) → 429 после превышения', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'limited', rateLimitPerMinute: 2, createdBy: 'u-1' });

    const { ingress } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
    }, ingress);

    const post = () => postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: `Bearer ${created.key}` });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('POST / — per-key rate limit из глобального дефолта (getKeyRateLimitPerMinute)', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'default-limited', createdBy: 'u-1' });

    const { ingress } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({
      getKeyRateLimitPerMinute: () => 1,
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
    }, ingress);

    const post = () => postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: `Bearer ${created.key}` });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  });

  it('POST / — без лимита (0 / не задан) запросы не ограничиваются', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'unlimited', rateLimitPerMinute: 0, createdBy: 'u-1' });

    const { ingress } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({
      getKeyRateLimitPerMinute: () => 0,
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
    }, ingress);

    for (let i = 0; i < 5; i += 1) {
      expect((await postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: `Bearer ${created.key}` })).status).toBe(201);
    }
  });

  it('POST / — isEnabled:false → 503 UNAVAILABLE (до аутентификации)', async () => {
    const app = keyApp({ isEnabled: () => false });
    const res = await postJson(app, '/api/v2/events', { source: 'telegram', type: 'message' });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAVAILABLE');

    const enabled = keyApp({ isEnabled: () => true });
    expect((await postJson(enabled, '/api/v2/events', { source: 'telegram', type: 'message' })).status).toBe(201);
  });

  it('GET /keys — метаданные без секрета и hash; DELETE 204/404', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'u-1' });
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
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'u-1' });

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
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'u-1' });

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
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'u-1' });

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

  // --- ADR-089/ADR-052: обычный пользовательский Bearer vs binding-key ---

  it('POST / — обычный Bearer (без префикса synth_evt_) идёт на fallback ingestGuard', async () => {
    const resolveApiKeySecret = vi.fn(async () => null);
    const { ingress, handleEvent } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({ resolveApiKeySecret }, ingress);

    // `createMockAuth().requireAuth` пропускает — fallback проходит → 201.
    const res = await postJson(app, '/api/v2/events', { source: 'telegram', type: 'message' }, { Authorization: 'Bearer admin-key-123' });
    expect(res.status).toBe(201);
    // Обычный ключ не пытались резолвить как binding-key.
    expect(resolveApiKeySecret).not.toHaveBeenCalled();
    expect(handleEvent).toHaveBeenCalledOnce();
  });

  it('POST / — обычный Bearer, ingestGuard не пропустил → 401 (fallback, не binding-ветка)', async () => {
    const resolveApiKeySecret = vi.fn(async () => null);
    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    const { ingress } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({ resolveApiKeySecret, ingestGuard: deny }, ingress);

    const res = await postJson(app, '/api/v2/events', { source: 'telegram', type: 'message' }, { Authorization: 'Bearer user-key-456' });
    expect(res.status).toBe(401);
    expect(resolveApiKeySecret).not.toHaveBeenCalled();
  });

  it('POST / — Bearer synth_evt_ не резолвится → 401 (fallback не задействован)', async () => {
    const resolveApiKeySecret = vi.fn(async () => null);
    const ingestGuard: MiddlewareHandler = vi.fn(async (_c: Context, next: Next) => { await next(); });
    const { ingress } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({ resolveApiKeySecret, ingestGuard }, ingress);

    const res = await postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: 'Bearer synth_evt_unknown' });
    expect(res.status).toBe(401);
    expect(resolveApiKeySecret).toHaveBeenCalledOnce();
    // При валидном префиксе fallback не должен вызываться.
    expect(ingestGuard).not.toHaveBeenCalled();
  });

  it('POST / — без Bearer идёт на fallback ingestGuard, резолвер не вызывается', async () => {
    const resolveApiKeySecret = vi.fn(async () => null);
    const { ingress, handleEvent } = capturingIngress({ kind: 'drop', reason: 'no_route', audited: true }, null);
    const app = keyApp({ resolveApiKeySecret }, ingress);

    const res = await postJson(app, '/api/v2/events', { source: 'telegram', type: 'message' });
    expect(res.status).toBe(201);
    expect(resolveApiKeySecret).not.toHaveBeenCalled();
    expect(handleEvent).toHaveBeenCalledOnce();
  });

  it('GET /keys: keyReadGuard ограничивает чтение (default — requireAuth)', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:12', mode: 'bound', sessionId: 's1' });
    await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'u-1' });

    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
    const guarded = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session), { keyReadGuard: deny });
    expect((await guarded.request(`/api/v2/events/bindings/${binding.id}/keys`)).status).toBe(403);

    // Без keyReadGuard — requireAuth (mock пропускает) → 200.
    const open = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));
    expect((await open.request(`/api/v2/events/bindings/${binding.id}/keys`)).status).toBe(200);
  });

  it('DELETE /bindings/:id каскадно удаляет ключи', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's1' });
    await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'u-1' });
    expect(await apiKeyStore.listByBinding(binding.id)).toHaveLength(1);

    const app = makeApp(createIngress({ kind: 'bound', sessionId: 's1' }, { id: 's1' } as Session));
    expect((await app.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await apiKeyStore.listByBinding(binding.id)).toHaveLength(0);
  });

  // --- ADR-089: атрибуция владельца создаваемых funnel'ом сессий ---

  it('POST / по ключу: владелец сессии = создатель ключа привязки (ADR-089)', async () => {
    const binding = await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:21', mode: 'bound', sessionId: 's-bound' });
    const created = await apiKeyStore.create({ bindingId: binding.id, label: 'd', createdBy: 'creator-7' });

    const { ingress, handleEvent } = capturingIngress({ kind: 'bind', agentTemplate: '' }, { id: 's-bound' } as Session);
    const app = keyApp({
      resolveApiKeySecret: async (raw) => {
        const r = await apiKeyStore.resolveBySecret(raw);
        if (!r) return null;
        const b = await bindingStore.get(r.credential.bindingId);
        return b ? { binding: b, credential: r.credential } : null;
      },
    }, ingress);

    await postJson(app, '/api/v2/events', { type: 'message' }, { Authorization: `Bearer ${created.key}` });

    const call = handleEvent.mock.calls[0]! as unknown as [any, { ownerId?: string }];
    expect(call[1].ownerId).toBe('creator-7');
  });

  it('POST / без ключа: владелец сессии = аутентифицированный пользователь (ADR-089)', async () => {
    const authWithUser = {
      getCurrentUser: () => ({ id: 'u-9' }),
      requireAuth: async (c: Context, next: Next) => {
        c.set('user', { id: 'u-9' });
        await next();
      },
    } as unknown as AuthKit;
    const { ingress, handleEvent } = capturingIngress({ kind: 'ephemeral', agentTemplate: '', ttl: '1h' }, null);
    const app = new Hono();
    app.route(
      '/api/v2/events',
      createEventRoutes(authWithUser, { ingress, bindingStore, apiKeyStore, journal, routeRuleStore }, {}),
    );

    const res = await postJson(app, '/api/v2/events', { source: 'telegram', type: 'message' });
    expect(res.status).toBe(201);

    const call = handleEvent.mock.calls[0]! as unknown as [any, { ownerId?: string }];
    expect(call[1].ownerId).toBe('u-9');
  });
});
