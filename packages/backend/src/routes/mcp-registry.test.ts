import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRegistryStore } from '@itphx/synth-core';
import { createMcpRoutes } from './mcp.js';
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

/**
 * ADR-052/O1: mock service-key — `svc-scope` несёт scope `addons:install`,
 * `svc-noscope` — пустые scopes. Возвращает synthetic-user + credential.
 */
function serviceKeyFromHeader(
  header: string | undefined,
): { user: MockUser; scopes: string[] } | null {
  if (header === 'Bearer svc-scope') {
    return { user: { id: 'service:svc1', username: 'installer', roles: ['USER'] }, scopes: ['addons:install'] };
  }
  if (header === 'Bearer svc-noscope') {
    return { user: { id: 'service:svc2', username: 'installer', roles: ['USER'] }, scopes: [] };
  }
  return null;
}

function createMockKit() {
  return {
    requireAuth: async (c: Context, next: Next) => {
      const svc = serviceKeyFromHeader(c.req.header('Authorization'));
      if (svc) {
        c.set('user', svc.user);
        c.set('serviceKey', {
          keyId: svc.user.id,
          label: svc.user.username,
          roles: svc.user.roles,
          scopes: svc.scopes,
        });
        await next();
        return;
      }
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

function createMockMcpManager() {
  return {
    setConfig: vi.fn(),
    setServerOrigins: vi.fn(),
    setServerTrusts: vi.fn(),
    setServerAuthors: vi.fn(),
    setDefaultServers: vi.fn(),
    setServerSystemEnabled: vi.fn(),
    disconnectServer: vi.fn(async () => {}),
    getConfiguredServers: vi.fn(() => []),
    getConfig: vi.fn(() => ({})),
    probeServer: vi.fn(async () => []),
  };
}

const PUBLIC_IP = '93.184.216.34';
const httpConfig = (url = `http://${PUBLIC_IP}/mcp`): McpServerConfig => ({ type: 'sse', url });
const stdioConfig = (): McpServerConfig => ({ type: 'stdio', command: 'node', args: ['s.js'] });

describe('MCP registry API (ADR-071 §2.5)', () => {
  let registry: McpRegistryStore;
  let tmpDir: string;
  let mcpManager: ReturnType<typeof createMockMcpManager>;
  let policy: McpNetworkPolicy;

  function makeApp(policyOverride?: McpNetworkPolicy) {
    const app = new Hono();
    const kit = createMockKit();
    // В реальном backend контекст ставит глобальный `attachUser`; в тест-харнесе
    // (роуты монтируются напрямую) воспроизводим его, иначе роутные guard'ы,
    // читающие `user`/`serviceKey`, не увидят аутентификацию.
    app.use('*', async (c: Context, next: Next) => {
      const svc = serviceKeyFromHeader(c.req.header('Authorization'));
      if (svc) {
        c.set('user', svc.user);
        c.set('serviceKey', {
          keyId: svc.user.id,
          label: svc.user.username,
          roles: svc.user.roles,
          scopes: svc.scopes,
        });
      } else {
        const user = userFromHeader(c.req.header('Authorization'));
        if (user) c.set('user', user);
      }
      await next();
    });
    const routes = createMcpRoutes(
      kit as never,
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

  // ADR-052/O1: guard «ADMIN или scope `addons:install`» + installer видит instance-origin.
  it('service-key со scope addons:install: POST /registry (http) → 201 instance/builtin', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'installer-http', config: httpConfig() }),
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { id: string; origin: string; trust: string; author: { userId: string } };
    expect(entry.origin).toBe('instance');
    expect(entry.trust).toBe('builtin');
    // Автор — синтетический пользователь installer-ключа.
    expect(entry.author.userId).toBe('service:svc1');
  });

  it('service-key со scope: явный origin:"instance" → instance', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'installer-explicit', config: httpConfig(), origin: 'instance' }),
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string };
    expect(entry.origin).toBe('instance');
    expect(entry.trust).toBe('builtin');
  });

  it('installer-ключ обновляет созданную им запись → 200', async () => {
    const created = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'installer-owned', config: httpConfig() }),
    });
    expect(created.status).toBe(201);
    const entry = await created.json() as { id: string };

    const put = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledByDefault: true }),
    });
    expect(put.status).toBe(200);
    const updated = await put.json() as { enabledByDefault: boolean };
    expect(updated.enabledByDefault).toBe(true);
  });

  it('installer-ключ обновляет instance-запись, созданную не им (scope-ветка)', async () => {
    const entry = await registry.add({
      name: 'admin-created',
      config: httpConfig(),
      origin: 'instance',
      trust: 'builtin',
      author: { userId: 'admin', username: 'admin' },
    });
    const put = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledByDefault: true }),
    });
    expect(put.status).toBe(200);
  });

  it('service-key со scope: stdio в реестр → 403 (stdio только ADMIN)', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'installer-stdio', config: stdioConfig() }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('интерактив не-ADMIN с origin:"instance" → остаётся user (прежнее поведение)', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dev-wants-instance', config: httpConfig(), origin: 'instance' }),
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string };
    expect(entry.origin).toBe('user');
    expect(entry.trust).toBe('community');
  });

  it('service-key без scope: POST /registry → 403 SCOPE_REQUIRED', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-noscope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-scope', config: httpConfig() }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('service-key со scope: PUT/DELETE /servers/:name и test доступны', async () => {
    await registry.add({ name: 'srv-ops', config: httpConfig(), origin: 'instance', trust: 'builtin' });

    const put = await makeApp().request('/api/v2/mcp/servers/srv-ops', {
      method: 'PUT',
      headers: { Authorization: 'Bearer svc-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify(httpConfig('http://93.184.216.34/other')),
    });
    expect(put.status).toBe(200);

    const test = await makeApp().request('/api/v2/mcp/servers/srv-ops/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-scope' },
    });
    expect(test.status).toBe(200);
    expect(mcpManager.probeServer).toHaveBeenCalled();

    const del = await makeApp().request('/api/v2/mcp/servers/srv-ops', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer svc-scope' },
    });
    expect(del.status).toBe(200);
  });

  it('service-key без scope: PUT /servers/:name → 403 SCOPE_REQUIRED', async () => {
    await registry.add({ name: 'srv-x', config: httpConfig(), origin: 'instance', trust: 'builtin' });
    const res = await makeApp().request('/api/v2/mcp/servers/srv-x', {
      method: 'PUT',
      headers: { Authorization: 'Bearer svc-noscope', 'Content-Type': 'application/json' },
      body: JSON.stringify(httpConfig()),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('интерактивный не-ADMIN на PUT/DELETE /servers/:name → 403 FORBIDDEN', async () => {
    await registry.add({ name: 'srv-y', config: httpConfig(), origin: 'instance', trust: 'builtin' });
    const put = await makeApp().request('/api/v2/mcp/servers/srv-y', {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify(httpConfig()),
    });
    expect(put.status).toBe(403);

    const del = await makeApp().request('/api/v2/mcp/servers/srv-y', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev' },
    });
    expect(del.status).toBe(403);
  });

  it('интерактивный пользователь по-прежнему добавляет свой HTTP-сервер (не ADMIN)', async () => {
    const res = await makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'user-still-ok', config: httpConfig() }),
    });
    expect(res.status).toBe(201);
  });
});
