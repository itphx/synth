import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '@itphx/synth-core';
import { ProjectStore } from '../storage/project-store.js';
import type { User } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';

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

function createTestApp(tmpDir: string) {
  const app = new Hono();
  const kit = createMockKit();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const orchestrator = createMockOrchestrator();
  const eventHub = createMockEventHub();

  const sessionRoutes = createSessionRoutes(
    kit as any,
    sessionManager,
    eventBus,
    queueManager as any,
    orchestrator.createProcessMessage(),
    orchestrator as any,
    eventHub as any,
    undefined,
    projectStore,
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, projectStore, eventBus, queueManager, orchestrator, eventHub, fileStore };
}

describe('Session API Routes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/v2/sessions', () => {
    it('возвращает пустой список', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual([]);
    });

    it('возвращает список сессий', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      await sessionManager.createSession({ title: 'S1', userId: 'test-user' });
      await sessionManager.createSession({ title: 'S2', userId: 'test-user' });
      const res = await app.request('/api/v2/sessions');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe('POST /api/v2/sessions', () => {
    it('создаёт сессию и возвращает 201', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Session' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.name).toBe('Test Session');
    });

    it('создаёт сессию с project_id', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'P', project_id: 'proj-1' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.project_id).toBe('proj-1');
    });
  });

  describe('GET /api/v2/sessions/:id', () => {
    it('возвращает сессию по id', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'GetMe', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.id).toBe(session.id);
      expect(body.name).toBe('GetMe');
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent');
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /api/v2/sessions/:id', () => {
    it('обновляет заголовок сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Old', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Title' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.name).toBe('New Title');
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('переключает mode в plan и возвращает его в сериализованной сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Mode', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('plan');
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.mode).toBe('plan');
    });

    it('переключает mode в act', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Mode', userId: 'test-user' });
      await sessionManager.updateSession({ ...session, mode: 'plan' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'act' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('act');
    });

    it('возвращает 400 VALIDATION_ERROR для невалидного mode', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Mode', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'review' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.mode).toBeUndefined();
    });

    it('возвращает 400 VALIDATION_ERROR для невалидного settings.reasoningLevel', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Mode', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { reasoningLevel: 'bogus' } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('reasoningLevel');
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.settings.reasoningLevel).toBeUndefined();
    });

    it('обновляет валидные settings и сохраняет их', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Mode', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { reasoningLevel: 'high' } }),
      });
      expect(res.status).toBe(200);
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.settings.reasoningLevel).toBe('high');
    });

    it('привязывает сессию к существующему проекту', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const project = projectStore.create('Proj', 'test-user');
      await projectStore.save(project);
      const session = await sessionManager.createSession({ title: 'S', userId: 'test-user' });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: project.id }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.project_id).toBe(project.id);
    });

    it('валидирует несуществующий проект и возвращает 400 PROJECT_NOT_FOUND', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'test-user' });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'missing' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROJECT_NOT_FOUND');
    });

    it('смена проекта сбрасывает planApproved', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'test-user');
      const p2 = projectStore.create('P2', 'test-user');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'test-user', projectId: p1.id });
      await sessionManager.updateSession({ ...session, planApproved: true });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p2.id }),
      });
      expect(res.status).toBe(200);
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBe(p2.id);
      expect(persisted?.planApproved).toBe(false);
    });

    it('публикует session.moved при смене проекта', async () => {
      const { app, sessionManager, projectStore, eventBus } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'test-user');
      const p2 = projectStore.create('P2', 'test-user');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'test-user', projectId: p1.id });

      let moved: Record<string, unknown> | undefined;
      eventBus.subscribe(session.id, (e) => {
        if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
      });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p2.id }),
      });
      expect(res.status).toBe(200);
      expect(moved).toBeTruthy();
      expect(moved?.project_id).toBe(p2.id);
      expect(moved?.prev_project_id).toBe(p1.id);
    });
  });

  describe('DELETE /api/v2/sessions/:id', () => {
    it('удаляет сессию и возвращает 204', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Del', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(await sessionManager.getSession(session.id)).toBeNull();
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/sessions/:id/fork', () => {
    it('создаёт ответвление сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const source = await sessionManager.createSession({ title: 'Source', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${source.id}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.parent_id).toBe(source.id);
      expect(body.name).toContain('Source');
    });

    it('создаёт форк с указанием title', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const source = await sessionManager.createSession({ title: 'Source', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${source.id}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Forked Session' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.name).toBe('Forked Session');
    });
  });

  describe('GET /api/v2/sessions/:id/children', () => {
    it('возвращает дочерние сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const parent = await sessionManager.createSession({ title: 'Parent', userId: 'test-user' });
      const child = await sessionManager.forkSession(parent.id, { title: 'Child', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${parent.id}/children`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(child.id);
    });

    it('возвращает пустой массив когда нет детей', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Leaf', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}/children`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual([]);
    });
  });

  describe('GET /api/v2/sessions/:id/status', () => {
    it('возвращает статус сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Status', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}/status`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toHaveProperty('blocked');
      expect(body).toHaveProperty('pending_count');
      expect(body).toHaveProperty('processor_running');
      expect(body.blocked).toBe(false);
      expect(body.pending_count).toBe(0);
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/status');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/sessions/:id/tree', () => {
    it('возвращает дерево сессий', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const parent = await sessionManager.createSession({ title: 'Root', userId: 'test-user' });
      const child = await sessionManager.forkSession(parent.id, { title: 'Child', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${parent.id}/tree`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.session.id).toBe(parent.id);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].session.id).toBe(child.id);
    });
  });

  describe('POST /api/v2/sessions/:id/clear', () => {
    it('очищает сообщения сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Clear', userId: 'test-user' });
      const res = await app.request(`/api/v2/sessions/${session.id}/clear`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.id).toBe(session.id);
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/clear', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/sessions/:id/export', () => {
    it('возвращает полный объект сессии с историей, todos и настройками', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Exp', userId: 'test-user' });
      session.todos = [{ id: 't1', content: 'task', status: 'pending', priority: 'medium' }];
      await sessionManager.updateSession(session);
      await sessionManager.addMessage(session.id, {
        id: 'm1', role: MessageRole.USER, seq: 1, origin: 'local' as const,
        parts: [{ id: 'p1', type: 'text' as const, data: 'hello' }],
        content: 'hello', createdAt: new Date().toISOString(),
        disabled: false, pinned: false, hidden: false,
      });

      const res = await app.request(`/api/v2/sessions/${session.id}/export`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.id).toBe(session.id);
      expect(body.title).toBe('Exp');
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('hello');
      expect(body.todos).toEqual([{ id: 't1', content: 'task', status: 'pending', priority: 'medium' }]);
      expect(body.settings).toBeTruthy();
      expect(body.engine).toBe('synth');
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/export');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/sessions/import', () => {
    it('создаёт сессию с историей сообщений из экспорта', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const proj = projectStore.create('Proj1', 'test-user');
      await projectStore.save(proj);
      const source = await sessionManager.createSession({ title: 'Src', userId: 'test-user' });
      await sessionManager.addMessage(source.id, {
        id: 'm1', role: MessageRole.USER, seq: 1, origin: 'local' as const,
        parts: [{ id: 'p1', type: 'text' as const, data: 'привет' }],
        content: 'привет', createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false, pinned: false, hidden: false,
      });
      await sessionManager.addMessage(source.id, {
        id: 'm2', role: MessageRole.ASSISTANT, seq: 2, origin: 'local' as const,
        parts: [{ id: 'p2', type: 'text' as const, data: 'ответ' }],
        content: 'ответ', createdAt: '2026-01-01T00:00:01.000Z',
        disabled: false, pinned: false, hidden: false,
      });
      const exported = await sessionManager.getSession(source.id);

      const res = await app.request('/api/v2/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...exported, import: { project_id: proj.id } }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.id).not.toBe(source.id);
      expect(body.name).toBe('Src');
      expect(body.project_id).toBe(proj.id);

      const created = await sessionManager.getSession(body.id);
      expect(created?.messages).toHaveLength(2);
      expect(created?.messages[0]?.content).toBe('привет');
      expect(created?.messages[1]?.content).toBe('ответ');
      expect(created?.messages[1]?.seq).toBe(2);
    });

    it('принимает тело в snake_case формате', async () => {
      const { app, projectStore } = createTestApp(tmpDir);
      const proj = projectStore.create('Proj2', 'test-user');
      await projectStore.save(proj);
      const res = await app.request('/api/v2/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Snake',
          engine: 'synth',
          session_origin: 'user',
          project_id: proj.id,
          messages: [{
            id: 'm1', role: MessageRole.USER, seq: 1, origin: 'local',
            parts: [{ id: 'p1', type: 'text', data: 'x' }],
            content: 'x', created_at: '2026-01-01T00:00:00.000Z',
            disabled: false, pinned: false, hidden: false,
          }],
          todos: [{ id: 't1', content: 'task', status: 'pending', priority: 'high' }],
        }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.name).toBe('Snake');
      expect(body.project_id).toBe(proj.id);
    });

    it('сохраняет parentId из экспорта (publish переписывает его на remote-id)', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const proj = projectStore.create('Proj3', 'test-user');
      await projectStore.save(proj);
      const parent = await sessionManager.createSession({ title: 'Parent', userId: 'test-user' });
      const source = await sessionManager.createSession({ title: 'Child', userId: 'test-user', parentId: parent.id });
      const exported = await sessionManager.getSession(source.id);

      const res = await app.request('/api/v2/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...exported, import: { project_id: proj.id } }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.id).not.toBe(source.id);
      // parentId — как в экспорте (переписанный publish-ом remote-id).
      expect(body.parent_id).toBe(parent.id);
      const created = await sessionManager.getSession(body.id);
      expect(created?.parentId).toBe(parent.id);
    });

    it('возвращает 400 PROJECT_NOT_FOUND для несуществующего проекта', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'X', import: { project_id: 'no-such-project' } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  describe('GET /api/v2/sessions/:id/prompt (AD-070 §2.5)', () => {
    it('возвращает манифест для существующей сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: testUser.id });

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.manifest).toBeTruthy();
      expect(body.manifest.totalChars).toBe(10);
      expect(body.promptState).toBeNull();
      expect(body.lastPromptMeta).toBeNull();
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/prompt');
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v2/sessions/:id/stats (AD-070 §2.6)', () => {
    it('возвращает агрегацию по агентам и пользователям', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: testUser.id });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local',
        parts: [makeTextPart('hi')], content: 'hi', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false, author: testUser.username,
      });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.ASSISTANT, seq: 0, origin: 'local',
        parts: [makeTextPart('ok')], content: 'ok', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false, agentRole: 'developer',
        model: 'm', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        metadata: { duration_ms: 1000 },
      });

      const res = await app.request(`/api/v2/sessions/${session.id}/stats`);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.session_id).toBe(session.id);
      const dev = body.agents.find((a: any) => a.agent_role === 'developer');
      expect(dev).toBeTruthy();
      expect(dev.input_tokens).toBe(100);
      const user = body.users.find((u: any) => u.author === testUser.username);
      expect(user).toBeTruthy();
      expect(user.messages).toBe(1);
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/stats');
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});
