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
import { ProjectRole } from '@itphx/synth-shared';

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

describe('Project API Routes (workspace provisioning, ADR-075)', () => {
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

  it('canEditContent: память проекта (project.memory.enabled) — владелец, 400/403', async () => {
    const app = makeApp(ownerRbac());
    const id = await seedOwner();

    const off = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('owner'), body: JSON.stringify({ memory: { enabled: false } }),
    });
    expect(off.status).toBe(200);
    expect((await store.load(id))!.memory).toEqual({ enabled: false });

    const on = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('owner'), body: JSON.stringify({ memory: { enabled: true } }),
    });
    expect(on.status).toBe(200);
    expect((await store.load(id))!.memory).toEqual({ enabled: true });

    const denied = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('other'), body: JSON.stringify({ memory: { enabled: false } }),
    });
    expect(denied.status).toBe(403);
    expect((await store.load(id))!.memory).toEqual({ enabled: true });

    const invalid = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT', headers: header('owner'), body: JSON.stringify({ memory: { enabled: 'нет' } }),
    });
    expect(invalid.status).toBe(400);
    expect((await store.load(id))!.memory).toEqual({ enabled: true });
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

  it('sessionManager: GET /:id/stats агрегирует токены, 404 для чужого id', async () => {
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
    // Счётчик сообщений проекта удалён: список сессий всегда лёгкий (без истории),
    // а ложный «0» в ответе вводил бы в заблуждение.
    expect('total_messages' in body).toBe(false);
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
    // PROP-125: `sources` — источник каждого сервера (`local`/`server`); без
    // опции `getMcpServerSources` карта пуста.
    expect(await get.json()).toEqual({
      enabled: [], defaultOn: [], knownServers: ['srvA', 'srvB'], sources: {},
    });

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

  it('PROP-125: getMcpServerSources → sources в GET/PUT /:id/mcp', async () => {
    const app = makeApp({
      ...ownerRbac(),
      getMcpServers: () => ['srvA', 'srvB'],
      getMcpServerSources: () => ({ srvA: 'local', srvB: 'server' }),
    });
    const id = await seedOwner('Sources');

    const get = await app.request(`/api/v2/projects/${id}/mcp`, { headers: header('owner') });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      enabled: [],
      defaultOn: [],
      knownServers: ['srvA', 'srvB'],
      sources: { srvA: 'local', srvB: 'server' },
    });

    const put = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT', headers: header('owner'),
      body: JSON.stringify({ enabled: ['srvB'] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { sources: Record<string, string> }).sources)
      .toEqual({ srvA: 'local', srvB: 'server' });
  });

  it('PROP-125: без getMcpServerSources → sources пустой (контракт ответа единый)', async () => {
    const app = makeApp({ ...ownerRbac(), getMcpServers: () => ['srvA'] });
    const id = await seedOwner('NoSources');

    const get = await app.request(`/api/v2/projects/${id}/mcp`, { headers: header('owner') });
    expect(get.status).toBe(200);
    expect((await get.json() as { sources: Record<string, string> }).sources).toEqual({});

    const put = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT', headers: header('owner'),
      body: JSON.stringify({ enabled: ['srvA'] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { sources: Record<string, string> }).sources).toEqual({});
  });

  it('PROP-125: remote-ветка отдаёт ответ сервера как есть (sources локально не добавляются)', async () => {
    const remoteClient = {
      getProjectMcp: vi.fn().mockResolvedValue({
        enabled: ['srvR'], defaultOn: ['srvR'], knownServers: ['srvR'],
      }),
      updateProjectMcp: vi.fn().mockResolvedValue({
        enabled: [], defaultOn: [], knownServers: ['srvR'],
      }),
    };
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(
      createMockAuth(),
      store,
      () => remoteClient as never,
      {
        ...ownerRbac(),
        getMcpServers: () => ['srvA'],
        getMcpServerSources: () => ({ srvA: 'local' }),
      },
    ));

    const get = await app.request('/api/v2/projects/remote:abc/mcp', { headers: header('owner') });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      enabled: ['srvR'], defaultOn: ['srvR'], knownServers: ['srvR'],
    });
    expect(remoteClient.getProjectMcp).toHaveBeenCalledWith('abc');

    const put = await app.request('/api/v2/projects/remote:abc/mcp', {
      method: 'PUT', headers: header('owner'),
      body: JSON.stringify({ enabled: ['srvR'] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      enabled: [], defaultOn: [], knownServers: ['srvR'],
    });
    expect(remoteClient.updateProjectMcp).toHaveBeenCalledWith('abc', { enabled: ['srvR'] });
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
      body: JSON.stringify({ name: 'P', icon: 'rocket', color: 'a11' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; icon: string | null; color: string | null };
    expect(body.icon).toBe('rocket');
    expect(body.color).toBe('a11');
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
    const project = store.create('P', 'local', { icon: 'rocket', color: 'a11' });
    await store.save(project);

    const put = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon: 'heart', color: 'a1' }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { icon: string | null; color: string | null };
    expect(body.icon).toBe('heart');
    expect(body.color).toBe('a1');

    const reset = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon: null }),
    });
    expect(reset.status).toBe(200);
    expect((await store.load(project.id))!.icon).toBeUndefined();
  });

  it('PUT невалидный color → 400, проект не меняется', async () => {
    const project = store.create('P', 'local', { color: 'a11' });
    await store.save(project);
    const res = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: 'magenta' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(project.id))!.color).toBe('a11');
  });
});

