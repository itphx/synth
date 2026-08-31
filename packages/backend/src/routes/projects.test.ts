import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRoutes } from './projects.js';
import { ProjectStore } from '../storage/project-store.js';
import type { User } from '@itphx/synth-shared';

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

function createMockSessionManager() {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
  };
}

function createTestApp() {
  const app = new Hono();
  const kit = createMockKit();
  const store = new ProjectStore({ dataDir: tmpDir });
  const sessionManager = createMockSessionManager();
  const projectRoutes = createProjectRoutes(kit as any, store, sessionManager as any, tmpDir);
  app.route('/api/v2/projects', projectRoutes);
  return { app, store, sessionManager };
}

let tmpDir: string;

describe('Project API Routes', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/v2/projects', () => {
    it('возвращает пустой список', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual([]);
    });

    it('возвращает список проектов', async () => {
      const { app, store } = createTestApp();
      const p1 = store.create('P1', 'test-user');
      const p2 = store.create('P2', 'test-user');
      await store.save(p1);
      await store.save(p2);
      const res = await app.request('/api/v2/projects');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe('POST /api/v2/projects', () => {
    it('создаёт проект с валидным именем', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Project' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.name).toBe('New Project');
      expect(body.owner_id).toBe('test-user');
    });

    it('возвращает 400 без name', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 400 при пустом имени', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);
    });

    it('создаёт проект с планом (AD-039) и сохраняет его в store', async () => {
      const plan = {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        columns: [{ id: 'c1', name: 'Колонка', order: 0 }],
        items: [{ id: 'i1', title: 'шаг', columnId: 'c1', priority: 'medium', order: 1, dependsOn: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      };
      const { app, store } = createTestApp();
      const res = await app.request('/api/v2/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Planned', plan }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.plan).toEqual(plan);
      const stored = await store.load(body.id);
      expect(stored?.plan).toEqual(plan);
    });
  });

  describe('GET /api/v2/projects/:id', () => {
    it('возвращает проект по id', async () => {
      const { app, store } = createTestApp();
      const project = store.create('GetTest', 'test-user');
      await store.save(project);
      const res = await app.request(`/api/v2/projects/${project.id}`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.id).toBe(project.id);
      expect(body.name).toBe('GetTest');
    });

    it('возвращает 404 для отсутствующего проекта', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects/non-existent');
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PUT /api/v2/projects/:id', () => {
    it('обновляет проект', async () => {
      const { app, store } = createTestApp();
      const project = store.create('Before', 'test-user', { description: 'old' });
      await store.save(project);
      const res = await app.request(`/api/v2/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'After', description: 'new' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.name).toBe('After');
      expect(body.description).toBe('new');
    });

    it('возвращает 404 для отсутствующего проекта', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects/non-existent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('PUT обновляет план проекта', async () => {
      const plan = {
        version: 2,
        updatedAt: '2026-02-01T00:00:00.000Z',
        columns: [{ id: 'todo', name: 'К выполнению', order: 0 }],
        items: [],
      };
      const { app, store } = createTestApp();
      const project = store.create('PlanUpdate', 'test-user');
      await store.save(project);
      const res = await app.request(`/api/v2/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.plan).toEqual(plan);
      const stored = await store.load(project.id);
      expect(stored?.plan).toEqual(plan);
    });
  });

  describe('DELETE /api/v2/projects/:id', () => {
    it('удаляет проект и возвращает 204', async () => {
      const { app, store } = createTestApp();
      const project = store.create('ToDelete', 'test-user');
      await store.save(project);
      const res = await app.request(`/api/v2/projects/${project.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(await store.load(project.id)).toBeNull();
    });

    it('возвращает 404 для отсутствующего проекта', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects/non-existent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/projects/:id/stats', () => {
    it('возвращает нулевую статистику для пустого проекта', async () => {
      const { app, store } = createTestApp();
      const project = store.create('Stats', 'test-user');
      await store.save(project);
      const res = await app.request(`/api/v2/projects/${project.id}/stats`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.total_sessions).toBe(0);
      expect(body.total_messages).toBe(0);
      expect(body.total_tokens).toBe(0);
      expect(body.total_input_tokens).toBe(0);
      expect(body.total_output_tokens).toBe(0);
    });

    it('возвращает 404 для отсутствующего проекта', async () => {
      const { app } = createTestApp();
      const res = await app.request('/api/v2/projects/non-existent/stats');
      expect(res.status).toBe(404);
    });
  });
});
