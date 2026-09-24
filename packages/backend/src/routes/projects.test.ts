import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProjectRoutes } from './projects.js';
import { ProjectStore } from '../storage/project-store.js';
import type { User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';

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

    it('учитывает дочерние сессии сабагентов (projectId наследуется)', async () => {
      const { app, store, sessionManager } = createTestApp();
      const project = store.create('WithSubagents', 'test-user');
      await store.save(project);
      sessionManager.listSessions.mockResolvedValue([
        {
          id: 'parent', projectId: project.id,
          inputTokens: 100, outputTokens: 10, totalTokens: 110,
          cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
          messages: [{}],
        },
        {
          id: 'child', projectId: project.id, parentId: 'parent',
          inputTokens: 300, outputTokens: 30, totalTokens: 330,
          cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 0,
          messages: [{}, {}],
        },
      ]);

      const res = await app.request(`/api/v2/projects/${project.id}/stats`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.total_sessions).toBe(2);
      expect(body.total_input_tokens).toBe(400);
      expect(body.total_output_tokens).toBe(40);
      expect(body.total_tokens).toBe(440);
      expect(body.total_cache_read_tokens).toBe(10);
      expect(body.total_messages).toBe(3);
      expect(sessionManager.listSessions).toHaveBeenCalledWith({ projectId: project.id });
    });
  });
});

// ---------------------------------------------------------------------------
// AD-075: provisioning workspace managed-проекта (автосоздание, авто-имя, пути, RBAC)
// ---------------------------------------------------------------------------

interface WsMockUser extends User {
  roles: string[];
}

const WS_USERS: Record<string, WsMockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as WsMockUser,
  outsider: { id: 'outsider', username: 'outsider', roles: ['USER'] } as WsMockUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as WsMockUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as WsMockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as WsMockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as WsMockUser,
};

function wsUserFromHeader(header: string | undefined): WsMockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? WS_USERS[m[1]!] ?? null : null;
}

function wsAuth(user: string) {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

function makeWorkspaceApp() {
  const app = new Hono();
  const kit = {
    requireAuth: async (c: Context, next: Next) => {
      const user = wsUserFromHeader(c.req.header('Authorization'));
      if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
      c.set('user', user);
      await next();
    },
    getCurrentUser: async (c: Context) => wsUserFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }): boolean => {
      const u = c.get('user') as WsMockUser | undefined;
      return !!u && u.roles.includes('ADMIN');
    },
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]): boolean => {
      const u = c.get('user') as WsMockUser | undefined;
      return !!u && roles.some((r) => u.roles.includes(r));
    },
  };
  const store = new ProjectStore({ dataDir: tmpDir });
  const routes = createProjectRoutes(
    kit as never,
    store,
    { listSessions: vi.fn().mockResolvedValue([]) } as never,
    tmpDir,
  );
  app.route('/api/v2/projects', routes);
  return { app, store };
}

