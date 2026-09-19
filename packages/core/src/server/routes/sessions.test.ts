import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
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
    getPromptInfo: vi.fn().mockResolvedValue({
      manifest: { totalChars: 10, estTokens: 3, staticPrefixChars: 5, entries: [] },
      promptState: null,
      lastPromptMeta: null,
    }),
  };
}

function createTestApp(tmpDir: string) {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
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
    undefined,
    projectStore,
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, projectStore, eventBus };
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

    it('отклоняет невалидный settings.reasoningLevel', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { reasoningLevel: 'bogus' } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.settings.reasoningLevel).toBeUndefined();
    });

    it('обновляет валидные settings и сохраняет их', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { reasoningLevel: 'medium' } }),
      });
      expect(res.status).toBe(200);
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.settings.reasoningLevel).toBe('medium');
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

  describe('PATCH /api/v2/sessions/:id с полем project_id', () => {
    it('привязывает сессию к существующему проекту', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const project = projectStore.create('Proj', 'u1');
      await projectStore.save(project);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: project.id }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.project_id).toBe(project.id);
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBe(project.id);
    });

    it('валидирует несуществующий проект и возвращает 400 PROJECT_NOT_FOUND', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'missing' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROJECT_NOT_FOUND');
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBeUndefined();
    });

    it('смена проекта сбрасывает planApproved', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'u1');
      const p2 = projectStore.create('P2', 'u1');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'local', projectId: p1.id });
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
      const p1 = projectStore.create('P1', 'u1');
      const p2 = projectStore.create('P2', 'u1');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'local', projectId: p1.id });

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

  describe('GET /api/v2/sessions/:id/prompt (AD-070 §2.5)', () => {
    it('возвращает манифест и promptMeta для существующей сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

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
});
