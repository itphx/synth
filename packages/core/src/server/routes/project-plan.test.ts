import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MARKDOWN_LIMITS } from '@itphx/synth-shared';
import { ProjectStore } from '../../storage/project-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { RemoteError } from '../../remote/types.js';
import {
  createFakeRemoteClient,
  remoteJson,
  type FakeRemoteCall,
  type FakeRemoteHandler,
} from '../../test-helpers/fake-remote-client.js';
import { createProjectPlanRoutes } from './project-plan.js';
import type { ProjectPlanRoutesOptions } from './project-plan.js';

/**
 * HTTP-контур плана проекта (PROP-054): права (read/write), версия плана
 * (409 `PLAN_VERSION_CONFLICT`), лимиты Markdown и событие `plan.updated`
 * в каналы **всех** сессий проекта.
 */
describe('HTTP плана проекта (PROP-054)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let projectId: string;
  let sessionIds: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-routes-'));
    store = new ProjectStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();

    const project = store.create('План', 'owner');
    projectId = project.id;
    await store.save(project);

    sessionIds = [];
    for (const title of ['Первая', 'Вторая']) {
      const session = await sessionManager.createSession({ title });
      await sessionManager.withLock(session.id, async (s) => {
        s.projectId = projectId;
        await sessionManager.saveSession(s);
      });
      sessionIds.push(session.id);
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp(opts: Partial<ProjectPlanRoutesOptions> = {}): Hono {
    const app = new Hono();
    app.route(
      '/api/v2/projects',
      createProjectPlanRoutes(
        { requireAuth: async (_c: Context, next: Next) => { await next(); } },
        store,
        { sessionManager, eventBus, ...opts },
      ),
    );
    return app;
  }

  it('GET /plan отдаёт план проекта', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { version: number; columns: unknown[] } };
    expect(body.plan.version).toBe(1);
    expect(body.plan.columns.length).toBeGreaterThan(0);
  });

  it('GET /plan неизвестного проекта — 404', async () => {
    const app = makeApp();
    const res = await app.request('/api/v2/projects/nope/plan');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('POST /plan/items создаёт пункт и возвращает актуальный план', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг 1', priority: 'high' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { version: number; items: Array<{ title: string }> } };
    expect(body.plan.items).toHaveLength(1);
    expect(body.plan.items[0]!.title).toBe('Шаг 1');
    expect(body.plan.version).toBe(2);
  });

  it('описание длиннее лимита Markdown — 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг', description: 'x'.repeat(MARKDOWN_LIMITS.planDescription + 1) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('лишнее поле в теле — 400 (strict)', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг', unknown: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('устаревшая версия — 409 PLAN_VERSION_CONFLICT с актуальным планом', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan/columns/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: ['backlog'], version: 99 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; plan: { version: number } };
    expect(body.error.code).toBe('PLAN_VERSION_CONFLICT');
    expect(body.plan.version).toBe(1);
  });

  it('VIEWER читает план, но не мутирует его', async () => {
    const app = makeApp({
      canRead: () => true,
      canEditContent: () => false,
    });
    const read = await app.request(`/api/v2/projects/${projectId}/plan`);
    expect(read.status).toBe(200);

    const write = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг' }),
    });
    expect(write.status).toBe(403);
    const body = (await write.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_FORBIDDEN');
  });

  it('чужой проект — 403 (право чтения не выдано)', async () => {
    const app = makeApp({ canRead: () => false, canEditContent: () => false });
    const res = await app.request(`/api/v2/projects/${projectId}/plan`);
    expect(res.status).toBe(403);
  });

  it('мутация публикует plan.updated в каналы ВСЕХ сессий проекта', async () => {
    const events: Array<{ sessionId: string; data: Record<string, unknown> }> = [];
    for (const id of sessionIds) {
      eventBus.subscribe(id, (e) => { events.push({ sessionId: e.sessionId, data: e.data }); });
    }
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг' }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.sessionId).sort()).toEqual([...sessionIds].sort());
    for (const event of events) {
      expect(event.data.project_id).toBe(projectId);
      expect(typeof event.data.version).toBe('number');
    }
  });

  it('DELETE /plan/items/:itemId удаляет пункт; неизвестный — 404', async () => {
    const app = makeApp();
    const created = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг' }),
    });
    const body = (await created.json()) as { plan: { items: Array<{ id: string }> } };
    const itemId = body.plan.items[0]!.id;

    const deleted = await app.request(`/api/v2/projects/${projectId}/plan/items/${itemId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    const after = (await deleted.json()) as { plan: { items: unknown[] } };
    expect(after.plan.items).toHaveLength(0);

    const missing = await app.request(`/api/v2/projects/${projectId}/plan/items/nope`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });

  it('PATCH /plan/items/:itemId/move переносит пункт в другую колонку', async () => {
    const app = makeApp();
    const created = await app.request(`/api/v2/projects/${projectId}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг' }),
    });
    const body = (await created.json()) as { plan: { items: Array<{ id: string }> } };
    const itemId = body.plan.items[0]!.id;

    const moved = await app.request(`/api/v2/projects/${projectId}/plan/items/${itemId}/move`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columnId: 'done' }),
    });
    expect(moved.status).toBe(200);
    const after = (await moved.json()) as { plan: { items: Array<{ id: string; columnId: string }> } };
    expect(after.plan.items[0]!.columnId).toBe('done');
  });
});

