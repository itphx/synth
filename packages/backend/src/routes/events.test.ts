// AD-089 (срез B): backend монтирует core-фабрику событий с managed-RBAC.
// Проверяем правила маршрутизации: чтение (GET /routes) — requireAuth; мутации
// (POST/DELETE) — только ADMIN; валидация цели (сессия/агент) → 400; 404 при
// удалении отсутствующей записи.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

const EPHEMERAL_RULE = { match: { source: 'ci' }, target: { mode: 'ephemeral', agentTemplate: 'assistant' } };

describe('Events API Routes (AD-089 срез B, backend RBAC)', () => {
  let dataDir: string;
  let routeRuleStore: RouteRuleStore;
  let ingress: EventIngress;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-events-'));
    routeRuleStore = new RouteRuleStore({ dataDir });
    const service = {
      handleEvent: async (): Promise<{ decision: RouteDecision; session: Session | null }> => ({
        decision: { kind: 'drop', reason: 'stub', audited: true },
        session: null,
      }),
    } as unknown as RequestSessionService;
    ingress = new EventIngress({ requestSessionService: service });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeApp(user: User | null) {
    const { requireAuth, requireAdmin } = makeGuards(user);
    const app = new Hono();
    app.route('/api/v2/events', createEventRoutes(
      { requireAuth },
      { ingress, bindingStore: {} as never, journal: {} as never, routeRuleStore },
      {
        writeGuard: requireAdmin,
        sessionExists: async (id) => id === 's-1',
        resolveAgentTemplate: (t) => (t === 'assistant' ? 'assistant' : null),
      },
    ));
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
});
