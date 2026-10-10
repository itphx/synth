// AD-089 (срез B): backend монтирует core-фабрику событий с managed-RBAC.
// Проверяем правила маршрутизации: чтение (GET /routes) — requireAuth; мутации
// (POST/DELETE) — ADMIN/LEAD; валидация цели (сессия/агент) → 400; 404 при
// удалении отсутствующей записи. AD-089/AD-052: API-ключи привязок и приём
// события по ключу (без пользовательских кред).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventBindingStore,
  EventApiKeyStore,
  EventIngress,
  RequestSessionService,
  RouteRuleStore,
  createEventRoutes,
} from '@itphx/synth-core';
import type { RouteDecision, Session, User } from '@itphx/synth-shared';

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

/** Mock middleware: роли читаются из фиксированного пользователя (как requireAuth/requirePermission). */
function makeGuards(user: User | null) {
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }, 401);
    await next();
  };
  const requirePermission = (...roles: string[]): MiddlewareHandler => async (c, next) => {
    if (!user || !roles.some((r) => (user.roles as string[]).includes(r))) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403);
    }
    await next();
  };
  return { requireAuth, requirePermission };
}

const EPHEMERAL_RULE = { match: { source: 'ci' }, target: { mode: 'ephemeral', agentTemplate: 'assistant' } };

