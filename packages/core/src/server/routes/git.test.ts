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

describe('Git API Routes (ADR-076 §T3)', () => {
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

  it('read-роуты: authorizeRead → false → 403 (граничный guard, ADR-089)', async () => {
    const app = makeApp({ authorizeRead: async () => false });
    for (const res of [
      await post(app, '/scan', { projectId }),
      await app.request(`/api/v2/git/log?project_id=${projectId}`),
      await app.request(`/api/v2/git/commit?project_id=${projectId}&hash=abc`),
    ]) {
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { error: string; code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.error).toMatch(/Доступ к проекту запрещён/);
    }
  });

  it('read-роуты: authorizeRead → true → доступ разрешён (прав на запись не требуется)', async () => {
    const app = makeApp({
      authorizeRead: async () => true,
      authorizeProject: async () => false,
    });
    expect((await post(app, '/scan', { projectId })).status).toBe(200);
    // log/commit по не-git workspace → 404 (legacy NOT_FOUND), а не 403.
    expect((await app.request(`/api/v2/git/log?project_id=${projectId}`)).status).toBe(404);
    expect((await app.request(`/api/v2/git/commit?project_id=${projectId}&hash=abc`)).status).toBe(404);
  });

  it('read-роуты без authorizeRead → используется authorizeProject (строже, fail-closed)', async () => {
    const denied = makeApp({ authorizeProject: async () => false });
    expect((await post(denied, '/scan', { projectId })).status).toBe(403);
    expect((await denied.request(`/api/v2/git/log?project_id=${projectId}`)).status).toBe(403);

    const allowed = makeApp({ authorizeProject: async () => true });
    expect((await post(allowed, '/scan', { projectId })).status).toBe(200);
  });

  it('без guard-опций проверки нет (standalone: один пользователь инстанса)', async () => {
    const app = makeApp();
    expect((await post(app, '/scan', { projectId })).status).toBe(200);
    expect((await app.request(`/api/v2/git/log?project_id=${projectId}`)).status).toBe(404);
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

/**
 * IDOR (security-фикс 0.11.3, регресс): граничный guard и обработчик должны
 * разрешать ОДИН И ТОТ ЖЕ id проекта.
 *
 * Раньше guard брал id из query (`project_id`), а обработчик — из тела
 * (`projectId`): `POST /git/scan?project_id=<свой>` с телом
 * `{"projectId":"<чужой>"}` проходил проверку доступа по СВОЕМУ проекту, а
 * обработчик читал (и менял) ЧУЖОЙ. Теперь id резолвится один раз (в guard'е),
 * кладётся в контекст, а обработчик берёт id ТОЛЬКО оттуда.
 */
describe('Git API Routes: единый источник id проекта (IDOR)', () => {
  let root: string;
  let dataDir: string;
  let workspacesRoot: string;
  let ownProjectId: string;
  let foreignProjectId: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-idor-'));
    dataDir = join(root, 'data');
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'own'), { recursive: true });
    await mkdir(join(workspacesRoot, 'foreign'), { recursive: true });
    projectStore = new ProjectStore({ dataDir });
    const own = projectStore.create('Own', 'caller', { workspace: 'own' });
    const foreign = projectStore.create('Foreign', 'stranger', { workspace: 'foreign' });
    ownProjectId = own.id;
    foreignProjectId = foreign.id;
    await projectStore.save(own);
    await projectStore.save(foreign);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Доступ есть только к СВОЕМУ проекту (эмуляция backend RBAC). */
  function makeApp() {
    const app = new Hono();
    const allowed = async (_c: unknown, id: string) => id === ownProjectId;
    app.route('/api/v2/git', createGitRoutes(
      { requireAuth: passAuth },
      projectStore,
      workspacesRoot,
      { authorizeProject: allowed, authorizeRead: allowed },
    ));
    return app;
  }

  function post(app: Hono, path: string, body: unknown, query?: string) {
    return app.request(`/api/v2/git${path}${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('read-роут: query-проект и проект из тела различаются → 403, чужой проект не тронут', async () => {
    const app = makeApp();
    const res = await post(app, '/scan', { projectId: foreignProjectId }, `project_id=${ownProjectId}`);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { error: string; code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.error).toMatch(/Доступ к проекту запрещён/);
    // Чужой проект не изменён (scan ничего не пишет — реестр пуст).
    expect((await projectStore.load(foreignProjectId))?.repos ?? []).toHaveLength(0);
  });

  it('write-роуты: query-проект и проект из тела различаются → 403, чужой проект НЕ изменён', async () => {
    const app = makeApp();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['/repos/register', { path: 'vendor/lib' }],
      ['/repos/init', { path: 'repo' }],
      ['/repos/clone', { url: 'https://example.com/x.git', path: 'x' }],
      ['/repos/remove', { path: 'vendor/lib' }],
      ['/repos/fetch', { path: 'vendor/lib' }],
    ];
    for (const [path, extra] of cases) {
      const res = await post(app, path, { projectId: foreignProjectId, ...extra }, `project_id=${ownProjectId}`);
      expect(res.status, path).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code, path).toBe('FORBIDDEN');
      // Реестр ЧУЖОГО проекта не тронут (иначе guard и обработчик разошлись).
      expect((await projectStore.load(foreignProjectId))?.repos ?? [], path).toHaveLength(0);
      // И СВОЙ проект не тронут — запрос отклонён целиком.
      expect((await projectStore.load(ownProjectId))?.repos ?? [], path).toHaveLength(0);
    }
  });

  it('write-роут: id только в теле (без query) — работает, guard проверяет именно его', async () => {
    const app = makeApp();
    const checked: string[] = [];
    const app2 = new Hono();
    app2.route('/api/v2/git', createGitRoutes(
      { requireAuth: passAuth },
      projectStore,
      workspacesRoot,
      {
        authorizeProject: async (_c, id) => { checked.push(id); return id === ownProjectId; },
      },
    ));
    const res = await post(app2, '/repos/register', { projectId: ownProjectId, path: 'vendor/lib' });
    expect(res.status).toBe(200);
    // Guard разрешил id ИЗ ТЕЛА — обработчик работал с тем же id.
    expect(checked).toEqual([ownProjectId]);
    expect((await projectStore.load(ownProjectId))?.repos).toHaveLength(1);
    expect(app).toBeDefined();
  });

  it('совпадающие query и тело → запрос обрабатывается (id один и тот же)', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/register', { projectId: ownProjectId, path: 'vendor/lib' }, `project_id=${ownProjectId}`);
    expect(res.status).toBe(200);
    expect((await projectStore.load(ownProjectId))?.repos).toHaveLength(1);
  });

  it('id не извлечётся (нет ни в query, ни в теле) → 400, проект не задет', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/register', { path: 'vendor/lib' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect((await projectStore.load(ownProjectId))?.repos ?? []).toHaveLength(0);
  });
});
