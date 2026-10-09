import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { RouteDecision, Session } from '@itphx/synth-shared';
import { createEventRoutes } from './events.js';
import type { EventRoutesOptions } from './events.js';
import { EventIngress } from '../../engine/events/ingest.js';
import type { RequestSessionService } from '../../engine/events/request-session.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
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
  let journal: EventJournalStore;
  let routeRuleStore: RouteRuleStore;

  const makeApp = (ingress: EventIngress, opts: EventRoutesOptions = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/events',
      createEventRoutes(createMockAuth(), { ingress, bindingStore, journal, routeRuleStore }, opts),
    );
    return app;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-event-routes-'));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
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
});