// ---------------------------------------------------------------------------
// ADR-089: видимость проектов (elevated) и read-уровень доступа по id
// ---------------------------------------------------------------------------

describe('Project API Routes (visibility, ADR-089)', () => {
  let tmpDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-vis-'));
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

  it('GET / elevated → все проекты, иначе только проекты пользователя', async () => {
    const ownerProject = store.create('OwnerP', 'alice');
    const otherProject = store.create('OtherP', 'bob');
    await store.save(ownerProject);
    await store.save(otherProject);

    const userId = (c: Context) => /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '';
    const plain = makeApp({
      getCurrentUserId: userId,
      resolveElevated: (c) => c.req.header('X-Elevated') === '1',
    });

    const asAlice = await plain.request('/api/v2/projects', { headers: header('alice') });
    expect(((await asAlice.json()) as { projects: any[] }).projects.map((p: any) => p.name)).toEqual(['OwnerP']);

    const asLead = await plain.request('/api/v2/projects', {
      headers: { ...header('lead'), 'X-Elevated': '1' },
    });
    expect(((await asLead.json()) as { projects: any[] }).projects).toHaveLength(2);
  });

  it('GET /:id — участник (VIEWER) читает проект, посторонний → 403', async () => {
    const project = store.create('P', 'owner');
    project.members['member'] = ProjectRole.VIEWER;
    await store.save(project);

    // canRead — как в backend: owner / любой участник. Мутации не расширяем.
    const app = makeApp({
      getCurrentUserId: (c) => /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '',
      canRead: (_c, p, userId) => p.ownerId === userId || userId in (p.members ?? {}),
      canManage: (_c, p, userId) => p.ownerId === userId,
      canEditContent: (_c, p, userId) => p.ownerId === userId,
    });

    const asMember = await app.request(`/api/v2/projects/${project.id}`, { headers: header('member') });
    expect(asMember.status).toBe(200);

    const asOutsider = await app.request(`/api/v2/projects/${project.id}`, { headers: header('outsider') });
    expect(asOutsider.status).toBe(403);

    // VIEWER читает, но не редактирует (read-предикат не расширяет manage/edit).
    const editByViewer = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT', headers: header('member'), body: JSON.stringify({ name: 'X' }),
    });
    expect(editByViewer.status).toBe(403);
  });

  it('GET /:id без canRead (standalone) — доступ разрешён', async () => {
    const project = store.create('P', 'owner');
    await store.save(project);
    const app = makeApp({});
    const res = await app.request(`/api/v2/projects/${project.id}`);
    expect(res.status).toBe(200);
  });
});

describe('Project API Routes — события изменения проекта (ADR-118 §4)', () => {
  let tmpDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-events-'));
    store = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('PUT /:id вызывает onProjectChanged(projectId, updated) после сохранения', async () => {
    const changes: Array<{ projectId: string; kind: string }> = [];
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      onProjectChanged: (projectId, kind) => { changes.push({ projectId, kind }); },
    }));

    const created = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    const project = (await created.json()) as { id: string };

    const res = await app.request(`/api/v2/projects/${project.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P2' }),
    });
    expect(res.status).toBe(200);
    expect(changes).toEqual([{ projectId: project.id, kind: 'updated' }]);
  });

  it('DELETE /:id вызывает onProjectChanged(projectId, deleted) ДО удаления', async () => {
    const observed: Array<{ projectId: string; kind: string; stillExists: boolean }> = [];
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      onProjectChanged: async (projectId, kind) => {
        observed.push({ projectId, kind, stillExists: (await store.load(projectId)) !== null });
      },
    }));

    const created = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    const project = (await created.json()) as { id: string };

    const res = await app.request(`/api/v2/projects/${project.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(observed).toEqual([{ projectId: project.id, kind: 'deleted', stillExists: true }]);
    expect(await store.load(project.id)).toBeNull();
  });
});

