import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
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
import { createSessionTodoRoutes } from './session-todos.js';

/**
 * HTTP-контур списка задач сессии (ADR-130): CRUD/порядок/очистка, событие
 * `todos.updated` и **гибрид** — форвард на удалённый backend для
 * `remote:`-сессии (права/валидация — на удалённой стороне).
 */
describe('HTTP списка задач сессии (ADR-130)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todos-routes-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    const session = await sessionManager.createSession({ title: 'Сессия' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeLocalApp(): Hono {
    const app = new Hono();
    app.route(
      '/api/v2/sessions',
      createSessionTodoRoutes({
        requireAuth: async (_c: Context, next: Next) => { await next(); },
        sessionManager,
        eventBus,
      }),
    );
    return app;
  }

  it('POST/GET/PATCH/DELETE пункта ToDo', async () => {
    const app = makeLocalApp();
    const created = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'шаг' }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { todos: Array<{ id: string; content: string }> };
    expect(body.todos).toHaveLength(1);
    const todoId = body.todos[0]!.id;

    const patched = await app.request(`/api/v2/sessions/${sessionId}/todos/${todoId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { todos: Array<{ status: string }> };
    expect(after.todos[0]!.status).toBe('completed');

    const deleted = await app.request(`/api/v2/sessions/${sessionId}/todos/${todoId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    const left = (await deleted.json()) as { todos: unknown[] };
    expect(left.todos).toHaveLength(0);
  });

  it('порядок и очистка; после мутации — todos.updated в канал сессии', async () => {
    const app = makeLocalApp();
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });

    const created = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'первый' }),
    });
    const body = (await created.json()) as { todos: Array<{ id: string }> };
    const todoId = body.todos[0]!.id;

    const order = await app.request(`/api/v2/sessions/${sessionId}/todos/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [todoId] }),
    });
    expect(order.status).toBe(200);

    const clear = await app.request(`/api/v2/sessions/${sessionId}/todos/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statuses: ['completed'] }),
    });
    expect(clear.status).toBe(200);

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]!.session_id).toBe(sessionId);
  });
});

/**
 * Гибрид (ADR-042/ADR-130): список задач удалённой сессии (`remote:<uuid>`)
 * живёт в её мире — запрос форвардится на удалённый backend; доступ
 * проверяет удалённая сторона (prefix-guard сессий `remote:`-id пропускает).
 */
describe('Гибрид: ToDo удалённой сессии форвардится на backend (ADR-130)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let sessionId: string;
  const REMOTE_ID = 'remote:s-remote-1';
  const LOCAL_ID = 's-remote-1';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todos-remote-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    const session = await sessionManager.createSession({ title: 'Сессия' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp(
    handler?: FakeRemoteHandler,
  ): { app: Hono; calls: FakeRemoteCall[] } {
    const fake = createFakeRemoteClient(handler ?? (() => remoteJson({ todos: [] })));
    const app = new Hono();
    app.route(
      '/api/v2/sessions',
      createSessionTodoRoutes({
        requireAuth: async (_c: Context, next: Next) => { await next(); },
        sessionManager,
        eventBus,
        getRemoteClient: () => fake.client,
      }),
    );
    return { app, calls: fake.calls };
  }

  it('GET /todos форвардится (id без префикса remote:)', async () => {
    const { app, calls } = makeApp(() => remoteJson({ todos: [{ id: 't1', content: 'шаг' }] }));
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe(`/api/v2/sessions/${LOCAL_ID}/todos`);
    const body = (await res.json()) as { todos: Array<{ id: string }> };
    expect(body.todos[0]!.id).toBe('t1');
  });

  it('POST /todos форвардится с телом', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'шаг' }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe(`/api/v2/sessions/${LOCAL_ID}/todos`);
    expect(calls[0]!.body).toEqual({ content: 'шаг' });
  });

  it('PATCH /todos/:todoId форвардится с телом', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos/t-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toBe(`/api/v2/sessions/${LOCAL_ID}/todos/t-1`);
    expect(calls[0]!.body).toEqual({ status: 'completed' });
  });

  it('DELETE /todos/:todoId форвардится', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos/t-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.path).toBe(`/api/v2/sessions/${LOCAL_ID}/todos/t-1`);
  });

  it('PUT /todos/order форвардится с телом', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['t-1', 't-2'] }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe(`/api/v2/sessions/${LOCAL_ID}/todos/order`);
    expect(calls[0]!.body).toEqual({ ids: ['t-1', 't-2'] });
  });

  it('POST /todos/clear форвардится с телом', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statuses: ['completed'] }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe(`/api/v2/sessions/${LOCAL_ID}/todos/clear`);
    expect(calls[0]!.body).toEqual({ statuses: ['completed'] });
  });

  it('невалидное тело уходит на сервер (валидация — там)', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unknown: 1 }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ unknown: 1 });
  });

  it('локальная сессия обслуживается локально (удалённый клиент не вызывается)', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(`/api/v2/sessions/${sessionId}/todos`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('удалённый backend недоступен — 502', async () => {
    const { app } = makeApp(() => {
      throw new RemoteError('сервер недоступен', 'OFFLINE');
    });
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('OFFLINE');
  });

  it('гибрид не настроен (клиента нет) — 502 REMOTE_UNAVAILABLE', async () => {
    const app = new Hono();
    app.route(
      '/api/v2/sessions',
      createSessionTodoRoutes({
        requireAuth: async (_c: Context, next: Next) => { await next(); },
        sessionManager,
        eventBus,
        getRemoteClient: () => null,
      }),
    );
    const res = await app.request(`/api/v2/sessions/${REMOTE_ID}/todos`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
  });
});