/**
 * Гибрид (ADR-042/ADR-130): план удалённого проекта (`remote:<uuid>`) живёт на
 * сервере — запрос форвардится на удалённый backend, и права/валидация
 * решает **он** (локальная проверка доступа не выполняется).
 */
describe('Гибрид: план удалённого проекта форвардится на backend (ADR-130)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let projectId: string;
  const REMOTE_ID = 'remote:p-remote-1';
  const LOCAL_ID = 'p-remote-1';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-remote-'));
    store = new ProjectStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    const project = store.create('План', 'owner');
    projectId = project.id;
    await store.save(project);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp(
    handler?: FakeRemoteHandler,
  ): { app: Hono; calls: FakeRemoteCall[] } {
    const fake = createFakeRemoteClient(
      handler ?? (() => remoteJson({ plan: { version: 1, columns: [], items: [] } })),
    );
    const app = new Hono();
    app.route(
      '/api/v2/projects',
      createProjectPlanRoutes(
        { requireAuth: async (_c: Context, next: Next) => { await next(); } },
        store,
        { sessionManager, eventBus, getRemoteClient: () => fake.client },
      ),
    );
    return { app, calls: fake.calls };
  }

  it('GET /plan удалённого проекта форвардится (id без префикса remote:)', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/projects/${REMOTE_ID}/plan`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe(`/api/v2/projects/${LOCAL_ID}/plan`);
    const body = (await res.json()) as { plan: { version: number } };
    expect(body.plan.version).toBe(1);
  });

  it('мутация форвардится с телом; локальный проект не меняется', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/projects/${REMOTE_ID}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Шаг' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe(`/api/v2/projects/${LOCAL_ID}/plan/items`);
    expect(calls[0]!.body).toEqual({ title: 'Шаг' });

    // Локальный проект не тронут: форвард ушёл на сервер.
    const local = await store.load(projectId);
    expect(local?.plan?.items ?? []).toHaveLength(0);
  });

  it('невалидное тело уходит на сервер (валидация — там)', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/projects/${REMOTE_ID}/plan/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unknown: 1 }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ unknown: 1 });
  });

  it('409 удалённой стороны пробрасывается как есть', async () => {
    const { app } = makeApp(() =>
      remoteJson({ error: { code: 'PLAN_VERSION_CONFLICT', message: 'конфликт' } }, 409),
    );
    const res = await app.request(`/api/v2/projects/${REMOTE_ID}/plan/columns/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: ['backlog'], version: 99 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PLAN_VERSION_CONFLICT');
  });

  it('удалённый backend недоступен — 502', async () => {
    const { app } = makeApp(() => {
      throw new RemoteError('сервер недоступен', 'OFFLINE');
    });
    const res = await app.request(`/api/v2/projects/${REMOTE_ID}/plan`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('OFFLINE');
  });

  it('гибрид не настроен (клиента нет) — 502 REMOTE_UNAVAILABLE', async () => {
    const app = new Hono();
    app.route(
      '/api/v2/projects',
      createProjectPlanRoutes(
        { requireAuth: async (_c: Context, next: Next) => { await next(); } },
        store,
        { sessionManager, eventBus, getRemoteClient: () => null },
      ),
    );
    const res = await app.request(`/api/v2/projects/${REMOTE_ID}/plan`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
  });

  it('локальный проект обслуживается локально (удалённый клиент не вызывается)', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/plan`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
