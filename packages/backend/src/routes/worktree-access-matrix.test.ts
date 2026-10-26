/**
 * Матрица доступа к контуру worktree'ов проекта (ADR-114, managed-контур).
 *
 * Ресурс — не сессия, а **проект** (`/api/v2/projects/:id/worktrees*`), поэтому
 * матрица сессий (`session-idor-matrix.test.ts`) здесь неприменима: своя
 * матрица (образец — `processes-access.test.ts`).
 *
 * Правило (ADR-089 §5.5/§5.8 + инвариант 21):
 *
 * | Актор                       | GET | POST/DELETE/prune |
 * |-----------------------------|-----|--------------------|
 * | владелец проекта            | да  | да                 |
 * | участник проекта (`EDITOR`) | да  | да                 |
 * | участник проекта (`VIEWER`) | да  | **403**            |
 * | `ADMIN`                     | да  | да                 |
 * | `LEAD`                      | да  | да                 |
 * | чужой `USER`                | **403** | **403**        |
 *
 * Проверяется **production-модуль** `routes/projects.ts` (тот же, что монтирует
 * `mount-routes.ts`) — не «фабрика позвали». Тест-перепись снимает перечень
 * маршрутов worktree'ов со **реально смонтированного** backend-приложения
 * (`createBackendApp`) и сравнивает его с матрицей: появился маршрут — тест
 * красный.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryWorktreeRepository,
  ProjectStore,
  WorktreeService,
} from '@itphx/synth-core';
import type { SessionManager } from '@itphx/synth-core';
import { ProjectRole } from '@itphx/synth-shared';
import type { Project, User } from '@itphx/synth-shared';
import { createProjectRoutes } from './projects.js';
import type { AuthKit } from '../auth/middleware.js';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Акторы и мок-AuthKit
// ---------------------------------------------------------------------------

type Actor = 'owner' | 'editor' | 'viewer' | 'stranger' | 'admin' | 'lead';

const ALL_ACTORS: Actor[] = ['owner', 'editor', 'viewer', 'stranger', 'admin', 'lead'];

type MockUser = User & { roles: string[] };

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MockUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MockUser,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MockUser,
};

function userFromHeader(header: string | undefined): MockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

/** Мок-AuthKit: пользователь из `Authorization`, роли из фикстуры. */
function createMockKit() {
  const requireAuth = async (c: Context, next: Next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user' as never, user as never);
    await next();
  };
  return {
    requireAuth,
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = c.get('user') as MockUser | undefined;
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as User | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as User | undefined)?.roles ?? []).includes(r)),
  } as unknown as AuthKit;
}

// ---------------------------------------------------------------------------
// Матрица
// ---------------------------------------------------------------------------

interface Row {
  method: string;
  path: string;
  expected: Record<Actor, number>;
}

/** Ожидаемый код по ролям (владелец/EDITOR/ADMIN/LEAD — успех, VIEWER — 403 на мутации). */
const MATRIX: Row[] = [
  {
    method: 'GET',
    path: '/api/v2/projects/:id/worktrees',
    expected: { owner: 200, editor: 200, viewer: 200, stranger: 403, admin: 200, lead: 200 },
  },
  {
    method: 'POST',
    path: '/api/v2/projects/:id/worktrees',
    expected: { owner: 201, editor: 201, viewer: 403, stranger: 403, admin: 201, lead: 201 },
  },
  {
    method: 'DELETE',
    path: '/api/v2/projects/:id/worktrees/:wid',
    expected: { owner: 204, editor: 204, viewer: 403, stranger: 403, admin: 204, lead: 204 },
  },
  {
    method: 'POST',
    path: '/api/v2/projects/:id/worktrees/prune',
    expected: { owner: 200, editor: 200, viewer: 403, stranger: 403, admin: 200, lead: 200 },
  },
];

function declaredRoutes(): string[] {
  return MATRIX.map((r) => `${r.method} ${r.path}`).sort();
}

