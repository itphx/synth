// ADR-089 §5.8 / инвариант 16: проектная авторизация порталя памяти в
// managed-backend. Проверяем, что backend передаёт в core-фабрику реальную
// проверку прав: `read` — право чтения проекта (владелец/участник/`LEAD`/
// `ADMIN`), `write` — право изменения содержимого (владелец/`EDITOR`/`LEAD`/
// `ADMIN`; `VIEWER` только читает — инвариант 21).
//
// Ролевой guard портала в managed — ADMIN (весь портал админский); здесь он
// заменён на no-op, чтобы изолировать именно ПРОЕКТНУЮ проверку: без неё
// не-участник проекта читал бы чужую память по `projectId`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryRoutes, createMemoryStorage, ProjectStore } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { createProjectAccess } from './projects.js';
import type { AuthKit } from '../auth/middleware.js';

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

describe('Портал памяти — проектная авторизация (backend)', () => {
  let root: string;
  let dataDir: string;
  let projectStore: ProjectStore;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-backend-memory-acl-'));
    dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'workspaces', 'proj'), { recursive: true });
    projectStore = new ProjectStore({ dataDir });
    // Владелец — admin, чтобы `developer` (USER) был не-участником.
    const project = projectStore.create('Demo', 'admin', { workspace: 'proj' });
    projectId = project.id;
    await projectStore.save(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Монтирует core-фабрику так же, как `app/mount-routes.ts` (projectAccess + projectStore). */
  function makeApp(user: User | null) {
    const kit = makeKit(user);
    const access = createProjectAccess(kit as unknown as AuthKit);
    const storage = createMemoryStorage();
    const app = new Hono();
    app.route('/api/v2/memory', createMemoryRoutes(
      { requireAuth: passAuth },
      {
        memory: { facts: storage.memoryFacts, indexes: storage.memoryIndexes },
        // Ролевой guard managed (ADMIN) заменён на no-op — изолируем проектную проверку.
        guard: passAuth,
        isPluginActive: () => true,
        authorizeProject: async (c, id, mode) => {
          const current = await kit.getCurrentUser(c);
          if (!current) return false;
          const project = await projectStore.load(id);
          if (!project) return false;
          return mode === 'read'
            ? access.canReadProject(c, project, current.id)
            : access.canEditProjectContent(c, project, current.id);
        },
        resolveProject: async (id) => {
          const project = await projectStore.load(id);
          if (!project) return null;
          return { id: project.id, workspace: join(dataDir, 'workspaces', 'proj') };
        },
      },
    ));
    return app;
  }

  it('не-участник проекта (USER) → 403 на чтении по projectId', async () => {
    const app = makeApp(makeUser('developer', ['USER']));
    const res = await app.request(`/api/v2/memory/facts?status=all&projectId=${projectId}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('не-участник проекта (USER) → 403 на записи (создание индекса)', async () => {
    const app = makeApp(makeUser('developer', ['USER']));
    const res = await app.request('/api/v2/memory/indexes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(res.status).toBe(403);
  });

  it('участник-VIEWER → чтение 200, запись 403', async () => {
    const project = await projectStore.load(projectId);
    expect(project).not.toBeNull();
    await projectStore.save({
      ...(project as NonNullable<typeof project>),
      members: { developer: ProjectRole.VIEWER },
    });

    const app = makeApp(makeUser('developer', ['USER']));
    const read = await app.request(`/api/v2/memory/facts?status=all&projectId=${projectId}`);
    expect(read.status).toBe(200);

    const write = await app.request('/api/v2/memory/indexes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(write.status).toBe(403);
  });

  it('участник-EDITOR → чтение и запись разрешены', async () => {
    const project = await projectStore.load(projectId);
    expect(project).not.toBeNull();
    await projectStore.save({
      ...(project as NonNullable<typeof project>),
      members: { developer: ProjectRole.EDITOR },
    });

    const app = makeApp(makeUser('developer', ['USER']));
    const read = await app.request(`/api/v2/memory/facts?status=all&projectId=${projectId}`);
    expect(read.status).toBe(200);

    const write = await app.request('/api/v2/memory/indexes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    // Запись разрешена — дальше отвечает портал (провайдер/тул), не права.
    expect(write.status).not.toBe(403);
  });

  it('ADMIN → 200 (сквозной доступ, ADR-089 §5.8)', async () => {
    const app = makeApp(makeUser('admin', ['ADMIN']));
    const res = await app.request(`/api/v2/memory/facts?status=all&projectId=${projectId}`);
    expect(res.status).toBe(200);
  });

  it('неаутентифицированный → 403 (fail-closed)', async () => {
    const app = makeApp(null);
    const res = await app.request(`/api/v2/memory/facts?status=all&projectId=${projectId}`);
    expect(res.status).toBe(403);
  });
});
