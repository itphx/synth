import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createGitRoutes } from './git.js';
import type { GitRoutesOptions } from './git.js';
import { ProjectStore } from '../../storage/project-store.js';

const passAuth: MiddlewareHandler = async (_c, next) => { await next(); };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Bare-репозиторий с одним коммитом в `main`. */
async function createBareRepo(base: string): Promise<string> {
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  const g = simpleGit();
  await g.raw(['init', '--bare', '--initial-branch=main', bare]);
  await g.clone(bare, work);
  const wg = simpleGit(work);
  await wg.addConfig('user.email', 'test@example.com');
  await wg.addConfig('user.name', 'Test');
  await writeFile(join(work, 'README.md'), 'hello\n');
  await wg.add('.');
  await wg.commit('initial');
  await wg.push('origin', 'main');
  return bare;
}

describe('Git API Routes (AD-076 §T3)', () => {
  let root: string;
  let dataDir: string;
  let workspacesRoot: string;
  let projectId: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-routes-'));
    dataDir = join(root, 'data');
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'proj'), { recursive: true });
    projectStore = new ProjectStore({ dataDir });
    const project = projectStore.create('Demo', 'owner', { workspace: 'proj' });
    projectId = project.id;
    await projectStore.save(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeApp(opts?: GitRoutesOptions) {
    const app = new Hono();
    app.route('/api/v2/git', createGitRoutes({ requireAuth: passAuth }, projectStore, workspacesRoot, opts));
    return app;
  }

  function post(app: Hono, path: string, body: unknown) {
    return app.request(`/api/v2/git${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('clone регистрирует запись в project.repos (201)', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    const res = await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });
    expect(res.status).toBe(201);
    const repo = await res.json() as { path: string; isRepo: boolean };
    expect(repo).toMatchObject({ path: 'app', isRepo: true });

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(1);
    expect(saved?.repos?.[0]).toMatchObject({ path: 'app', url: `file://${bare}`, type: 'https' });
    expect(saved?.repos?.[0]?.id).toBeTruthy();
    expect(saved?.repos?.[0]?.lastFetch).toBeTruthy();
  });

  it('init создаёт репозиторий и регистрирует запись', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/init', { projectId, path: 'repos/app', defaultBranch: 'main' });
    expect(res.status).toBe(201);

    const saved = await projectStore.load(projectId);
    expect(saved?.repos?.[0]).toMatchObject({ path: 'repos/app', defaultBranch: 'main' });
    expect(saved?.repos?.[0]?.id).toBeTruthy();
  });

  it('register идемпотентен по path', async () => {
    const app = makeApp();
    const first = await post(app, '/repos/register', { projectId, path: 'vendor/lib', url: 'https://example.com/lib.git' });
    expect(first.status).toBe(200);
    const firstEntry = await first.json() as { id: string };
    expect(firstEntry.id).toBeTruthy();

    const second = await post(app, '/repos/register', { projectId, path: 'vendor/lib' });
    expect(second.status).toBe(200);
    const secondEntry = await second.json() as { id: string; url?: string };
    expect(secondEntry.id).toBe(firstEntry.id);
    // url не затирается, если новый не задан.
    expect(secondEntry.url).toBe('https://example.com/lib.git');

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(1);
  });

  it('remove с deleteLocal удаляет каталог и запись', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });
    expect(await exists(join(workspacesRoot, 'proj', 'app'))).toBe(true);

    const res = await post(app, '/repos/remove', { projectId, path: 'app', deleteLocal: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { deletedLocal: boolean; removed: { path: string } };
    expect(body.deletedLocal).toBe(true);
    expect(body.removed.path).toBe('app');
    expect(await exists(join(workspacesRoot, 'proj', 'app'))).toBe(false);

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(0);
  });

  it('SSH-url без ключа → 400 git.ssh_key_required', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/clone', { projectId, url: 'git@github.com:org/repo.git', path: 'sshrepo' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.ssh_key_required');
  });

  it('authorizeProject → false → 403', async () => {
    const app = makeApp({ authorizeProject: async () => false });
    const res = await post(app, '/repos/register', { projectId, path: 'x' });
    expect(res.status).toBe(403);
  });

  it('scan находит склонированный репозиторий', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });

    const res = await post(app, '/scan', { projectId });
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: Array<{ path: string }> };
    expect(body.repos.map((r) => r.path)).toContain('app');
  });

  it('path вне workspace → 400 git.repo_path_invalid', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/register', { projectId, path: '../outside' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.repo_path_invalid');
  });
});
