import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '@synth/core';
import type { User } from '@synth/shared';

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
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, eventBus, queueManager, orchestrator, eventHub, fileStore };
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
});
