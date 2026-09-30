/**
 * AD-071 §2.4: проектный MCP-скоуп.
 * RBAC: ProjectRole.OWNER проекта или глобальные LEAD/ADMIN (через AuthKit).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRoutes } from './projects.js';
import { ProjectStore } from '@itphx/synth-core';
import { ProjectRole, type User } from '@itphx/synth-shared';

interface MockUser extends User {
  roles: string[];
}

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MockUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
  outsider: { id: 'outsider', username: 'outsider', roles: ['USER'] } as MockUser,
};

function userFromHeader(header: string | undefined): MockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

function createMockKit() {
  return {
    requireAuth: async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
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

function createMockMcpManager() {
  return {
    getConfig: () => ({
      srvA: { type: 'sse', url: 'http://a/mcp' },
      srvB: { type: 'sse', url: 'http://b/mcp' },
    }),
  };
}

let tmpDir: string;

async function makeApp() {
  const app = new Hono();
  const kit = createMockKit();
  const store = new ProjectStore({ dataDir: tmpDir });
  const routes = createProjectRoutes(
    kit as never,
    store,
    { listSessions: vi.fn().mockResolvedValue([]) } as never,
    tmpDir,
    createMockMcpManager() as never,
  );
  app.route('/api/v2/projects', routes);
  return { app, store };
}

function auth(user: string) {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

describe('Project MCP scope API (AD-071 §2.4)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-proj-mcp-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seedProject(): Promise<string> {
    const { store } = await makeApp();
    const project = store.create('P', 'owner');
    project.members = {
      owner: ProjectRole.OWNER,
      editor: ProjectRole.EDITOR,
      viewer: ProjectRole.VIEWER,
    };
    await store.save(project);
    return project.id;
  }

  it('GET /:id/mcp без аутентификации → 401', async () => {
    const id = await seedProject();
    const { app } = await makeApp();
    const res = await app.request(`/api/v2/projects/${id}/mcp`);
    expect(res.status).toBe(401);
  });

  it('GET /:id/mcp owner → 200 с пустыми списками и knownServers', async () => {
    const id = await seedProject();
    const { app } = await makeApp();
    const res = await app.request(`/api/v2/projects/${id}/mcp`, { headers: auth('owner') });
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: string[]; defaultOn: string[]; knownServers: string[] };
    expect(body.enabled).toEqual([]);
    expect(body.defaultOn).toEqual([]);
    expect(body.knownServers).toEqual(['srvA', 'srvB']);
  });

  it('GET /:id/mcp editor/viewer → 403, lead/admin → 200', async () => {
    const id = await seedProject();
    const { app } = await makeApp();
    for (const denied of ['editor', 'viewer', 'outsider']) {
      const res = await app.request(`/api/v2/projects/${id}/mcp`, { headers: auth(denied) });
      expect(res.status, denied).toBe(403);
    }
    for (const allowed of ['lead', 'admin']) {
      const res = await app.request(`/api/v2/projects/${id}/mcp`, { headers: auth(allowed) });
      expect(res.status, allowed).toBe(200);
    }
  });

  it('PUT /:id/mcp owner задаёт enabled/defaultOn', async () => {
    const id = await seedProject();
    const { app, store } = await makeApp();
    const res = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ enabled: ['srvA', 'srvB'], defaultOn: ['srvA'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: string[]; defaultOn: string[] };
    expect(body.enabled).toEqual(['srvA', 'srvB']);
    expect(body.defaultOn).toEqual(['srvA']);

    const saved = await store.load(id);
    expect(saved!.mcp).toEqual({ enabled: ['srvA', 'srvB'], defaultOn: ['srvA'] });
  });

  it('PUT /:id/mcp editor → 403, lead → 200', async () => {
    const id = await seedProject();
    const { app } = await makeApp();
    const denied = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT',
      headers: auth('editor'),
      body: JSON.stringify({ enabled: ['srvA'] }),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT',
      headers: auth('lead'),
      body: JSON.stringify({ defaultOn: ['srvA'] }),
    });
    expect(allowed.status).toBe(200);
  });

  it('PUT /:id/mcp неизвестный сервер → 400', async () => {
    const id = await seedProject();
    const { app } = await makeApp();
    const res = await app.request(`/api/v2/projects/${id}/mcp`, {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ enabled: ['unknown'] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /:id/mcp несуществующего проекта → 404', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v2/projects/nope/mcp', { headers: auth('owner') });
    expect(res.status).toBe(404);
  });
});