describe('Project workspace provisioning (AD-075, managed backend)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-proj-ws-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST без workspace — авто-имя slug, каталог создан', async () => {
    const { app } = makeWorkspaceApp();
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'My Project' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.workspace).toBe('my-project');
    expect((await stat(resolve(tmpDir, 'my-project'))).isDirectory()).toBe(true);
  });

  it('POST с явным относительным workspace — каталог создаётся (без 422 «не найден»)', async () => {
    const { app } = makeWorkspaceApp();
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'X', workspace: 'nested/dir' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.workspace).toBe('nested/dir');
    expect((await stat(resolve(tmpDir, 'nested/dir'))).isDirectory()).toBe(true);
  });

  it('POST авто-имя при коллизии → base-2', async () => {
    const { app, store } = makeWorkspaceApp();
    const existing = store.create('Existing', 'owner', { workspace: 'my-project' });
    await store.save(existing);

    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'My Project' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.workspace).toBe('my-project-2');
    expect((await stat(resolve(tmpDir, 'my-project-2'))).isDirectory()).toBe(true);
  });

  it('POST авто-имя учитывает существующий каталог root → base-2', async () => {
    const { app } = makeWorkspaceApp();
    // Каталог есть, проекта с таким workspace нет — имя не должно «всмериться» в него.
    await mkdir(resolve(tmpDir, 'my-project'), { recursive: true });

    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'My Project' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.workspace).toBe('my-project-2');
    expect((await stat(resolve(tmpDir, 'my-project-2'))).isDirectory()).toBe(true);
  });

  it('параллельные POST с одним именем → разные авто-workspace (атомарный claim)', async () => {
    const { app } = makeWorkspaceApp();
    const [r1, r2] = await Promise.all([
      app.request('/api/v2/projects', {
        method: 'POST', headers: wsAuth('owner'), body: JSON.stringify({ name: 'Race' }),
      }),
      app.request('/api/v2/projects', {
        method: 'POST', headers: wsAuth('owner'), body: JSON.stringify({ name: 'Race' }),
      }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const b1: any = await r1.json();
    const b2: any = await r2.json();
    expect(b1.workspace).not.toBe(b2.workspace);
    expect(new Set([b1.workspace, b2.workspace])).toEqual(new Set(['race', 'race-2']));
    expect((await stat(resolve(tmpDir, b1.workspace))).isDirectory()).toBe(true);
    expect((await stat(resolve(tmpDir, b2.workspace))).isDirectory()).toBe(true);
  });

  it('POST абсолютный путь внутри root → нормализуется в относительный', async () => {
    const { app } = makeWorkspaceApp();
    const abs = resolve(tmpDir, 'abs-ws');
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'Abs', workspace: abs }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.workspace).toBe('abs-ws');
    expect((await stat(abs)).isDirectory()).toBe(true);
  });

  it('POST абсолютный путь вне root → 403 WORKSPACE_OUTSIDE_ROOT_DENIED', async () => {
    const { app } = makeWorkspaceApp();
    const outside = resolve(tmpDir, '..', 'outside-ws');
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'Outside', workspace: outside }),
    });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('POST confirmOutsideRoot не разрешает путь вне root (managed — всегда deny)', async () => {
    const { app } = makeWorkspaceApp();
    const outside = resolve(tmpDir, '..', 'outside-ws');
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: wsAuth('owner'),
      body: JSON.stringify({ name: 'Outside', workspace: outside, confirmOutsideRoot: true }),
    });
    expect(res.status).toBe(403);
  });

  it('PUT workspace: owner/LEAD/ADMIN → 200, чужой → 403 и workspace не меняется', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = store.create('P', 'owner', { workspace: 'orig' });
    await store.save(project);

    const denied = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT',
      headers: wsAuth('outsider'),
      body: JSON.stringify({ workspace: 'hacked' }),
    });
    expect(denied.status).toBe(403);
    expect((await store.load(project.id))!.workspace).toBe('orig');

    for (const user of ['owner', 'lead', 'admin']) {
      const res = await app.request(`/api/v2/projects/${project.id}`, {
        method: 'PUT',
        headers: wsAuth(user),
        body: JSON.stringify({ workspace: `ws-${user}` }),
      });
      expect(res.status, user).toBe(200);
      const body: any = await res.json();
      expect(body.workspace).toBe(`ws-${user}`);
    }
  });

  it('PUT workspace вне root → 403, значение не меняется', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = store.create('P', 'owner', { workspace: 'orig' });
    await store.save(project);

    const res = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT',
      headers: wsAuth('owner'),
      body: JSON.stringify({ workspace: resolve(tmpDir, '..', 'outside-ws') }),
    });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.workspace).toBe('orig');
  });
});

// ---------------------------------------------------------------------------
// D5: горизонтальная авторизация — PUT контента и DELETE
// (owner/EDITOR/VIEWER/LEAD/ADMIN/посторонний)
// ---------------------------------------------------------------------------

