import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
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

function createTestApp(tmpDir: string) {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const orchestrator = createMockOrchestrator();

  const sessionRoutes = createSessionRoutes(
    createMockAuth(),
    sessionManager,
    eventBus,
    queueManager as any,
    orchestrator.createProcessMessage(),
    orchestrator as any,
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, eventBus };
}

describe('Session API Routes (PATCH mode)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-mode-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('PATCH /api/v2/sessions/:id с полем mode', () => {
    it('переключает режим сессии в plan', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('plan');
    });

    it('переключает режим сессии в act', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'act' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('act');
    });

    it('переключает режим сессии в yolo', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'yolo' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('yolo');
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.mode).toBe('yolo');
    });

    it('сериализованная сессия содержит mode_applicable', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(typeof body.mode_applicable).toBe('boolean');
    });

    it('сохраняет mode в хранилище (переживает чтение сессии)', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.mode).toBe('plan');
    });

    it('отклоняет невалидный mode', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'auto' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.mode).toBeUndefined();
    });

    it('отклоняет mode не-строку', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 42 }),
      });
      expect(res.status).toBe(400);
    });

    it('mode обновляется вместе с другими полями в одном PATCH', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Old', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Title', mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.name).toBe('New Title');
      expect(body.mode).toBe('plan');
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});
