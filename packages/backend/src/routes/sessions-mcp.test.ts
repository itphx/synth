/**
 * ADR-071 §2.4: MCP-скоуп сессии — эффективный список и переключение.
 * RBAC: владелец сессии (обычный пользователь) или ADMIN.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, FileStore, EventBus } from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { Session, User, McpServerEffective } from '@itphx/synth-shared';

interface MockUser extends User {
  roles: string[];
}

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  other: { id: 'other', username: 'other', roles: ['USER'] } as MockUser,
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

const ALL_SERVERS = [
  { name: 'sys', origin: 'instance' as const, trust: 'builtin' as const, enabledByDefault: true },
  { name: 'proj', origin: 'user' as const, trust: 'community' as const, enabledByDefault: false },
  { name: 'sess', origin: 'user' as const, trust: 'community' as const, enabledByDefault: false },
];

/** Мок-резолвер: instance defaultOn ∪ session.enabled − session.disabled. */
function resolveMock(session: Session): McpServerEffective[] {
  const enabledList = new Set(session.settings.mcpServers ?? []);
  const disabledList = new Set(session.settings.mcpDisabledServers ?? []);
  return ALL_SERVERS.map((s) => {
    const on = s.enabledByDefault || enabledList.has(s.name);
    const enabled = on && !disabledList.has(s.name);
    return {
      name: s.name,
      level: s.origin === 'instance' ? 'system' : 'session',
      enabled,
      ...(enabled ? {} : { reason: disabledList.has(s.name) ? 'session_optout' as const : 'not_default' as const }),
      connected: false,
      origin: s.origin,
      trust: s.trust,
    };
  });
}

let tmpDir: string;

async function makeApp() {
  const app = new Hono();
  const kit = createMockKit();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const orchestrator = {
    agentRegistry: { get: () => undefined },
    resolveMcpServers: vi.fn(async (session: Session) => resolveMock(session)),
  };
  const routes = createSessionRoutes(
    kit as never,
    sessionManager,
    new EventBus(),
    {} as never,
    vi.fn() as never,
    orchestrator as unknown as ChatOrchestrator,
    { subscribeToSession: vi.fn() } as never,
  );
  app.route('/api/v2/sessions', routes);
  return { app, sessionManager };
}

function auth(user: string) {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

describe('Session MCP scope API (ADR-071 §2.4)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sess-mcp-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seedSession(): Promise<string> {
    const { sessionManager } = await makeApp();
    const session = await sessionManager.createSession({
      title: 'S',
      ownerId: 'owner',
      userId: 'owner',
      settings: { mcpServers: [] },
    });
    return session.id;
  }

  it('GET /:id/mcp без аутентификации → 401', async () => {
    const id = await seedSession();
    const { app } = await makeApp();
    const res = await app.request(`/api/v2/sessions/${id}/mcp`);
    expect(res.status).toBe(401);
  });

  it('GET /:id/mcp owner → эффективный список (системный включён)', async () => {
    const id = await seedSession();
    const { app } = await makeApp();
    const res = await app.request(`/api/v2/sessions/${id}/mcp`, { headers: auth('owner') });
    expect(res.status).toBe(200);
    const body = await res.json() as { servers: McpServerEffective[]; enabled: string[] };
    const sys = body.servers.find((s) => s.name === 'sys')!;
    expect(sys).toMatchObject({ level: 'system', enabled: true, origin: 'instance', trust: 'builtin' });
    expect(body.enabled).toContain('sys');
    const proj = body.servers.find((s) => s.name === 'proj')!;
    expect(proj).toMatchObject({ level: 'session', enabled: false, reason: 'not_default' });
  });

  it('GET /:id/mcp не-владелец → 403, admin → 200', async () => {
    const id = await seedSession();
    const { app } = await makeApp();
    const denied = await app.request(`/api/v2/sessions/${id}/mcp`, { headers: auth('other') });
    expect(denied.status).toBe(403);
    const allowed = await app.request(`/api/v2/sessions/${id}/mcp`, { headers: auth('admin') });
    expect(allowed.status).toBe(200);
  });

  it('PUT /:id/mcp opt-out системного сервера → reason=session_optout', async () => {
    const id = await seedSession();
    const { app, sessionManager } = await makeApp();
    const res = await app.request(`/api/v2/sessions/${id}/mcp`, {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ name: 'sys', enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { servers: McpServerEffective[] };
    const sys = body.servers.find((s) => s.name === 'sys')!;
    expect(sys).toMatchObject({ level: 'system', enabled: false, reason: 'session_optout' });

    const saved = await sessionManager.getSession(id);
    expect(saved!.settings.mcpDisabledServers).toContain('sys');
  });

  it('PUT /:id/mcp включение сервера и полная замена', async () => {
    const id = await seedSession();
    const { app, sessionManager } = await makeApp();

    const on = await app.request(`/api/v2/sessions/${id}/mcp`, {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ name: 'sess', enabled: true }),
    });
    expect(on.status).toBe(200);
    expect((await sessionManager.getSession(id))!.settings.mcpServers).toContain('sess');

    const replace = await app.request(`/api/v2/sessions/${id}/mcp`, {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ mcpServers: ['proj'], mcpDisabledServers: ['sess'] }),
    });
    expect(replace.status).toBe(200);
    const saved = await sessionManager.getSession(id);
    expect(saved!.settings.mcpServers).toEqual(['proj']);
    expect(saved!.settings.mcpDisabledServers).toEqual(['sess']);
  });

  it('PUT /:id/mcp неизвестный сервер → 400, не-владелец → 403', async () => {
    const id = await seedSession();
    const { app } = await makeApp();

    const unknown = await app.request(`/api/v2/sessions/${id}/mcp`, {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ name: 'nope', enabled: true }),
    });
    expect(unknown.status).toBe(400);

    const denied = await app.request(`/api/v2/sessions/${id}/mcp`, {
      method: 'PUT',
      headers: auth('other'),
      body: JSON.stringify({ name: 'sess', enabled: true }),
    });
    expect(denied.status).toBe(403);
  });

  it('GET /:id/mcp несуществующей сессии → 404', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v2/sessions/nope/mcp', { headers: auth('owner') });
    expect(res.status).toBe(404);
  });
});
