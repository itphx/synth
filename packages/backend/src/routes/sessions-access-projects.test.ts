/**
 * PROP-133 Ф1: доступ к **сессиям** проекта с общим доступом.
 *
 * Правило (PROP-133 §6): видимость проекта распространяется на его сессии —
 * сессия проекта в режиме `all` (`everyone_role='viewer'`) видна постороннему
 * (список + `GET /sessions/:id` → 200), но запись в неё ему не дана
 * (`POST /:id/prompt`, `PATCH /:id` → 403). Роль `viewer` писать не может ни
 * на одном контуре (инвариант 21).
 *
 * Проверяется тот же предикат (`resolveProjectAccess` через `canReadProject` /
 * `canEditProjectContent` в backend-обёртке `createProjectAccess`), что и в
 * `projects-access-matrix.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventBus,
  FileStore,
  ProjectStore,
  SessionManager,
} from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { createSessionRoutes as createBackendSessionRoutes } from './sessions.js';

interface MatrixUser extends User {
  groups?: string[];
}

const USERS: Record<string, MatrixUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MatrixUser,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as MatrixUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MatrixUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MatrixUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MatrixUser,
};

function userFromHeader(header: string | undefined): MatrixUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

function createMockKit() {
  return {
    requireAuth: async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
      c.set('user' as never, user as never);
      await next();
    },
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = c.get('user') as MatrixUser | undefined;
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as MatrixUser | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as MatrixUser | undefined)?.roles ?? []).includes(r)),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    agentRegistry: { get: () => undefined },
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    listPendingApprovals: vi.fn().mockReturnValue([]),
  };
}

interface World {
  app: Hono;
  sessionManager: SessionManager;
  projectStore: ProjectStore;
  sharedProjectId: string;
  authorProjectId: string;
  sharedSessionId: string;
  authorSessionId: string;
}

let tmpDir: string;
let world: World;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-sessions-proj-access-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const eventBus = new EventBus();
  const queueManager = {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
    retryNow: vi.fn().mockReturnValue(true),
    cancelRetry: vi.fn().mockResolvedValue(true),
  };
  const orchestrator = createMockOrchestrator();
  const contextOptimizer = {
    canSummarize: vi.fn().mockReturnValue(false),
    shouldApplySlidingWindow: vi.fn().mockReturnValue({ triggered: false }),
    shouldSummarize: vi.fn().mockReturnValue({ triggered: false }),
  };
  const eventHub = {
    subscribeToSession: vi.fn().mockResolvedValue(undefined),
    unsubscribeFromSession: vi.fn(),
  };

  // Проект в режиме `all` (всем пользователям) — режим «viewer».
  const shared = projectStore.create('Shared', 'owner');
  shared.everyoneRole = ProjectRole.VIEWER;
  await projectStore.save(shared);

  // Проект в режиме `author` — грантов нет.
  const author = projectStore.create('Private', 'owner');
  await projectStore.save(author);

  const app = new Hono();
  const kit = createMockKit();
  app.use('*', async (c, next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (user) c.set('user' as never, user as never);
    await next();
  });
  app.route('/api/v2/sessions', createBackendSessionRoutes(
    kit as never,
    sessionManager,
    eventBus,
    queueManager as never,
    orchestrator.createProcessMessage(),
    orchestrator as unknown as ChatOrchestrator,
    eventHub as never,
    contextOptimizer as never,
    projectStore,
  ));

  const sharedSession = await sessionManager.createSession({
    title: 'Shared session',
    userId: 'owner',
    ownerId: 'owner',
    projectId: shared.id,
  });
  const authorSession = await sessionManager.createSession({
    title: 'Private session',
    userId: 'owner',
    ownerId: 'owner',
    projectId: author.id,
  });

  world = {
    app,
    sessionManager,
    projectStore,
    sharedProjectId: shared.id,
    authorProjectId: author.id,
    sharedSessionId: sharedSession.id,
    authorSessionId: authorSession.id,
  };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function auth(user: string): Record<string, string> {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

async function listSessions(user: string) {
  const res = await world.app.request('/api/v2/sessions', { headers: auth(user) });
  expect(res.status).toBe(200);
  return (await res.json()) as { sessions: Array<{ id: string }>; total: number };
}

// ---------------------------------------------------------------------------
// Сессия проекта в режиме `all`
// ---------------------------------------------------------------------------

describe('PROP-133: сессия проекта в режиме `all` видна постороннему', () => {
  it('список сессий постороннего содержит сессию shared-проекта', async () => {
    const list = await listSessions('stranger');
    expect(list.sessions.map((s) => s.id)).toContain(world.sharedSessionId);
    expect(list.total).toBeGreaterThan(0);
  });

  it('GET /sessions/:id — 200 (чтение сессии shared-проекта)', async () => {
    const res = await world.app.request(`/api/v2/sessions/${world.sharedSessionId}`, {
      headers: auth('stranger'),
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string; name: string | null };
    expect(dto.id).toBe(world.sharedSessionId);
    expect(dto.name).toBe('Shared session');
  });

  it('сессия проекта в режиме `author` постороннему не видна (404 по id, нет в списке)', async () => {
    const list = await listSessions('stranger');
    expect(list.sessions.map((s) => s.id)).not.toContain(world.authorSessionId);

    const res = await world.app.request(`/api/v2/sessions/${world.authorSessionId}`, {
      headers: auth('stranger'),
    });
    expect(res.status).toBe(403);
  });

  it('POST /sessions/:id/prompt — 403 (viewer не пишет)', async () => {
    const res = await world.app.request(`/api/v2/sessions/${world.sharedSessionId}/prompt`, {
      method: 'POST',
      headers: auth('stranger'),
      body: JSON.stringify({ text: 'привет' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('PATCH /sessions/:id — 403 (viewer не мутирует сессию)', async () => {
    const res = await world.app.request(`/api/v2/sessions/${world.sharedSessionId}`, {
      method: 'PATCH',
      headers: auth('stranger'),
      body: JSON.stringify({ name: 'переименовано' }),
    });
    expect(res.status).toBe(403);
    const session = await world.sessionManager.getSession(world.sharedSessionId);
    expect(session?.title).toBe('Shared session');
  });
});

// ---------------------------------------------------------------------------
// Сессия проекта в режиме `selected` — по роли участника
// ---------------------------------------------------------------------------

describe('PROP-133: сессия проекта в режиме `selected` — по роли участника', () => {
  it('viewer читает сессию, но не пишет в неё', async () => {
    const project = world.projectStore.create('Selected', 'owner');
    project.members.viewer = ProjectRole.VIEWER;
    await world.projectStore.save(project);
    const session = await world.sessionManager.createSession({
      title: 'Selected session',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const read = await world.app.request(`/api/v2/sessions/${session.id}`, {
      headers: auth('viewer'),
    });
    expect(read.status).toBe(200);

    const write = await world.app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { ...auth('viewer') },
      body: JSON.stringify({ text: 'привет' }),
    });
    expect(write.status).toBe(403);
  });

  it('editor пишет в сессию (правка содержимого сессии — по праву изменения проекта)', async () => {
    const project = world.projectStore.create('Selected-edit', 'owner');
    project.members.editor = ProjectRole.EDITOR;
    await world.projectStore.save(project);
    const session = await world.sessionManager.createSession({
      title: 'Editable session',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const patch = await world.app.request(`/api/v2/sessions/${session.id}`, {
      method: 'PATCH',
      headers: auth('editor'),
      body: JSON.stringify({ name: 'переименовано редактором' }),
    });
    expect(patch.status).toBe(200);
    expect((await world.sessionManager.getSession(session.id))?.title).toBe('переименовано редактором');
  });

  it('viewer не может ни переименовать, ни удалить сессию (403)', async () => {
    const project = world.projectStore.create('Selected-viewer-del', 'owner');
    project.members.viewer = ProjectRole.VIEWER;
    await world.projectStore.save(project);
    const session = await world.sessionManager.createSession({
      title: 'Read-only session',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const patch = await world.app.request(`/api/v2/sessions/${session.id}`, {
      method: 'PATCH',
      headers: auth('viewer'),
      body: JSON.stringify({ name: 'переименовано' }),
    });
    expect(patch.status).toBe(403);

    const del = await world.app.request(`/api/v2/sessions/${session.id}`, {
      method: 'DELETE',
      headers: auth('viewer'),
    });
    expect(del.status).toBe(403);
    expect(await world.sessionManager.getSession(session.id)).not.toBeNull();
  });
});
