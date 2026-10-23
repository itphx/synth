/**
 * ADR-106 Ф4 (шаг C): `PATCH /api/v2/sessions/:id` — режим как потолок.
 *
 * Смена режима — привилегия на границе (guard `session-mode-guard.ts`):
 * - **многопользовательская сессия** (участники выведены из проекта): режим
 *   меняется **только у того, кто его выставил** (`modeByPrincipal`), базовый
 *   режим сессии не меняется — `yolo` одного участника не снимает
 *   подтверждения у другого;
 * - `viewer` и посторонний — 403 FORBIDDEN;
 * - **одиночная сессия** (участников нет — личная сессия, standalone) —
 *   прежнее поведение: режим меняется для сессии.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, FileStore, EventBus, ProjectStore } from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { Project, User } from '@itphx/synth-shared';

interface MockUser extends User {
  roles: string[];
}

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MockUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MockUser,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
};

function userFromHeader(header: string | undefined): MockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

function createMockKit() {
  const requireAuth = async (c: Context, next: Next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user', user);
    await next();
  };
  return {
    requireAuth,
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      c.set('user', user);
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }): boolean => {
      const u = c.get('user') as MockUser | undefined;
      return !!u && u.roles.includes('ADMIN');
    },
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]): boolean => {
      const u = c.get('user') as MockUser | undefined;
      return !!u && roles.some((r) => u.roles.includes(r));
    },
  };
}

let tmpDir: string;

async function makeApp() {
  const app = new Hono();
  const kit = createMockKit();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const processMessage = vi.fn().mockResolvedValue({});
  const orchestrator = {
    agentRegistry: { get: () => undefined },
    resolveMcpServers: vi.fn(async () => []),
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
  };
  const routes = createSessionRoutes(
    kit as never,
    sessionManager,
    new EventBus(),
    { createProcessor: vi.fn(), isRunning: vi.fn().mockReturnValue(false) } as never,
    processMessage,
    orchestrator as unknown as ChatOrchestrator,
    { subscribeToSession: vi.fn().mockResolvedValue(undefined), unsubscribeFromSession: vi.fn() } as never,
    undefined,
    projectStore,
    undefined,
  );
  app.route('/api/v2/sessions', routes);
  return { app, sessionManager, projectStore };
}

function auth(user: string) {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

/** Проект с участниками: владелец + EDITOR + VIEWER. */
async function seedProject(projectStore: ProjectStore): Promise<Project> {
  const project = projectStore.create('P', 'owner');
  project.members = { owner: 'owner', editor: 'editor', viewer: 'viewer' } as never;
  await projectStore.save(project);
  return project;
}

async function patchMode(
  app: Hono,
  sessionId: string,
  user: string,
  mode: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`/api/v2/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: auth(user),
    body: JSON.stringify({ mode }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('ADR-106 Ф4 (шаг C) — режим сессии как потолок (PATCH /sessions/:id)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-mode-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('yolo участника не меняет режим сессии (только его ходы)', async () => {
    const { app, sessionManager, projectStore } = await makeApp();
    const project = await seedProject(projectStore);
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const res = await patchMode(app, session.id, 'editor', 'yolo');
    expect(res.status).toBe(200);

    const stored = await sessionManager.getSession(session.id);
    // Базовый режим сессии не тронут — чужие ходы не меняются.
    expect(stored?.mode ?? 'act').toBe('act');
    // Режим записан только для принципала, который его выставил.
    expect(stored?.modeByPrincipal).toEqual({ editor: 'yolo' });
  });

  it('viewer не может сменить режим — 403 FORBIDDEN', async () => {
    const { app, sessionManager, projectStore } = await makeApp();
    const project = await seedProject(projectStore);
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const res = await patchMode(app, session.id, 'viewer', 'yolo');
    expect(res.status).toBe(403);
    expect((res.body.error as { code?: string } | undefined)?.code).toBe('FORBIDDEN');

    const stored = await sessionManager.getSession(session.id);
    expect(stored?.modeByPrincipal).toBeUndefined();
  });

  it('посторонний не может сменить режим — 403 FORBIDDEN', async () => {
    const { app, sessionManager, projectStore } = await makeApp();
    const project = await seedProject(projectStore);
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const res = await patchMode(app, session.id, 'stranger', 'yolo');
    expect(res.status).toBe(403);
  });

  it('одиночная сессия (без участников) — прежнее поведение: режим сессии', async () => {
    const { app, sessionManager } = await makeApp();
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
    });

    const res = await patchMode(app, session.id, 'owner', 'yolo');
    expect(res.status).toBe(200);

    const stored = await sessionManager.getSession(session.id);
    expect(stored?.mode).toBe('yolo');
    expect(stored?.modeByPrincipal).toBeUndefined();
  });

  it('изменение без mode правилом смены режима не регулируется', async () => {
    const { app, sessionManager, projectStore } = await makeApp();
    const project = await seedProject(projectStore);
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
      projectId: project.id,
    });

    const res = await app.request(`/api/v2/sessions/${session.id}`, {
      method: 'PATCH',
      headers: auth('editor'),
      body: JSON.stringify({ name: 'переименовано' }),
    });
    expect(res.status).toBe(200);

    const stored = await sessionManager.getSession(session.id);
    expect(stored?.title).toBe('переименовано');
    // Режим не тронут.
    expect(stored?.modeByPrincipal).toBeUndefined();
  });

  it('недопустимый режим — 400 VALIDATION_ERROR', async () => {
    const { app, sessionManager } = await makeApp();
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
    });

    const res = await patchMode(app, session.id, 'owner', 'turbo');
    expect(res.status).toBe(400);
  });
});
