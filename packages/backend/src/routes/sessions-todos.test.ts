import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore, ProjectStore } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

/**
 * HTTP-контур ToDo сессии (PROP-054): CRUD, порядок, очистка, событие
 * `todos.updated` и доступ (единый prefix-guard сессий — инвариант 16).
 */

const testUser: User = {
  id: 'test-user',
  username: 'test-user',
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

function createMockKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    requirePermission: () => async (_c: Context, next: Next) => { await next(); },
    getCurrentUser: () => testUser,
  };
}

function createMockQueueManager() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({
      manifest: { totalChars: 10, estTokens: 3, staticPrefixChars: 5, entries: [] },
      history: {
        messages: { count: 2, chars: 20, estTokens: 5 },
        stateMessages: [{ type: 'mode_change', count: 1, chars: 40, estTokens: 10 }],
        excluded: { disabled: 0, hidden: 0, info: 1 },
        attachments: { count: 0, bytes: 0 },
        secretPlaceholders: 0,
      },
      promptState: null,
      lastPromptMeta: null,
    }),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

function createMockEventHub() {
  return {
    subscribeToSession: vi.fn().mockResolvedValue(undefined),
    unsubscribeFromSession: vi.fn(),
    registerClient: vi.fn().mockResolvedValue(undefined),
    unregisterClient: vi.fn(),
    shutdown: vi.fn(),
  };
}

describe('ToDo сессии — HTTP (PROP-054)', () => {
  let tmpDir: string;
  let app: Hono;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todos-routes-'));
    const fileStore = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(fileStore);
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();
    const orchestrator = createMockOrchestrator();

    const sessionRoutes = createSessionRoutes(
      createMockKit() as never,
      sessionManager,
      eventBus,
      createMockQueueManager() as never,
      orchestrator.createProcessMessage(),
      orchestrator as never,
      createMockEventHub() as never,
      undefined,
      projectStore,
      undefined,
    );
    app = new Hono();
    app.route('/api/v2/sessions', sessionRoutes);

    const session = await sessionManager.createSession({
      title: 'ToDo',
      userId: testUser.id,
      ownerId: testUser.id,
    });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /todos отдаёт список', async () => {
    const res = await app.request(`/api/v2/sessions/${sessionId}/todos`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: unknown[] };
    expect(body.todos).toEqual([]);
  });

  it('POST /todos создаёт пункт и публикует todos.updated', async () => {
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });

    const res = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Шаг 1', priority: 'high' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: Array<{ id: string; content: string; priority: string }> };
    expect(body.todos).toHaveLength(1);
    expect(body.todos[0]!.content).toBe('Шаг 1');
    expect(body.todos[0]!.priority).toBe('high');
    expect(events).toHaveLength(1);
    expect(Array.isArray(events[0]!.todos)).toBe(true);
  });

  it('PATCH /todos/:todoId меняет статус', async () => {
    const created = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Шаг 1' }),
    });
    const body = (await created.json()) as { todos: Array<{ id: string }> };
    const todoId = body.todos[0]!.id;

    const patched = await app.request(`/api/v2/sessions/${sessionId}/todos/${todoId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { todos: Array<{ status: string }> };
    expect(after.todos[0]!.status).toBe('completed');
  });

  it('DELETE /todos/:todoId удаляет пункт; неизвестный — 404', async () => {
    const created = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Шаг 1' }),
    });
    const body = (await created.json()) as { todos: Array<{ id: string }> };

    const deleted = await app.request(`/api/v2/sessions/${sessionId}/todos/${body.todos[0]!.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    const after = (await deleted.json()) as { todos: unknown[] };
    expect(after.todos).toEqual([]);

    const missing = await app.request(`/api/v2/sessions/${sessionId}/todos/nope`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });

  it('PUT /todos/order переставляет пункты', async () => {
    const created = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'A' }),
    });
    let body = (await created.json()) as { todos: Array<{ id: string; content: string }> };
    const first = body.todos[0]!.id;

    const second = await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'B' }),
    });
    body = (await second.json()) as { todos: Array<{ id: string; content: string }> };
    const secondId = body.todos[1]!.id;

    const reordered = await app.request(`/api/v2/sessions/${sessionId}/todos/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [secondId, first] }),
    });
    expect(reordered.status).toBe(200);
    const after = (await reordered.json()) as { todos: Array<{ content: string }> };
    expect(after.todos.map((t) => t.content)).toEqual(['B', 'A']);
  });

  it('POST /todos/clear убирает выполненные и отменённые', async () => {
    await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'A', status: 'completed' }),
    });
    await app.request(`/api/v2/sessions/${sessionId}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'B', status: 'in_progress' }),
    });

    const cleared = await app.request(`/api/v2/sessions/${sessionId}/todos/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { todos: Array<{ content: string }> };
    expect(body.todos.map((t) => t.content)).toEqual(['B']);
  });

  it('чужую сессию не видно — 403 (единый prefix-guard)', async () => {
    const foreign = await sessionManager.createSession({
      title: 'Чужая',
      userId: 'other',
      ownerId: 'other',
    });
    const res = await app.request(`/api/v2/sessions/${foreign.id}/todos`);
    expect(res.status).toBe(403);
  });

  it('несуществующая сессия — 404', async () => {
    const res = await app.request('/api/v2/sessions/nope/todos');
    expect(res.status).toBe(404);
  });
});