/** Маршруты worktree'ов со смонтированного приложения. */
function worktreeRoutes(app: Hono): string[] {
  const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
  const set = new Set<string>();
  for (const r of routes) {
    if (r.method === 'ALL') continue;
    if (!r.path.startsWith('/api/v2/projects/:id/worktrees')) continue;
    set.add(`${r.method} ${r.path}`);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Песочница: production-модуль `routes/projects.ts` + настоящий WorktreeService
// ---------------------------------------------------------------------------

interface World {
  app: Hono;
  projectStore: ProjectStore;
  worktreeService: WorktreeService;
  projectId: string;
  projectDir: string;
  workspacesRoot: string;
  sessionManager: SessionManager;
}

/** Минимальный мок менеджера сессий (нужен только для `/stats` — не вызывается). */
function createMockSessionManager(): SessionManager {
  return { listSessions: async () => [] } as unknown as SessionManager;
}

async function initRepoAt(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Тест'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await execFileAsync('git', ['add', '--', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

async function buildWorld(tmpDir: string): Promise<World> {
  const workspacesRoot = join(tmpDir, 'workspaces');
  const projectDir = join(workspacesRoot, 'projects', 'prj-1');
  await initRepoAt(projectDir);

  const projectStore = new ProjectStore({ dataDir: join(tmpDir, 'data') });
  const worktreeService = new WorktreeService({
    repository: new MemoryWorktreeRepository(),
    workspacesRoot,
    defaultWorkingDir: projectDir,
  });

  // Проект: владелец `owner`, участники `editor` (EDITOR) и `viewer` (VIEWER).
  const project = projectStore.create('Shared', 'owner', { workspace: projectDir });
  project.members['editor'] = ProjectRole.EDITOR;
  project.members['viewer'] = ProjectRole.VIEWER;
  await projectStore.save(project);

  const app = new Hono();
  const kit = createMockKit();
  app.use('*', async (c, next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (user) c.set('user' as never, user as never);
    await next();
  });
  app.route(
    '/api/v2/projects',
    createProjectRoutes(
      kit,
      projectStore,
      createMockSessionManager(),
      workspacesRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      worktreeService,
    ),
  );

  return { app, projectStore, worktreeService, projectId: project.id, projectDir, workspacesRoot, sessionManager: createMockSessionManager() };
}

/** Счётчик имён веток — чтобы акторы не конфликтовали за одну ветку. */
let branchCounter = 0;

async function call(
  world: World,
  row: Row,
  actor: Actor,
  worktreeId?: string,
): Promise<number> {
  const url = row.path
    .replace(':wid', worktreeId ?? 'wkt-none')
    .replace(':id', world.projectId);
  const isPost = row.method === 'POST';
  const body = isPost
    ? row.path.endsWith('/prune')
      ? JSON.stringify({})
      : JSON.stringify({ branch: `feature/act-${actor}-${(branchCounter += 1)}` })
    : undefined;
  const res = await world.app.request(url, {
    method: row.method,
    headers: {
      Authorization: `Bearer ${actor}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body } : {}),
  });
  return res.status;
}

describe('backend: матрица доступа к контуру worktree проекта (ADR-114)', () => {
  let tmpDir: string;
  let world: World;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-worktree-matrix-'));
    world = await buildWorld(tmpDir);
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Перепись: смонтированное приложение
  // -------------------------------------------------------------------------

  describe('перепись маршрутов', () => {
    it('песочница монтирует ровно те же маршруты worktree, что и реальный createBackendApp()', async () => {
      const backendDir = await mkdtemp(join(tmpdir(), 'synth-backend-worktree-app-'));
      let backend: BackendAppHandle | undefined;
      try {
        backend = await createBackendApp({
          dataDir: backendDir,
          authDebug: true,
          env: { SYNTH_METRICS_ENABLED: 'false' },
        });
        expect(worktreeRoutes(world.app)).toEqual(worktreeRoutes(backend.app));
      } finally {
        backend?.stopScheduler();
        backend?.stopEphemeralSweeper();
        backend?.stopEventJournalPruner();
        backend?.stopWebhookService();
        backend?.stopWebhookDeliveryPruner();
        backend?.stopAnalyticsRollupPruner();
        backend?.stopQuestionPruner();
        backend?.stopBackgroundRunPruner();
        backend?.stopProcessLogPruner();
        backend?.stopEgressLogPruner();
        backend?.stopMetrics();
        await rm(backendDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it('перечень маршрутов песочницы === матрица', () => {
      expect(worktreeRoutes(world.app)).toEqual(declaredRoutes());
    });

    it('перепись ловит искусственно добавленный маршрут worktree', () => {
      world.app.get('/api/v2/projects/:id/worktrees/__probe', (c) => c.text('probe'));
      expect(worktreeRoutes(world.app)).not.toEqual(declaredRoutes());
    });
  });

  // -------------------------------------------------------------------------
  // 2. Негативная матрица: чужой USER → 403
  // -------------------------------------------------------------------------

  describe('негативная матрица — чужой USER → 403', () => {
    for (const r of MATRIX) {
      it(`${r.method} ${r.path}`, async () => {
        const status = await call(world, r, 'stranger');
        expect(status, `stranger → ${r.method} ${r.path}`).toBe(403);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Позитивная матрица
  // -------------------------------------------------------------------------

  describe('позитивная матрица — ожидаемый код по ролям', () => {
    for (const r of MATRIX) {
      it(`${r.method} ${r.path}`, async () => {
        for (const actor of ALL_ACTORS) {
          // Для DELETE нужна живая запись worktree (своя на каждый актор).
          let worktreeId: string | undefined;
          if (r.method === 'DELETE') {
            const project = (await world.projectStore.load(world.projectId)) as Project;
            const created = await world.worktreeService.create(
              world.projectId,
              project,
              { branch: `feature/del-${actor}-${(branchCounter += 1)}` },
            );
            worktreeId = created.worktree.id;
          }
          const status = await call(world, r, actor, worktreeId);
          expect(status, `${actor} → ${r.method} ${r.path}`).toBe(r.expected[actor]);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4. VIEWER читает, но не мутирует (инвариант 21)
  // -------------------------------------------------------------------------

  it('VIEWER читает инвентарь, но не может создать/удалить/prune', async () => {
    const created = await world.app.request(`/api/v2/projects/${world.projectId}/worktrees`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature/viewer-check' }),
    });
    expect(created.status).toBe(201);
    const worktree = ((await created.json()) as { worktree: { id: string } }).worktree;

    const read = await world.app.request(`/api/v2/projects/${world.projectId}/worktrees`, {
      headers: { Authorization: 'Bearer viewer' },
    });
    expect(read.status).toBe(200);

    const write = await world.app.request(`/api/v2/projects/${world.projectId}/worktrees`, {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer', 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature/viewer-write' }),
    });
    expect(write.status).toBe(403);

    const remove = await world.app.request(
      `/api/v2/projects/${world.projectId}/worktrees/${worktree.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer viewer' } },
    );
    expect(remove.status).toBe(403);

    const prune = await world.app.request(`/api/v2/projects/${world.projectId}/worktrees/prune`, {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(prune.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 5. Реально смонтированное приложение (debug-ключи)
// ---------------------------------------------------------------------------

describe('backend: контур worktree проекта в смонтированном приложении (debug-ключи)', () => {
  let tmpDir: string;
  let backend: BackendAppHandle;
  let projectId: string;
  let projectDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-worktree-app-'));
    backend = await createBackendApp({
      dataDir: tmpDir,
      authDebug: true,
      env: { SYNTH_METRICS_ENABLED: 'false' },
    });

    projectDir = join(tmpDir, 'repo');
    await initRepoAt(projectDir);

    const project = backend.projectStore.create('Shared', 'developer', { workspace: projectDir });
    await backend.projectStore.save(project);
    projectId = project.id;
  });

  afterAll(async () => {
    backend?.stopScheduler();
    backend?.stopEphemeralSweeper();
    backend?.stopEventJournalPruner();
    backend?.stopWebhookService();
    backend?.stopWebhookDeliveryPruner();
    backend?.stopAnalyticsRollupPruner();
    backend?.stopQuestionPruner();
    backend?.stopBackgroundRunPruner();
    backend?.stopProcessLogPruner();
    backend?.stopEgressLogPruner();
    backend?.stopMetrics();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const KEYS = {
    owner: 'user-key-456', // developer — владелец проекта
    admin: 'admin-key-123',
    lead: 'lead-key-789',
    stranger: 'auditor-key-012', // не участник проекта
  };

  it('владелец проекта → 200 на GET, 201 на POST', async () => {
    const read = await backend.app.request(`/api/v2/projects/${projectId}/worktrees`, {
      headers: { Authorization: `Bearer ${KEYS.owner}` },
    });
    expect(read.status).toBe(200);

    const create = await backend.app.request(`/api/v2/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEYS.owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature/app-owner' }),
    });
    expect(create.status).toBe(201);
  });

  it('ADMIN и LEAD → доступ разрешён', async () => {
    for (const key of [KEYS.admin, KEYS.lead]) {
      const read = await backend.app.request(`/api/v2/projects/${projectId}/worktrees`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(read.status, key).toBe(200);
    }
  });

  it('чужой пользователь → 403 на GET и на мутации', async () => {
    const read = await backend.app.request(`/api/v2/projects/${projectId}/worktrees`, {
      headers: { Authorization: `Bearer ${KEYS.stranger}` },
    });
    expect(read.status).toBe(403);

    const create = await backend.app.request(`/api/v2/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEYS.stranger}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature/app-stranger' }),
    });
    expect(create.status).toBe(403);
  });
});