describe('Events API Routes (AD-089 срез B, backend RBAC)', () => {
  let dataDir: string;
  let routeRuleStore: RouteRuleStore;
  let bindingStore: EventBindingStore;
  let apiKeyStore: EventApiKeyStore;
  let ingress: EventIngress;
  let handleEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-events-'));
    routeRuleStore = new RouteRuleStore({ dataDir });
    bindingStore = new EventBindingStore({ dataDir });
    apiKeyStore = new EventApiKeyStore({ dataDir });
    handleEvent = vi.fn(async (): Promise<{ decision: RouteDecision; session: Session | null }> => ({
      decision: { kind: 'drop', reason: 'stub', audited: true },
      session: null,
    }));
    const service = { handleEvent } as unknown as RequestSessionService;
    ingress = new EventIngress({ requestSessionService: service });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeApp(user: User | null) {
    const { requireAuth, requirePermission } = makeGuards(user);
    const app = new Hono();
    app.route('/api/v2/events', createEventRoutes(
      { requireAuth },
      { ingress, bindingStore, apiKeyStore, journal: {} as never, routeRuleStore },
      {
        writeGuard: requirePermission('ADMIN', 'LEAD'),
        keyReadGuard: requirePermission('ADMIN', 'LEAD'),
        sessionExists: async (id) => id === 's-1',
        resolveAgentTemplate: (t) => (t === 'assistant' ? 'assistant' : null),
        resolveApiKeySecret: async (raw) => {
          const r = await apiKeyStore.resolveBySecret(raw);
          if (!r) return null;
          const b = await bindingStore.get(r.credential.bindingId);
          return b ? { binding: b, credential: r.credential } : null;
        },
        touchApiKey: (id) => apiKeyStore.touch(id),
      },
    ));
    return app;
  }

  const user = makeUser('developer', ['USER']);
  const admin = makeUser('admin', ['ADMIN']);
  const lead = makeUser('lead', ['LEAD']);

  function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('USER: GET /routes доступен (200), POST/DELETE → 403', async () => {
    const created = await routeRuleStore.upsert({
      priority: 0,
      enabled: true,
      match: { source: 'ci' },
      target: { mode: 'ephemeral' },
    });
    const app = makeApp(user);

    const list = await app.request('/api/v2/events/routes');
    expect(list.status).toBe(200);
    expect((await list.json() as { rules: unknown[] }).rules).toHaveLength(1);

    expect((await post(app, '/api/v2/events/routes', EPHEMERAL_RULE)).status).toBe(403);
    expect((await app.request(`/api/v2/events/routes/${created.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('LEAD: мутации bindings/keys разрешены, USER — 403', async () => {
    // LEAD создаёт привязку и ключ.
    const leadApp = makeApp(lead);
    const bindingRes = await post(leadApp, '/api/v2/events/bindings', {
      source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: 's-1',
    });
    expect(bindingRes.status).toBe(201);
    const binding = await bindingRes.json() as { id: string };

    const keyRes = await post(leadApp, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'bot' });
    expect(keyRes.status).toBe(201);
    const createdKey = await keyRes.json() as { id: string; key: string };
    expect(createdKey.key.startsWith('synth_evt_')).toBe(true);

    expect((await leadApp.request(`/api/v2/events/bindings/${binding.id}/keys/${createdKey.id}`, { method: 'DELETE' })).status).toBe(204);

    // USER не может создавать ключи.
    const userApp = makeApp(user);
    expect((await post(userApp, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'nope' })).status).toBe(403);
  });

  it('GET /keys: LEAD → 200, USER → 403 (keyReadGuard)', async () => {
    const leadApp = makeApp(lead);
    const bindingRes = await post(leadApp, '/api/v2/events/bindings', {
      source: 'telegram', chatKey: 'chat:telegram:k', mode: 'bound', sessionId: 's-1',
    });
    const binding = await bindingRes.json() as { id: string };
    expect((await post(leadApp, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'bot' })).status).toBe(201);

    expect((await leadApp.request(`/api/v2/events/bindings/${binding.id}/keys`)).status).toBe(200);

    const userApp = makeApp(user);
    expect((await userApp.request(`/api/v2/events/bindings/${binding.id}/keys`)).status).toBe(403);
  });

  it('неаутентифицированный → 401 на GET /routes', async () => {
    const app = makeApp(null);
    expect((await app.request('/api/v2/events/routes')).status).toBe(401);
  });

  it('ADMIN: POST 201, upsert по id 200, DELETE 204/404', async () => {
    const app = makeApp(admin);

    const create = await post(app, '/api/v2/events/routes', EPHEMERAL_RULE);
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string };
    expect(created.id).toMatch(/^rule_/);

    const update = await post(app, '/api/v2/events/routes', { ...EPHEMERAL_RULE, id: created.id, priority: 7 });
    expect(update.status).toBe(200);
    expect((await update.json() as { id: string; priority: number }).priority).toBe(7);

    const list = await app.request('/api/v2/events/routes');
    expect((await list.json() as { rules: unknown[] }).rules).toHaveLength(1);

    expect((await app.request(`/api/v2/events/routes/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/v2/events/routes/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('ADMIN: несуществующая сессия / неизвестный агент → 400', async () => {
    const app = makeApp(admin);

    const badSession = await post(app, '/api/v2/events/routes', {
      match: { source: 'ci' },
      target: { mode: 'bound', sessionId: 'missing' },
    });
    expect(badSession.status).toBe(400);
    expect((await badSession.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const unknownAgent = await post(app, '/api/v2/events/routes', {
      match: { source: 'ci' },
      target: { mode: 'ephemeral', agentTemplate: 'ghost' },
    });
    expect(unknownAgent.status).toBe(400);

    const ok = await post(app, '/api/v2/events/routes', {
      match: { source: 'ci' },
      target: { mode: 'bound', sessionId: 's-1' },
    });
    expect(ok.status).toBe(201);
  });

  // --- AD-089/AD-052: приём события по API-ключу привязки ---

  it('приём по ключу: 201, forced binding, source из привязки; неверный ключ → 401', async () => {
    const app = makeApp(admin);
    // Создаём привязку и ключ через API.
    const bindingRes = await post(app, '/api/v2/events/bindings', {
      source: 'telegram', chatKey: 'chat:telegram:7', mode: 'bound', sessionId: 's-1',
    });
    const binding = await bindingRes.json() as { id: string };
    const keyRes = await post(app, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'bot' });
    const createdKey = await keyRes.json() as { key: string };

    // Ключ действителен даже без пользовательского auth (эмулируем неаутентифицированный запрос).
    const anonApp = makeApp(null);
    const res = await post(anonApp, '/api/v2/events', { type: 'message', payload: { text: 'hi' } }, { Authorization: `Bearer ${createdKey.key}` });
    expect(res.status).toBe(201);

    expect(handleEvent).toHaveBeenCalledOnce();
    const call = handleEvent.mock.calls[0]! as unknown as [any, { binding?: { id: string } }];
    expect(call[0].source).toBe('telegram');
    expect(call[0].identity.chatKey).toBe('chat:telegram:7');
    expect(call[1].binding?.id).toBe(binding.id);

    const bad = await post(anonApp, '/api/v2/events', { type: 'message' }, { Authorization: 'Bearer synth_evt_bad' });
    expect(bad.status).toBe(401);

    // GET /keys не отдаёт секрет/hash.
    const keysRes = await app.request(`/api/v2/events/bindings/${binding.id}/keys`);
    const keys = (await keysRes.json() as { keys: any[] }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBeUndefined();
    expect(keys[0].hash).toBeUndefined();
  });

  it('удаление привязки каскадно удаляет ключи (ключ перестаёт приниматься)', async () => {
    const app = makeApp(admin);
    const bindingRes = await post(app, '/api/v2/events/bindings', {
      source: 'telegram', chatKey: 'chat:telegram:8', mode: 'bound', sessionId: 's-1',
    });
    const binding = await bindingRes.json() as { id: string };
    const keyRes = await post(app, `/api/v2/events/bindings/${binding.id}/keys`, { label: 'bot' });
    const createdKey = await keyRes.json() as { key: string };

    expect((await app.request(`/api/v2/events/bindings/${binding.id}`, { method: 'DELETE' })).status).toBe(204);

    const anonApp = makeApp(null);
    const res = await post(anonApp, '/api/v2/events', { type: 'message' }, { Authorization: `Bearer ${createdKey.key}` });
    expect(res.status).toBe(401);
    expect(await apiKeyStore.listByBinding(binding.id)).toHaveLength(0);
  });
});
