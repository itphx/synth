import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRegistryStore } from '@itphx/synth-core';
import { createMcpRoutes, type McpConfigStore } from './mcp.js';
import type { McpServerConfig, McpNetworkPolicy } from '@itphx/synth-shared';

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

function userFromHeader(header: string | undefined): MockUser | null {
  if (header === 'Bearer admin') return { id: 'admin', username: 'admin', roles: ['ADMIN'] };
  if (header === 'Bearer dev') return { id: 'developer', username: 'developer', roles: ['USER'] };
  if (header === 'Bearer other') return { id: 'other', username: 'other', roles: ['USER'] };
  return null;
}

function createMockKit() {
  return {
    requireAuth: async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
      }
      c.set('user', user);
      await next();
    },
    requireAdmin: async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user || !user.roles.includes('ADMIN')) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    isAdmin: (c: { get(key: 'user'): unknown }): boolean => {
      const user = c.get('user') as MockUser | undefined;
      return !!user && user.roles.includes('ADMIN');
    },
  };
}

function createMockConfigStore(): McpConfigStore {
  return {
    getServers: () => ({}),
    addServer: async () => {},
    updateServer: async () => {},
    deleteServer: async () => {},
    hasServer: () => false,
    getServer: () => undefined,
  };
}

function createMockMcpManager() {
  return {
    setConfig: vi.fn(),
    setServerOrigins: vi.fn(),
    disconnectServer: vi.fn(async () => {}),
    getConfiguredServers: vi.fn(() => []),
  };
}

const PUBLIC_IP = '93.184.216.34';
const httpConfig = (url = `http://${PUBLIC_IP}/mcp`): McpServerConfig => ({ type: 'sse', url });
const stdioConfig = (): McpServerConfig => ({ type: 'stdio', command: 'node', args: ['s.js'] });

describe('MCP registry API (AD-071 §2.5)', () => {
  let registry: McpRegistryStore;
  let tmpDir: string;
  let mcpManager: ReturnType<typeof createMockMcpManager>;
  let policy: McpNetworkPolicy;

  function makeApp(policyOverride?: McpNetworkPolicy) {
    const app = new Hono();
    const kit = createMockKit();
    const routes = createMcpRoutes(
      kit as never,
      createMockConfigStore(),
      mcpManager as never,
      null,
      { registry, networkPolicy: policyOverride ?? policy },
    );
    app.route('/api/v2/mcp', routes);
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mcp-routes-'));
    registry = new McpRegistryStore({ dataDir: tmpDir });
    mcpManager = createMockMcpManager();
    policy = { mode: 'deny', list: ['10.0.0.0/8', '127.0.0.0/8'] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /registry требует аутентификации', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry');
    expect(res.status).toBe(401);
  });

  it('GET /registry возвращает список записей', async () => {
    await registry.add({ name: 'srv', config: httpConfig(), origin: 'user' });
    const res = await makeApp().request('/api/v2/mcp/registry', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<{ name: string; origin: string; trust: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.name).toBe('srv');
    expect(body.entries[0]!.origin).toBe('user');
    expect(body.entries[0]!.trust).toBe('community');
  });

  it('POST /registry: HTTP-сервер добавляет пользователь, автор фиксируется', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'user-http', config: httpConfig() }),
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string; author: { userId: string; username: string } };
    expect(entry.origin).toBe('user');
    expect(entry.trust).toBe('community');
    expect(entry.author).toEqual({ userId: 'developer', username: 'developer' });
    expect(mcpManager.setConfig).toHaveBeenCalled();
  });

  it('POST /registry: stdio не-админом → 403', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad-stdio', config: stdioConfig() }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('POST /registry: stdio админом → 201 instance/builtin', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sys-stdio', config: stdioConfig(), enabledByDefault: true }),
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string; enabledByDefault: boolean };
    expect(entry.origin).toBe('instance');
    expect(entry.trust).toBe('builtin');
    expect(entry.enabledByDefault).toBe(true);
  });

  it('POST /registry: приватный HTTP при deny → 400 NETWORK_POLICY_VIOLATION', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private', config: httpConfig('http://10.0.0.5/mcp') }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NETWORK_POLICY_VIOLATION');
    expect(body.error.message).toContain('10.0.0.5');
  });

  it('POST /registry: приватный HTTP разрешён при allow-политике', async () => {
    const res = await makeApp({ mode: 'allow', list: ['10.0.0.0/8'] }).request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private-ok', config: httpConfig('http://10.0.0.5/mcp') }),
    });
    expect(res.status).toBe(201);
  });

  it('POST /registry: admin instance HTTP на приватный адрес не блокируется (доверенный)', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'internal', config: httpConfig('http://10.0.0.5/mcp'), origin: 'instance' }),
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string };
    expect(entry.origin).toBe('instance');
  });

  it('POST /registry: дубликат имени → 409', async () => {
    await registry.add({ name: 'dup', config: httpConfig(), origin: 'user' });
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dup', config: httpConfig() }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /registry: невалидное тело → 400', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', config: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT /registry/:id: автор может обновить', async () => {
    const entry = await registry.add({
      name: 'mine',
      config: httpConfig(),
      origin: 'user',
      author: { userId: 'developer', username: 'developer' },
      trust: 'community',
    });
    const res = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledByDefault: true }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as { enabledByDefault: boolean };
    expect(updated.enabledByDefault).toBe(true);
  });

  it('PUT /registry/:id: чужой пользователь → 403, admin → 200', async () => {
    const entry = await registry.add({
      name: 'mine',
      config: httpConfig(),
      origin: 'user',
      author: { userId: 'developer', username: 'developer' },
      trust: 'community',
    });
    const forbidden = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledByDefault: true }),
    });
    expect(forbidden.status).toBe(403);

    const allowed = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledByDefault: true }),
    });
    expect(allowed.status).toBe(200);
  });

  it('PUT /registry/:id: не найдено → 404', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry/missing', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledByDefault: true }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /registry/:id: автор удаляет, чужой → 403', async () => {
    const entry = await registry.add({
      name: 'mine',
      config: httpConfig(),
      origin: 'user',
      author: { userId: 'developer', username: 'developer' },
      trust: 'community',
    });
    const forbidden = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer other' },
    });
    expect(forbidden.status).toBe(403);

    const ok = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev' },
    });
    expect(ok.status).toBe(200);
    expect(await registry.get(entry.id)).toBeNull();
    expect(mcpManager.disconnectServer).toHaveBeenCalledWith('mine');
  });

  it('DELETE /registry/:id: не найдено → 404', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry/missing', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(404);
  });
});
