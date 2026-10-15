/**
 * ADR-089 / безопасность: backend-only роуты сессии (export/notes/optimization/
 * debug-system-message) обязаны проверять доступ пользователя к сессии, а не
 * только `requireAuth` + существование — иначе IDOR: USER читает и меняет чужую
 * сессию (история, план, настройки, карта обфускации, заметки).
 *
 * Единое правило видимости — `isSessionVisible` из core: elevated (ADMIN/LEAD) →
 * всё; владелец → да; сессия без владельца → да; иначе сессия проекта видна её
 * owner/участникам. Отказ → 403 FORBIDDEN (единый код для «сессия недоступна»
 * во всём ресурсе сессий; 404 остаётся только для реально отсутствующей сессии).
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
import type { User } from '@itphx/synth-shared';

interface MockUser extends User {
  roles: string[];
}

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  other: { id: 'other', username: 'other', roles: ['USER'] } as MockUser,
  member: { id: 'member', username: 'member', roles: ['USER'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MockUser,
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
    requirePermission: () => requireAuth,
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
    { subscribeToSession: vi.fn(), unsubscribeFromSession: vi.fn() } as never,
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

describe('Session access control для backend-only роутов (ADR-089, IDOR)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sess-access-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сессия, принадлежащая 'owner'. */
  async function seedOwnedSession() {
    const { app, sessionManager } = await makeApp();
    const session = await sessionManager.createSession({
      title: 'S',
      ownerId: 'owner',
      userId: 'owner',
    });
    return { app, sessionManager, id: session.id };
  }

  const denied = 403;
  const ok = 200;

  describe('GET /:id/export', () => {
    it('чужой USER → 403, владелец/ADMIN/LEAD → 200', async () => {
      const { app, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('other') });
      expect(foreign.status).toBe(denied);
      expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

      for (const u of ['owner', 'admin', 'lead']) {
        const res = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth(u) });
        expect(res.status, u).toBe(ok);
      }
    });
  });

  describe('notes', () => {
    it('GET /:id/notes: чужой → 403, владелец/ADMIN → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/notes`, { headers: auth('other') })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/notes`, { headers: auth('owner') })).status).toBe(ok);
      expect((await app.request(`/api/v2/sessions/${id}/notes`, { headers: auth('admin') })).status).toBe(ok);
    });

    it('POST /:id/notes: чужой → 403 (заметка не создаётся), владелец → 201', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('other'),
        body: JSON.stringify({ content: 'hack' }),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(0);

      const ownerRes = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'mine' }),
      });
      expect(ownerRes.status).toBe(201);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(1);
    });

    it('PATCH /:id/notes/:noteId: чужой → 403 (не меняется), владелец → 200', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();
      const created = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'note' }),
      });
      const noteId = ((await created.json()) as { note: { id: string } }).note.id;

      const foreign = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'PATCH',
        headers: auth('other'),
        body: JSON.stringify({ content: 'tampered' }),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.stickyNotes[0]!.content).toBe('note');

      const ownerRes = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'PATCH',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'updated' }),
      });
      expect(ownerRes.status).toBe(ok);
      expect((await sessionManager.getSession(id))!.stickyNotes[0]!.content).toBe('updated');
    });

    it('DELETE /:id/notes/:noteId: чужой → 403 (не удаляется), владелец → 200', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();
      const created = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'note' }),
      });
      const noteId = ((await created.json()) as { note: { id: string } }).note.id;

      const foreign = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'DELETE',
        headers: auth('other'),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(1);

      const ownerRes = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'DELETE',
        headers: auth('owner'),
      });
      expect(ownerRes.status).toBe(ok);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(0);
    });
  });

  describe('optimization', () => {
    it('GET /:id/optimization: чужой → 403, владелец/ADMIN → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/optimization`, { headers: auth('other') })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/optimization`, { headers: auth('owner') })).status).toBe(ok);
      expect((await app.request(`/api/v2/sessions/${id}/optimization`, { headers: auth('admin') })).status).toBe(ok);
    });

    it('PATCH /:id/optimization: чужой → 403 (не меняется), владелец → 200', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/optimization`, {
        method: 'PATCH',
        headers: auth('other'),
        body: JSON.stringify({ summarization_enabled: true }),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.settings.summarizationEnabled).toBeFalsy();

      const ownerRes = await app.request(`/api/v2/sessions/${id}/optimization`, {
        method: 'PATCH',
        headers: auth('owner'),
        body: JSON.stringify({ summarization_enabled: true }),
      });
      expect(ownerRes.status).toBe(ok);
      expect((await sessionManager.getSession(id))!.settings.summarizationEnabled).toBe(true);
    });

    it('POST /:id/optimization/check: чужой → 403, владелец → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/optimization/check`, {
        method: 'POST', headers: auth('other'),
      })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/optimization/check`, {
        method: 'POST', headers: auth('owner'),
      })).status).toBe(ok);
    });

    it('POST /:id/optimization/cancel-summarization: чужой → 403, владелец → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/optimization/cancel-summarization`, {
        method: 'POST', headers: auth('other'),
      })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/optimization/cancel-summarization`, {
        method: 'POST', headers: auth('owner'),
      })).status).toBe(ok);
    });
  });

  describe('POST /:id/debug-system-message', () => {
    it('чужой USER → 403, владелец/ADMIN → 200', async () => {
      const { app, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/debug-system-message`, {
        method: 'POST',
        headers: auth('other'),
        body: JSON.stringify({}),
      });
      expect(foreign.status).toBe(denied);

      const ownerRes = await app.request(`/api/v2/sessions/${id}/debug-system-message`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({}),
      });
      expect(ownerRes.status).toBe(ok);

      const adminRes = await app.request(`/api/v2/sessions/${id}/debug-system-message`, {
        method: 'POST',
        headers: auth('admin'),
        body: JSON.stringify({}),
      });
      expect(adminRes.status).toBe(ok);
    });
  });

  describe('проектная видимость', () => {
    it('участник проекта открывает сессию проекта (200), посторонний → 403', async () => {
      const { app, sessionManager, projectStore } = await makeApp();
      const project = projectStore.create('P', 'owner');
      project.members['member'] = 'viewer' as never;
      await projectStore.save(project);
      const session = await sessionManager.createSession({
        title: 'shared', ownerId: 'owner', userId: 'owner', projectId: project.id,
      });

      const memberRes = await app.request(`/api/v2/sessions/${session.id}/export`, { headers: auth('member') });
      expect(memberRes.status).toBe(ok);

      const outsiderRes = await app.request(`/api/v2/sessions/${session.id}/export`, { headers: auth('other') });
      expect(outsiderRes.status).toBe(denied);
    });
  });

  describe('несуществующая сессия', () => {
    it('GET /:id/export → 404', async () => {
      const { app } = await makeApp();
      const res = await app.request('/api/v2/sessions/nope/export', { headers: auth('owner') });
      expect(res.status).toBe(404);
    });
  });
});
