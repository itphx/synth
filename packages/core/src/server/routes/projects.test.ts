import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectRoutes } from './projects.js';
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