/**
 * PROP-135 Ф6a: профиль исполнения проекта (`PUT /:id { executor }`).
 *
 * Изменение — право управления проектом (owner/LEAD/ADMIN, как `workspace`),
 * а не редактирования контента (EDITOR не может). При доступном каталоге
 * профили проверяются на существование (`400 VALIDATION_ERROR`); `null`/`''`/
 * `[]` сбрасывают значение, пустой allowlist = без ограничения.
 */
describe('Project API Routes — executor profile (PROP-135 Ф6a)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let app: Hono;
  let currentUserId: string;

  const catalog = { profiles: ['default', 'devops', 'sandbox'], defaultProfile: 'default' };

  function makeApp(optsCatalog?: { profiles: string[]; defaultProfile: string }): Hono {
    const local = new Hono();
    local.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      getCurrentUserId: () => currentUserId,
      // owner проекта/глобальные LEAD/ADMIN — управление; EDITOR — контент.
      canManage: (_c, project, userId) => project.ownerId === userId || userId === 'lead',
      canEditContent: (_c, project, userId) =>
        project.ownerId === userId || userId === 'lead' || project.members[userId] === ProjectRole.EDITOR,
      ...(optsCatalog ? { executionProfileCatalog: optsCatalog } : {}),
    }));
    return local;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-executor-'));
    store = new ProjectStore({ dataDir: tmpDir });
    currentUserId = 'owner';
    app = makeApp(catalog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createProject(): Promise<string> {
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function putExecutor(id: string, executor: unknown): Promise<Response> {
    return app.request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executor }),
    });
  }

  it('PUT executor сохраняет профиль и потолок; DTO отдаёт executor', async () => {
    const id = await createProject();
    const res = await putExecutor(id, { profile: 'devops', allowedProfiles: ['devops', 'sandbox'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executor: { profile?: string; allowedProfiles?: string[] } };
    expect(body.executor).toEqual({ profile: 'devops', allowedProfiles: ['devops', 'sandbox'] });

    const stored = await store.load(id);
    expect(stored!.executor).toEqual({ profile: 'devops', allowedProfiles: ['devops', 'sandbox'] });
  });

  it('PUT executor: null сбрасывает потолок, [] — «профилей нет» (ADR-135)', async () => {
    const id = await createProject();
    await putExecutor(id, { profile: 'devops', allowedProfiles: ['devops'] });

    const res = await putExecutor(id, { profile: null, allowedProfiles: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executor: unknown };
    // Пустой список — «профилей нет» (fail-closed), а не сброс ограничения.
    expect(body.executor).toEqual({ allowedProfiles: [] });
    expect((await store.load(id))!.executor).toEqual({ allowedProfiles: [] });

    // `null` — сброс: потолок не задан.
    const reset = await putExecutor(id, { allowedProfiles: null });
    expect(reset.status).toBe(200);
    expect((await store.load(id))!.executor).toBeUndefined();
  });

  it('PUT executor: пустая строка профиля сбрасывает только профиль', async () => {
    const id = await createProject();
    await putExecutor(id, { profile: 'devops', allowedProfiles: ['devops'] });
    const res = await putExecutor(id, { profile: '' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executor: { profile?: string; allowedProfiles?: string[] } };
    expect(body.executor).toEqual({ allowedProfiles: ['devops'] });
  });

  it('профиль вне списка разрешённых → 400 (ADR-135: пустой список = ничего)', async () => {
    const id = await createProject();
    const outside = await putExecutor(id, { profile: 'devops', allowedProfiles: ['sandbox'] });
    expect(outside.status).toBe(400);
    const body = (await outside.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('должен входить в список разрешённых');
    expect((await store.load(id))!.executor).toBeUndefined();

    // Пустой список — профилей нет: профиль задать нельзя.
    const empty = await putExecutor(id, { profile: 'devops', allowedProfiles: [] });
    expect(empty.status).toBe(400);
    expect((await store.load(id))!.executor).toBeUndefined();
  });

  it('неизвестный профиль → 400 VALIDATION_ERROR (настройка не меняется)', async () => {
    const id = await createProject();
    const res = await putExecutor(id, { profile: 'ghost' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(id))!.executor).toBeUndefined();
  });

  it('неизвестный профиль в allowedProfiles → 400 VALIDATION_ERROR', async () => {
    const id = await createProject();
    const res = await putExecutor(id, { allowedProfiles: ['devops', 'ghost'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('EDITOR не может менять executor (403), но может контент', async () => {
    const id = await createProject();
    const project = (await store.load(id))!;
    project.members['editor'] = ProjectRole.EDITOR;
    await store.save(project);

    currentUserId = 'editor';
    expect((await putExecutor(id, { profile: 'devops' })).status).toBe(403);

    const content = await app.request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'changed' }),
    });
    expect(content.status).toBe(200);
  });

  it('owner может менять executor', async () => {
    const id = await createProject();
    currentUserId = 'owner';
    expect((await putExecutor(id, { profile: 'devops' })).status).toBe(200);
  });

  it('без каталога профилей проверка существования пропускается', async () => {
    app = makeApp(undefined);
    const id = await createProject();
    const res = await putExecutor(id, { profile: 'anything' });
    expect(res.status).toBe(200);
    expect((await store.load(id))!.executor).toEqual({ profile: 'anything' });
  });
});

/**
 * PROP-135 (браузерный контур): `executor.browserProfile` проекта и потолок
 * `allowedBrowserProfiles` — отдельный каталог (exec-имена не принимаются).
 */
describe('Project API Routes — executor browser profile (PROP-135)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let app: Hono;
  let currentUserId: string;

  const browserCatalog = { profiles: ['browser', 'browser-full'], defaultProfile: 'browser' };

  function makeApp(catalog?: { profiles: string[]; defaultProfile: string }): Hono {
    const local = new Hono();
    local.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      getCurrentUserId: () => currentUserId,
      canManage: (_c, project, userId) => project.ownerId === userId || userId === 'lead',
      canEditContent: (_c, project, userId) =>
        project.ownerId === userId || userId === 'lead' || project.members[userId] === ProjectRole.EDITOR,
      ...(catalog ? { browserProfileCatalog: catalog } : {}),
    }));
    return local;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-browser-'));
    store = new ProjectStore({ dataDir: tmpDir });
    currentUserId = 'owner';
    app = makeApp(browserCatalog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createProject(): Promise<string> {
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function putExecutor(id: string, executor: unknown): Promise<Response> {
    return app.request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executor }),
    });
  }

  it('сохраняет браузерный профиль и потолок; DTO отдаёт их', async () => {
    const id = await createProject();
    const res = await putExecutor(id, {
      browserProfile: 'browser-full',
      allowedBrowserProfiles: ['browser', 'browser-full'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      executor: { browserProfile?: string; allowedBrowserProfiles?: string[] };
    };
    expect(body.executor).toEqual({
      browserProfile: 'browser-full',
      allowedBrowserProfiles: ['browser', 'browser-full'],
    });
    expect((await store.load(id))!.executor).toEqual({
      browserProfile: 'browser-full',
      allowedBrowserProfiles: ['browser', 'browser-full'],
    });
  });

  it('сброс: null снимает части, [] — «профилей нет», пустая строка — только профиль', async () => {
    const id = await createProject();
    await putExecutor(id, {
      browserProfile: 'browser-full',
      allowedBrowserProfiles: ['browser-full'],
    });

    const resetOne = await putExecutor(id, { browserProfile: '' });
    expect(resetOne.status).toBe(200);
    expect((await store.load(id))!.executor).toEqual({
      allowedBrowserProfiles: ['browser-full'],
    });

    const reset = await putExecutor(id, { browserProfile: null, allowedBrowserProfiles: [] });
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { executor: unknown }).executor)
      .toEqual({ allowedBrowserProfiles: [] });

    const cleared = await putExecutor(id, { allowedBrowserProfiles: null });
    expect(cleared.status).toBe(200);
    expect((await store.load(id))!.executor).toBeUndefined();
  });

  it('неизвестный браузерный профиль → 400 «Профиль браузера не найден»', async () => {
    const id = await createProject();
    const res = await putExecutor(id, { browserProfile: 'ghost' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Профиль браузера не найден');
    expect((await store.load(id))!.executor).toBeUndefined();

    // exec-имя в браузерном контуре не принимается.
    expect((await putExecutor(id, { browserProfile: 'devops' })).status).toBe(400);
    expect(
      (await putExecutor(id, { allowedBrowserProfiles: ['browser', 'ghost'] })).status,
    ).toBe(400);
  });

  it('без каталога проверка пропускается', async () => {
    app = makeApp(undefined);
    const id = await createProject();
    const res = await putExecutor(id, { browserProfile: 'anything' });
    expect(res.status).toBe(200);
    expect((await store.load(id))!.executor).toEqual({ browserProfile: 'anything' });
  });
});
