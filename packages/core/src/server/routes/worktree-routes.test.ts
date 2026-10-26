/**
 * HTTP-контур worktree'ов проекта (ADR-114 §5–§7, этап 1 roadmap 0.13 —
 * блок 1.4.2b).
 *
 * Проверяется фабрика `createProjectRoutes` (core) с **настоящим**
 * `WorktreeService` (memory-порт инвентаря + временный git-репозиторий) и
 * фейковыми `canRead`/`canEditContent`:
 *
 * - `GET /:id/worktrees` → `200 { worktrees: [...] }` (сводки с вычисленными
 *   полями `exists`/`dirty`/`attachedSessionId`);
 * - `POST /:id/worktrees` → `201 { worktree: {...} }`; невалидное имя/ветка →
 *   `400` с машинным кодом;
 * - `DELETE /:id/worktrees/:wid` → `204`; неизвестный id → `404`; грязный
 *   worktree → `409` + `error.forceRequired === true`; `?force=true` → `204`;
 * - `POST /:id/worktrees/prune` → `200 { recordsRemoved, gitPruned }`;
 * - права: `canRead=false` → 403 на GET; `canEditContent=false` → 403 на
 *   POST/DELETE/prune.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectRoutes } from './projects.js';
import { ProjectStore } from '../../storage/project-store.js';
import { WorktreeService } from '../../engine/worktree/service.js';
import { MemoryWorktreeRepository } from '../../storage/memory/worktrees.js';
import type { WorktreeRepository } from '../../storage/ports/worktree-repository.js';
import type { AuthKit } from '../../auth/local.js';

const execFileAsync = promisify(execFile);

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Прямой запуск git в тесте (подготовка репозитория). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepoAt(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '--initial-branch', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Тест']);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await git(dir, ['add', '--', 'README.md']);
  await git(dir, ['commit', '-m', 'initial']);
}

describe('HTTP: /api/v2/projects/:id/worktrees* (ADR-114)', () => {
  let root: string;
  let workspacesRoot: string;
  let projectDir: string;
  let store: ProjectStore;
  let repository: WorktreeRepository;
  let service: WorktreeService;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-worktree-routes-'));
    workspacesRoot = join(root, 'workspaces');
    projectDir = join(workspacesRoot, 'projects', 'prj-1');
    await initRepoAt(projectDir);

    store = new ProjectStore({ dataDir: join(root, 'data') });
    repository = new MemoryWorktreeRepository();
    service = new WorktreeService({
      repository,
      workspacesRoot,
      defaultWorkingDir: projectDir,
    });

    const project = store.create('Worktrees', 'owner', { workspace: projectDir });
    await store.save(project);
    projectId = project.id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** userId из заголовка `Authorization: Bearer <user>`. */
  function userId(c: Context): string {
    return /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '';
  }

  /** RBAC-хуки: владелец проекта — `owner`; `canRead`/`canEditContent` — по флажкам. */
  function makeApp(opts: { read?: boolean; edit?: boolean } = {}): Hono {
    const read = opts.read ?? true;
    const edit = opts.edit ?? true;
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      getCurrentUserId: userId,
      canRead: (_c, project, uid) => read && project.ownerId === uid,
      canEditContent: (_c, project, uid) => edit && project.ownerId === uid,
      worktrees: service,
    }));
    return app;
  }

  function header(user = 'owner'): Record<string, string> {
    return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
  }

  /** Создать worktree через HTTP (владельцем). */
  async function createWorktree(app: Hono, body: Record<string, unknown> = { branch: 'feature/x' }): Promise<{
    id: string;
    directory: string;
    name: string;
    branch: string;
  }> {
    const res = await app.request(`/api/v2/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: header(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as { worktree: { id: string; directory: string; name: string; branch: string } };
    return parsed.worktree;
  }

  it('GET /:id/worktrees → 200 { worktrees: [...] } (пустой инвентарь)', async () => {
    const res = await makeApp().request(`/api/v2/projects/${projectId}/worktrees`, { headers: header() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { worktrees: unknown[] };
    expect(Array.isArray(body.worktrees)).toBe(true);
    expect(body.worktrees).toHaveLength(0);
  });

  it('GET /:id/worktrees → запись с branch/dirty/exists', async () => {
    const app = makeApp();
    const created = await createWorktree(app);

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees`, { headers: header() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worktrees: Array<Record<string, unknown>>;
    };
    expect(body.worktrees).toHaveLength(1);
    const item = body.worktrees[0]!;
    expect(item.id).toBe(created.id);
    expect(item.branch).toBe('feature/x');
    expect(item.name).toBe(created.name);
    expect(item.dirty).toBe(false);
    expect(item.exists).toBe(true);
    expect(item.projectId).toBe(projectId);
  });

  it('POST /:id/worktrees → 201 { worktree: {...} }', async () => {
    const res = await makeApp().request(`/api/v2/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: header(),
      body: JSON.stringify({ branch: 'feature/x', name: 'wt' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { worktree: Record<string, unknown> };
    expect(body.worktree.id).toMatch(/^wkt_/);
    expect(body.worktree.branch).toBe('feature/x');
    expect(body.worktree.name).toBe('wt');
    expect(body.worktree.projectId).toBe(projectId);
    expect(body.worktree.createdBy).toBe('owner');
  });

  it('POST /:id/worktrees — невалидное имя → 400 с машинным кодом', async () => {
    const res = await makeApp().request(`/api/v2/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: header(),
      body: JSON.stringify({ name: 'Bad Name' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /:id/worktrees — невалидная ветка → 400 с машинным кодом', async () => {
    const res = await makeApp().request(`/api/v2/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: header(),
      body: JSON.stringify({ branch: 'bad branch' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE /:id/worktrees/:wid → 204', async () => {
    const app = makeApp();
    const created = await createWorktree(app);

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees/${created.id}`, {
      method: 'DELETE',
      headers: header(),
    });

    expect(res.status).toBe(204);
    expect(await repository.get(created.id)).toBeNull();
  });

  it('DELETE /:id/worktrees/:wid — неизвестный id → 404', async () => {
    const res = await makeApp().request(`/api/v2/projects/${projectId}/worktrees/wkt-none`, {
      method: 'DELETE',
      headers: header(),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKTREE_NOT_FOUND');
  });

  it('DELETE /:id/worktrees/:wid — worktree чужого проекта → 404 (изоляция проектов)', async () => {
    const app = makeApp();
    const other = store.create('Other', 'owner', { workspace: projectDir });
    await store.save(other);
    const foreign = await service.create(other.id, other, { branch: 'feature/foreign', name: 'foreign' });

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees/${foreign.worktree.id}`, {
      method: 'DELETE',
      headers: header(),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKTREE_NOT_FOUND');
    // Чужая запись на месте.
    expect(await repository.get(foreign.worktree.id)).not.toBeNull();
  });

  it('DELETE /:id/worktrees/:wid — грязный worktree → 409 + error.forceRequired', async () => {
    const app = makeApp();
    const created = await createWorktree(app);
    await writeFile(join(created.directory, 'README.md'), 'changed\n');

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees/${created.id}`, {
      method: 'DELETE',
      headers: header(),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; forceRequired?: boolean } };
    expect(body.error.code).toBe('WORKTREE_DIRTY');
    expect(body.error.forceRequired).toBe(true);
    // Запись на месте — ничего не потеряно.
    expect(await repository.get(created.id)).not.toBeNull();
  });

  it('DELETE /:id/worktrees/:wid?force=true — грязный worktree удаляется (204)', async () => {
    const app = makeApp();
    const created = await createWorktree(app);
    await writeFile(join(created.directory, 'README.md'), 'changed\n');

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees/${created.id}?force=true`, {
      method: 'DELETE',
      headers: header(),
    });

    expect(res.status).toBe(204);
    expect(await repository.get(created.id)).toBeNull();
  });

  it('POST /:id/worktrees/prune → 200 { recordsRemoved, gitPruned }', async () => {
    const app = makeApp();
    const alive = await createWorktree(app, { branch: 'feature/alive', name: 'alive' });
    const orphan = await createWorktree(app, { branch: 'feature/orphan', name: 'orphan' });
    await rm(orphan.directory, { recursive: true, force: true });

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees/prune`, {
      method: 'POST',
      headers: header(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { recordsRemoved: number; gitPruned: boolean };
    expect(body.recordsRemoved).toBe(1);
    expect(body.gitPruned).toBe(true);
    expect(await repository.get(alive.id)).not.toBeNull();
    expect(await repository.get(orphan.id)).toBeNull();
  });

  it('неизвестный проект → 404 на всех маршрутах worktrees', async () => {
    const app = makeApp();
    const get = await app.request('/api/v2/projects/nope/worktrees', { headers: header() });
    expect(get.status).toBe(404);

    const post = await app.request('/api/v2/projects/nope/worktrees', {
      method: 'POST', headers: header(), body: JSON.stringify({ branch: 'feature/x' }),
    });
    expect(post.status).toBe(404);

    const del = await app.request('/api/v2/projects/nope/worktrees/wkt-1', {
      method: 'DELETE', headers: header(),
    });
    expect(del.status).toBe(404);
  });

  describe('права (инвариант 21)', () => {
    it('canRead=false → 403 на GET', async () => {
      const res = await makeApp({ read: false }).request(`/api/v2/projects/${projectId}/worktrees`, {
        headers: header(),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('canEditContent=false → 403 на POST/DELETE/prune', async () => {
      const app = makeApp({ edit: false });

      const post = await app.request(`/api/v2/projects/${projectId}/worktrees`, {
        method: 'POST', headers: header(), body: JSON.stringify({ branch: 'feature/x' }),
      });
      expect(post.status).toBe(403);

      const del = await app.request(`/api/v2/projects/${projectId}/worktrees/wkt-1`, {
        method: 'DELETE', headers: header(),
      });
      expect(del.status).toBe(403);

      const prune = await app.request(`/api/v2/projects/${projectId}/worktrees/prune`, {
        method: 'POST', headers: header(),
      });
      expect(prune.status).toBe(403);
    });

    it('чужой пользователь → 403 на GET и на мутации', async () => {
      const app = makeApp();

      const get = await app.request(`/api/v2/projects/${projectId}/worktrees`, { headers: header('other') });
      expect(get.status).toBe(403);

      const post = await app.request(`/api/v2/projects/${projectId}/worktrees`, {
        method: 'POST', headers: header('other'), body: JSON.stringify({ branch: 'feature/x' }),
      });
      expect(post.status).toBe(403);
    });
  });

  it('сервис не передан → маршруты worktrees не регистрируются (404)', async () => {
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store));

    const res = await app.request(`/api/v2/projects/${projectId}/worktrees`, { headers: header() });
    expect(res.status).toBe(404);
  });
});
