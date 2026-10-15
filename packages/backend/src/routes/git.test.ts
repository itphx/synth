// ADR-076 §T4: backend монтирует core-фабрику git-роутов с managed-RBAC.
// Проверяем: non-editor → 403, owner/EDITOR/LEAD/ADMIN → запись разрешена,
// read-only (scan/log/commit) legacy-поведение не сломано.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRoutes } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { ProjectStore } from '@itphx/synth-core';
import { createProjectAccess } from './projects.js';
import type { AuthKit } from '../auth/middleware.js';

const exec = promisify(execFile);

const passAuth: MiddlewareHandler = async (_c, next) => {
  await next();
};

function makeUser(id: string, roles: User['roles']): User {
  return {
    id,
    username: id,
    roles,
    preferredLanguage: 'ru',
    createdAt: '',
    teamRole: 'USER',
    notes: '',
    interviewCompleted: false,
  };
}

/** Mock AuthKit: пользователь фиксирован, роли читаются из него (как attachUser+hasRole). */
function makeKit(user: User | null) {
  const hasRole = (_c: unknown, ...roles: string[]): boolean =>
    !!user && roles.some((role) => user.roles.includes(role as User['roles'][number]));
  return {
    requireAuth: passAuth,
    getCurrentUser: async (_c: Context): Promise<User | null> => user,
    isAdmin: (c: unknown): boolean => hasRole(c, 'ADMIN'),
    hasRole,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Bare-репозиторий с одним коммитом в `main` (через системный git, без внешних зависимостей). */
async function createBareRepo(base: string): Promise<string> {
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  await exec('git', ['init', '--bare', '--initial-branch=main', bare]);
  await exec('git', ['clone', bare, work]);
  await exec('git', ['-C', work, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', work, 'config', 'user.name', 'Test']);
  await writeFile(join(work, 'README.md'), 'hello\n');
  await exec('git', ['-C', work, 'add', '.']);
  await exec('git', ['-C', work, 'commit', '-m', 'initial']);
  await exec('git', ['-C', work, 'push', 'origin', 'main']);
  return bare;
}

describe('Git API Routes (ADR-076 §T4, backend)', () => {
  let root: string;
  let dataDir: string;
  let workspacesRoot: string;
  let projectId: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-backend-git-'));
    dataDir = join(root, 'data');
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'proj'), { recursive: true });
    projectStore = new ProjectStore({ dataDir });
    // owner — admin, чтобы отдельный developer (USER) был не-участником.
    const project = projectStore.create('Demo', 'admin', { workspace: 'proj' });
    projectId = project.id;
    await projectStore.save(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Монтирует core-фабрику так же, как `app.ts` (authorizeProject через createProjectAccess). */
  function makeApp(user: User | null) {
    const kit = makeKit(user);
    const access = createProjectAccess(kit as unknown as AuthKit);
    const auth = { requireAuth: passAuth };
    const app = new Hono();
    app.route('/api/v2/git', createGitRoutes(auth, projectStore, workspacesRoot, {
      authorizeProject: async (c, id) => {
        const current = await kit.getCurrentUser(c);
        if (!current) return false;
        const project = await projectStore.load(id);
        if (!project) return false;
        return access.canEditProjectContent(c, project, current.id);
      },
    }));
    return app;
  }

  function post(app: Hono, path: string, body: unknown) {
    return app.request(`/api/v2/git${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('non-editor (USER, не участник) → 403 на register и clone', async () => {
    const app = makeApp(makeUser('developer', ['USER']));
    const register = await post(app, '/repos/register', { projectId, path: 'vendor/lib' });
    expect(register.status).toBe(403);
    const clone = await post(app, '/repos/clone', { projectId, url: 'https://example.com/x.git', path: 'x' });
    expect(clone.status).toBe(403);
  });

  it('неаутентифицированный → 403', async () => {
    const app = makeApp(null);
    const res = await post(app, '/repos/register', { projectId, path: 'vendor/lib' });
    expect(res.status).toBe(403);
  });

  it('owner (без глобальной роли) может register', async () => {
    const project = (await projectStore.load(projectId))!;
    project.ownerId = 'developer';
    project.members = { developer: ProjectRole.OWNER };
    await projectStore.save(project);

    const app = makeApp(makeUser('developer', ['USER']));
    const res = await post(app, '/repos/register', { projectId, path: 'vendor/lib', url: 'https://example.com/lib.git' });
    expect(res.status).toBe(200);
    const saved = await projectStore.load(projectId);
    expect(saved?.repos?.[0]).toMatchObject({ path: 'vendor/lib' });
  });

  it('EDITOR-участник может register', async () => {
    const project = (await projectStore.load(projectId))!;
    project.members = { ...project.members, developer: ProjectRole.EDITOR };
    await projectStore.save(project);

    const app = makeApp(makeUser('developer', ['USER']));
    const res = await post(app, '/repos/register', { projectId, path: 'vendor/lib' });
    expect(res.status).toBe(200);
  });

  it('LEAD может register', async () => {
    const app = makeApp(makeUser('lead', ['LEAD']));
    const res = await post(app, '/repos/register', { projectId, path: 'vendor/lib' });
    expect(res.status).toBe(200);
  });

  it('owner может clone file:// (201) и запись попадает в реестр', async () => {
    const app = makeApp(makeUser('admin', ['ADMIN']));
    const bare = await createBareRepo(root);
    const res = await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });
    expect(res.status).toBe(201);
    expect(await exists(join(workspacesRoot, 'proj', 'app'))).toBe(true);

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(1);
    expect(saved?.repos?.[0]).toMatchObject({ path: 'app', url: `file://${bare}` });
  });

  it('legacy scan/log/commit не сломаны', async () => {
    const app = makeApp(makeUser('developer', ['USER']));

    const scan = await post(app, '/scan', { projectId });
    expect(scan.status).toBe(200);
    expect((await scan.json() as { repos: unknown[] }).repos).toEqual([]);

    // log/commit по не-git workspace → 404 (legacy NOT_FOUND).
    const log = await app.request(`/api/v2/git/log?project_id=${projectId}`);
    expect(log.status).toBe(404);
    const commit = await app.request(`/api/v2/git/commit?project_id=${projectId}&hash=abc`);
    expect(commit.status).toBe(404);
  });
});
