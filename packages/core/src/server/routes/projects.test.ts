import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectRoutes } from './projects.js';
import type { ProjectRoutesOptions } from './projects.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

describe('Project API Routes (workspace normalization)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-test-'));
    store = new ProjectStore({ dataDir: tmpDir });
    app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createProject(workspace: string): Promise<{ id: string; workspace: string | null }> {
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; workspace: string | null };
    return body;
  }

  it('относительный workspace сохраняется как есть', async () => {
    const p = await createProject('WS1');
    expect(p.workspace).toBe('WS1');
  });

  it('относительный workspace с ведущими ./ очищается', async () => {
    const p = await createProject('./WS1');
    expect(p.workspace).toBe('WS1');
  });

  it('абсолютный путь (даже однослоговый /WS1) остаётся как есть', async () => {
    const p = await createProject('/WS1');
    expect(p.workspace).toBe('/WS1');
  });

  it('абсолютный workspace остаётся абсолютным', async () => {
    const p = await createProject('/home/user/ws');
    expect(p.workspace).toBe('/home/user/ws');
  });

  it('PUT: нормализация применяется при обновлении workspace', async () => {
    const p = await createProject('WS1');
    const put = await app.request(`/api/v2/projects/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: './WS2/' }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { workspace: string | null };
    expect(body.workspace).toBe('WS2');
  });
});

describe('Project API Routes (workspace provisioning, AD-075)', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let store: ProjectStore;

  function makeApp(policy: WorkspaceOutsideRootPolicy = 'confirm'): Hono {
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      getWorkspacesRoot: () => workspacesRoot,
      getOutsideRootPolicy: () => policy,
    }));
    return app;
  }

  async function dirExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-ws-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });
    store = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST: относительный workspace создаёт каталог (mkdir -p)', async () => {
    const res = await makeApp().request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace: 'my-proj' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toBe('my-proj');
    expect(await dirExists(join(workspacesRoot, 'my-proj'))).toBe(true);
  });

  it('POST: абсолютный путь внутри root нормализуется в относительный', async () => {
    const res = await makeApp().request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace: join(workspacesRoot, 'abs-in') }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toBe('abs-in');
    expect(await dirExists(join(workspacesRoot, 'abs-in'))).toBe(true);
  });

  it('POST: absolute вне root без подтверждения → 409', async () => {
    const outside = join(tmpDir, 'outside');
    const res = await makeApp('confirm').request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace: outside }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED');
    expect(await dirExists(outside)).toBe(false);
  });

  it('POST: absolute вне root с confirmOutsideRoot принимается и создаётся', async () => {
    const outside = join(tmpDir, 'outside-ok');
    const res = await makeApp('confirm').request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace: outside, confirmOutsideRoot: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toBe(outside);
    expect(await dirExists(outside)).toBe(true);
  });

  it('POST: политика deny запрещает absolute вне root (403)', async () => {
    const outside = join(tmpDir, 'outside-deny');
    const res = await makeApp('deny').request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace: outside, confirmOutsideRoot: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
    expect(await dirExists(outside)).toBe(false);
  });

  it('POST без workspace ничего не создаёт', async () => {
    const res = await makeApp().request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    expect(res.status).toBe(201);
  });

  it('PUT: absolute внутри root нормализуется и создаёт каталог', async () => {
    const create = await makeApp().request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    const { id } = (await create.json()) as { id: string };

    const res = await makeApp().request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: join(workspacesRoot, 'put-in') }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toBe('put-in');
    expect(await dirExists(join(workspacesRoot, 'put-in'))).toBe(true);
  });

  it('PUT: absolute вне root без подтверждения → 409, workspace не меняется', async () => {
    const create = await makeApp().request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    const { id } = (await create.json()) as { id: string };

    const res = await makeApp('confirm').request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: join(tmpDir, 'nope') }),
    });
    expect(res.status).toBe(409);

    const check = await makeApp().request(`/api/v2/projects/${id}`);
    const body = (await check.json()) as { workspace: string | null };
    expect(body.workspace).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D1: новые opts core-фабрики — RBAC-хуки, /stats, /:id/mcp, авто-имя (managed),
// i18n-сообщения. Backend использует те же хуки, но здесь проверяем саму фабрику.
// ---------------------------------------------------------------------------

describe('Project API Routes (opts: RBAC / stats / MCP / managed)', () => {
  let tmpDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-opts-'));
    store = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function header(user: string): Record<string, string> {
    return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
  }

  function makeApp(opts: ProjectRoutesOptions): Hono {
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, opts));
    return app;
  }

  /** userId из заголовка; canManage/canEditContent — только владелец. */
  function ownerRbac(): ProjectRoutesOptions {
    return {
      getCurrentUserId: (c: Context) => /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '',
      canManage: (_c, project, userId) => project.ownerId === userId,
      canEditContent: (_c, project, userId) => project.ownerId === userId,
    };
  }

  async function seedOwner(name = 'P'): Promise<string> {
    const project = store.create(name, 'owner');
    await store.save(project);
    return project.id;
  }

  it('canManage: PUT workspace/delete чужого проекта → 403, удаление владельцем → 204', async () => {
    const app = makeApp(ownerRbac());
    const id = await seedOwner('orig');

    const putWs = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('other'), body: JSON.stringify({ workspace: 'hacked' }),
    });
    expect(putWs.status).toBe(403);
    expect((await store.load(id))!.workspace).toBeUndefined();

    const del = await app.request(`/api/v2/projects/${id}`, { method: 'DELETE', headers: header('other') });
    expect(del.status).toBe(403);
    expect(await store.load(id)).not.toBeNull();

    const okDel = await app.request(`/api/v2/projects/${id}`, { method: 'DELETE', headers: header('owner') });
    expect(okDel.status).toBe(204);
    expect(await store.load(id)).toBeNull();
  });

  it('canEditContent: контент чужому → 403, владельцу → 200 (workspace не затронут)', async () => {
    const app = makeApp(ownerRbac());
    const id = await seedOwner();

    const denied = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('other'), body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(denied.status).toBe(403);
    const body = await denied.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect((await store.load(id))!.name).toBe('P');

    const allowed = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('owner'), body: JSON.stringify({ name: 'Edited' }),
    });
    expect(allowed.status).toBe(200);
    expect((await store.load(id))!.name).toBe('Edited');
  });

  it('getCurrentUserId: POST создаёт проект с владельцем из opts', async () => {
    const app = makeApp(ownerRbac());
    const res = await app.request('/api/v2/projects', {
      method: 'POST', headers: header('alice'), body: JSON.stringify({ name: 'Alice Project' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect((await store.load(created.id))!.ownerId).toBe('alice');
  });

  it('sessionManager: GET /:id/stats агрегирует токены/сообщения, 404 для чужого id', async () => {
    const listSessions = vi.fn().mockResolvedValue([
      {
        inputTokens: 100, outputTokens: 10, totalTokens: 110,
        cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 2, messages: [{}],
      },
      {
        inputTokens: 300, outputTokens: 30, totalTokens: 330,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, messages: [{}, {}],
      },
    ]);
    const app = makeApp({ sessionManager: { listSessions } });
    const id = await seedOwner('Stats');

    const res = await app.request(`/api/v2/projects/${id}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.total_sessions).toBe(2);
    expect(body.total_input_tokens).toBe(400);
    expect(body.total_output_tokens).toBe(40);
    expect(body.total_tokens).toBe(440);
    expect(body.total_cache_read_tokens).toBe(5);
    expect(body.total_cache_write_tokens).toBe(1);
    expect(body.total_reasoning_tokens).toBe(2);
    expect(body.total_messages).toBe(3);
    expect(listSessions).toHaveBeenCalledWith({ projectId: id });

    expect((await app.request('/api/v2/projects/nope/stats')).status).toBe(404);
  });

  it('sessionManager не задан → /:id/stats не регистрируется (404)', async () => {
    const app = makeApp({});
    const id = await seedOwner('NoStats');
    expect((await app.request(`/api/v2/projects/${id}/stats`)).status).toBe(404);
  });

  it('getMcpServers: GET/PUT /:id/mcp, RBAC через canManage, неизвестный сервер → 400', async () => {
    const app = makeApp({ ...ownerRbac(), getMcpServers: () => ['srvA', 'srvB'] });
    const id = await seedOwner('MCP');

    const denied = await app.request(`/api/v2/projects/${id}/mcp`, { headers: header('other') });
    expect(denied.status).toBe(403);

    const get = await app.request(`/api/v2/projects/${id}/mcp`, { headers: header('owner') });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ enabled: [], defaultOn: [], knownServers: ['srvA', 'srvB'] });

    const put = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT', headers: header('owner'),
      body: JSON.stringify({ enabled: ['srvA'], defaultOn: ['srvB'] }),
    });
    expect(put.status).toBe(200);
    expect((await store.load(id))!.mcp).toEqual({ enabled: ['srvA'], defaultOn: ['srvB'] });

    const unknown = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT', headers: header('owner'), body: JSON.stringify({ enabled: ['nope'] }),
    });
    expect(unknown.status).toBe(400);
    const unknownBody = await unknown.json() as { error: { code: string } };
    expect(unknownBody.error.code).toBe('VALIDATION_ERROR');
  });

  it('getMcpServers не задан → /:id/mcp не регистрируется (404)', async () => {
    const app = makeApp({});
    const id = await seedOwner('NoMcp');
    expect((await app.request(`/api/v2/projects/${id}/mcp`)).status).toBe(404);
  });

  it('messages: переопределённые тексты ошибок используются', async () => {
    const app = makeApp({
      messages: {
        nameRequired: () => 'CUSTOM_NAME',
        notFound: () => 'CUSTOM_NOT_FOUND',
        forbidden: () => 'CUSTOM_FORBIDDEN',
      },
      ...ownerRbac(),
    });

    const noName = await app.request('/api/v2/projects', {
      method: 'POST', headers: header('owner'), body: JSON.stringify({}),
    });
    expect(((await noName.json()) as { error: { message: string } }).error.message).toBe('CUSTOM_NAME');

    const missing = await app.request('/api/v2/projects/nope', { headers: header('owner') });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe('CUSTOM_NOT_FOUND');

    const id = await seedOwner();
    const forbidden = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('other'), body: JSON.stringify({ name: 'x' }),
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { message: string } }).error.message).toBe('CUSTOM_FORBIDDEN');
  });

  describe('autoProvisionWorkspace (managed)', () => {
    let workspacesRoot: string;

    beforeEach(async () => {
      workspacesRoot = join(tmpDir, 'workspaces');
      await mkdir(workspacesRoot, { recursive: true });
    });

    function makeManagedApp(): Hono {
      return makeApp({
        autoProvisionWorkspace: true,
        getWorkspacesRoot: () => workspacesRoot,
        getOutsideRootPolicy: () => 'deny',
      });
    }

    it('POST без workspace → авто-имя slug, каталог создан', async () => {
      const res = await makeManagedApp().request('/api/v2/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { workspace: string };
      expect(body.workspace).toBe('my-project');
      expect((await stat(join(workspacesRoot, 'my-project'))).isDirectory()).toBe(true);
    });

    it('POST авто-имя при коллизии проекта → base-2', async () => {
      const existing = store.create('Existing', 'local', { workspace: 'my-project' });
      await store.save(existing);

      const res = await makeManagedApp().request('/api/v2/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      const body = (await res.json()) as { workspace: string };
      expect(body.workspace).toBe('my-project-2');
    });

    it('POST абсолютный вне root → 403 deny', async () => {
      const res = await makeManagedApp().request('/api/v2/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Outside', workspace: join(tmpDir, 'outside') }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
    });

    it('POST явный traversal-путь → 403', async () => {
      const res = await makeManagedApp().request('/api/v2/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Traversal', workspace: '../escape' }),
      });
      expect(res.status).toBe(403);
    });

    it('POST абсолютный внутри root → относительный', async () => {
      const res = await makeManagedApp().request('/api/v2/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Abs', workspace: join(workspacesRoot, 'abs-in') }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { workspace: string }).workspace).toBe('abs-in');
    });

    it('PUT пустой workspace очищает без авто-имени', async () => {
      const project = store.create('P', 'local', { workspace: 'keep' });
      await store.save(project);

      const res = await makeManagedApp().request(`/api/v2/projects/${project.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '' }),
      });
      expect(res.status).toBe(200);
      expect((await store.load(project.id))!.workspace).toBeUndefined();
    });
  });
});

describe('Project API Routes (icon/color)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-meta-'));
    store = new ProjectStore({ dataDir: tmpDir });
    app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST сохраняет валидные icon/color', async () => {
    const res = await app.request('/api/v2/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', icon: 'rocket', color: 'primary' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; icon: string | null; color: string | null };
    expect(body.icon).toBe('rocket');
    expect(body.color).toBe('primary');
    expect((await store.load(body.id))!.icon).toBe('rocket');
  });

  it('POST невалидный icon → 400 VALIDATION_ERROR с перечнем допустимых ключей', async () => {
    const res = await app.request('/api/v2/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', icon: '🚀' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('code');
  });

  it('POST невалидный color (алиас blue при записи не принимается) → 400', async () => {
    const res = await app.request('/api/v2/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', color: 'blue' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT обновляет icon/color и сбрасывает через null', async () => {
    const project = store.create('P', 'local', { icon: 'rocket', color: 'primary' });
    await store.save(project);

    const put = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon: 'heart', color: 'error' }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { icon: string | null; color: string | null };
    expect(body.icon).toBe('heart');
    expect(body.color).toBe('error');

    const reset = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon: null }),
    });
    expect(reset.status).toBe(200);
    expect((await store.load(project.id))!.icon).toBeUndefined();
  });

  it('PUT невалидный color → 400, проект не меняется', async () => {
    const project = store.create('P', 'local', { color: 'primary' });
    await store.save(project);
    const res = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: 'magenta' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(project.id))!.color).toBe('primary');
  });
});