describe('Project RBAC (D5): контент и удаление', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-proj-rbac-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Проект owner'а с участниками editor/viewer — через store API, без ручного JSON. */
  async function seedProject(store: ProjectStore, name = 'P') {
    const project = store.create(name, 'owner');
    project.members['editor'] = ProjectRole.EDITOR;
    project.members['viewer'] = ProjectRole.VIEWER;
    await store.save(project);
    return project;
  }

  function put(app: Hono, id: string, user: string, payload: unknown) {
    return app.request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: wsAuth(user),
      body: JSON.stringify(payload),
    });
  }

  it('посторонний USER PUT name/plan/repos → 403, проект не изменён', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    const payloads: unknown[] = [
      { name: 'Hacked' },
      { plan: { version: 9, updatedAt: '2026-01-01T00:00:00.000Z', columns: [], items: [] } },
      { repos: ['evil-repo'] },
    ];
    for (const payload of payloads) {
      const res = await put(app, project.id, 'outsider', payload);
      expect(res.status, JSON.stringify(payload)).toBe(403);
      const body: any = await res.json();
      expect(body.error.code, JSON.stringify(payload)).toBe('FORBIDDEN');
    }

    const stored = (await store.load(project.id))!;
    expect(stored.name).toBe('P');
    expect(stored.repos).toBeUndefined();
    expect(stored.plan).toEqual(project.plan);
  });

  it('EDITOR PUT name/plan → 200', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    const nameRes = await put(app, project.id, 'editor', { name: 'Edited by editor' });
    expect(nameRes.status).toBe(200);
    expect((await nameRes.json() as any).name).toBe('Edited by editor');

    const plan = { version: 3, updatedAt: '2026-03-01T00:00:00.000Z', columns: [], items: [] };
    const planRes = await put(app, project.id, 'editor', { plan });
    expect(planRes.status).toBe(200);
    expect((await store.load(project.id))!.plan).toEqual(plan);
  });

  it('EDITOR PUT workspace → 403 (workspace — только owner/LEAD/ADMIN)', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    const res = await put(app, project.id, 'editor', { workspace: 'ws-editor' });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.workspace).toBeUndefined();
  });

  it('EDITOR PUT name+workspace → 403, name не меняется (проверка до мутаций)', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    const res = await put(app, project.id, 'editor', { name: 'Should not apply', workspace: 'ws-editor' });
    expect(res.status).toBe(403);
    const stored = (await store.load(project.id))!;
    expect(stored.name).toBe('P');
    expect(stored.workspace).toBeUndefined();
  });

  it('VIEWER PUT name → 403, проект не изменён', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    const res = await put(app, project.id, 'viewer', { name: 'Viewer edit' });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.name).toBe('P');
  });

  it('owner/LEAD/ADMIN PUT name → 200', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    for (const user of ['owner', 'lead', 'admin']) {
      const res = await put(app, project.id, user, { name: `by-${user}` });
      expect(res.status, user).toBe(200);
      expect((await res.json() as any).name, user).toBe(`by-${user}`);
    }
  });

  it('DELETE: посторонний USER/EDITOR/VIEWER → 403 (проект жив), owner/LEAD/ADMIN → 204', async () => {
    const { app, store } = makeWorkspaceApp();
    const project = await seedProject(store);

    for (const user of ['outsider', 'editor', 'viewer']) {
      const res = await app.request(`/api/v2/projects/${project.id}`, {
        method: 'DELETE',
        headers: wsAuth(user),
      });
      expect(res.status, user).toBe(403);
      expect(await store.load(project.id), user).not.toBeNull();
    }

    for (const user of ['owner', 'lead', 'admin']) {
      const target = await seedProject(store, `Delete-${user}`);
      const res = await app.request(`/api/v2/projects/${target.id}`, {
        method: 'DELETE',
        headers: wsAuth(user),
      });
      expect(res.status, user).toBe(204);
      expect(await store.load(target.id), user).toBeNull();
    }
  });
});
