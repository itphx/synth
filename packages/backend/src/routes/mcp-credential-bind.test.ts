/**
 * ADR-105 (Ф3): право привязки внешнего доступа к коннектору — матрица.
 *
 * Проверка — **на границе** (инвариант 16): правило живёт в core
 * (`engine/oauth/credential-binding.ts`), backend только собирает актора и
 * маппит решение в код ответа.
 *
 * Матрица: владелец своего доступа → ok; `ADMIN`/`LEAD` → инстансный доступ
 * ok; участник проекта с правом изменения → проектный доступ ok; `VIEWER` →
 * 403; чужой доступ → 403; несуществующий → 404; service-key — по роли/scope.
 *
 * Отдельно: несуществующий `credentialId` не должен оставлять запись в реестре
 * (проверка идёт **до** записи).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRegistryStore, MemoryExternalCredentialRepository } from '@itphx/synth-core';
import { createMcpRoutes } from './mcp.js';
import type { McpServerConfig } from '@itphx/synth-shared';

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

/** Пользователи инстанса: роли — глобальные (`ADMIN`/`LEAD`/`USER`). */
const USERS: Record<string, MockUser> = {
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] },
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] },
  dev: { id: 'developer', username: 'developer', roles: ['USER'] },
  other: { id: 'other', username: 'other', roles: ['USER'] },
  owner: { id: 'owner', username: 'owner', roles: ['USER'] },
  editor: { id: 'editor', username: 'editor', roles: ['USER'] },
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] },
};

/** service-key (ADR-052): синтетический пользователь + scope'ы. */
const SERVICE_KEYS: Record<string, { user: MockUser; scopes: string[] }> = {
  'svc-admin': {
    user: { id: 'service:svc1', username: 'svc-admin', roles: ['ADMIN'] },
    scopes: ['addons:install'],
  },
  'svc-user': {
    user: { id: 'service:svc2', username: 'svc-user', roles: ['USER'] },
    scopes: ['addons:install'],
  },
  'svc-noscope': {
    user: { id: 'service:svc3', username: 'svc-noscope', roles: ['USER'] },
    scopes: [],
  },
};

function resolveAuth(header: string | undefined): { user: MockUser; scopes?: string[] } | null {
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const svc = SERVICE_KEYS[token];
  if (svc) return { user: svc.user, scopes: svc.scopes };
  const user = USERS[token];
  return user ? { user } : null;
}

function createMockKit() {
  const currentUser = (c: { get(key: 'user'): unknown }): MockUser | undefined =>
    c.get('user') as MockUser | undefined;

  return {
    requireAuth: async (c: Context, next: Next) => {
      const auth = resolveAuth(c.req.header('Authorization'));
      if (!auth) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
      }
      c.set('user', auth.user);
      if (auth.scopes) {
        c.set('serviceKey', {
          keyId: auth.user.id,
          label: auth.user.username,
          roles: auth.user.roles,
          scopes: auth.scopes,
        });
      }
      await next();
    },
    requireAdmin: async (c: Context, next: Next) => {
      const user = currentUser(c);
      if (!user || !user.roles.includes('ADMIN')) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    isAdmin: (c: { get(key: 'user'): unknown }): boolean =>
      !!currentUser(c)?.roles.includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, role: string): boolean =>
      !!currentUser(c)?.roles.includes(role),
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

/** Конфиг коннектора с привязкой внешнего доступа (ADR-105 §5). */
const credConfig = (credentialId: string): McpServerConfig => ({
  type: 'http',
  url: 'https://api.example.com/mcp',
  auth: { kind: 'credential', credentialId },
});

const plainConfig = (): McpServerConfig => ({
  type: 'http',
  url: 'https://api.example.com/mcp',
});

describe('MCP: право привязки внешнего доступа (ADR-105 Ф3)', () => {
  let registry: McpRegistryStore;
  let credentials: MemoryExternalCredentialRepository;
  let tmpDir: string;
  let mcpManager: ReturnType<typeof createMockMcpManager>;

  function makeApp() {
    const app = new Hono();
    const kit = createMockKit();
    // Реальный backend вешает глобальный `attachUser`; в тест-харнесе
    // (роуты монтируются напрямую) воспроизводим его.
    app.use('*', async (c: Context, next: Next) => {
      const auth = resolveAuth(c.req.header('Authorization'));
      if (auth) {
        c.set('user', auth.user);
        if (auth.scopes) {
          c.set('serviceKey', {
            keyId: auth.user.id,
            label: auth.user.username,
            roles: auth.user.roles,
            scopes: auth.scopes,
          });
        }
      }
      await next();
    });
    const routes = createMcpRoutes(
      kit as never,
      mcpManager as never,
      null,
      {
        registry,
        credentials,
        // Участники проекта `p1`: `owner`/`editor` — право изменения содержимого,
        // `viewer` — только чтение; `ADMIN`/`LEAD` — сквозное право.
        canEditProject: (c, projectId) => {
          const user = c.get('user') as MockUser | undefined;
          if (!user) return false;
          if (user.roles.includes('ADMIN') || user.roles.includes('LEAD')) return true;
          if (projectId !== 'p1') return false;
          return user.id === 'owner' || user.id === 'editor';
        },
      },
    );
    app.route('/api/v2/mcp', routes);
    return app;
  }

  function postRegistry(token: string, body: unknown) {
    return makeApp().request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mcp-cred-bind-'));
    registry = new McpRegistryStore({ dataDir: tmpDir });
    mcpManager = createMockMcpManager();
    credentials = new MemoryExternalCredentialRepository();
    const base = {
      provider: 'github',
      clientId: 'client-1',
      accessToken: 'token-secret',
      createdBy: 'admin',
    };
    // Свой доступ пользователя `developer`.
    await credentials.create({
      ...base,
      id: 'cred-self',
      owner: { kind: 'user', id: 'developer' },
    });
    // Инстансный доступ (выдаёт инстанс).
    await credentials.create({
      ...base,
      id: 'cred-instance',
      owner: { kind: 'instance', id: 'instance' },
    });
    // Проектный доступ уровня проекта `p1`.
    await credentials.create({
      ...base,
      id: 'cred-project',
      owner: { kind: 'user', id: 'owner' },
      projectId: 'p1',
    });
    // Чужой личный доступ.
    await credentials.create({
      ...base,
      id: 'cred-foreign',
      owner: { kind: 'user', id: 'someone-else' },
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- Матрица права (POST /registry — точка записи `auth`) ------------------

  it('владелец своего доступа привязывает его — 201', async () => {
    const res = await postRegistry('dev', { name: 'own', config: credConfig('cred-self') });
    expect(res.status).toBe(201);
    const entry = await res.json() as { config: { auth?: { kind: string; credentialId: string } } };
    expect(entry.config.auth).toEqual({ kind: 'credential', credentialId: 'cred-self' });
  });

  it('ADMIN привязывает инстансный доступ — 201', async () => {
    const res = await postRegistry('admin', { name: 'inst-admin', config: credConfig('cred-instance') });
    expect(res.status).toBe(201);
  });

  it('LEAD привязывает инстансный доступ — 201', async () => {
    const res = await postRegistry('lead', { name: 'inst-lead', config: credConfig('cred-instance') });
    expect(res.status).toBe(201);
  });

  it('обычный пользователь не привязывает инстансный доступ — 403', async () => {
    const res = await postRegistry('dev', { name: 'inst-user', config: credConfig('cred-instance') });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('участник проекта с правом изменения привязывает проектный доступ — 201', async () => {
    const res = await postRegistry('editor', { name: 'proj-editor', config: credConfig('cred-project') });
    expect(res.status).toBe(201);
  });

  it('владелец проекта привязывает проектный доступ — 201', async () => {
    const res = await postRegistry('owner', { name: 'proj-owner', config: credConfig('cred-project') });
    expect(res.status).toBe(201);
  });

  it('VIEWER (только чтение) не привязывает проектный доступ — 403', async () => {
    const res = await postRegistry('viewer', { name: 'proj-viewer', config: credConfig('cred-project') });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('чужой личный доступ — 403', async () => {
    const res = await postRegistry('other', { name: 'foreign', config: credConfig('cred-foreign') });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('несуществующий доступ — 404', async () => {
    const res = await postRegistry('dev', { name: 'missing', config: credConfig('cred-missing') });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('service-key с ролью ADMIN привязывает инстансный доступ — 201', async () => {
    const res = await postRegistry('svc-admin', { name: 'svc-admin', config: credConfig('cred-instance') });
    expect(res.status).toBe(201);
  });

  it('service-key без роли ADMIN инстансный доступ не привязывает — 403', async () => {
    const res = await postRegistry('svc-user', { name: 'svc-user', config: credConfig('cred-instance') });
    expect(res.status).toBe(403);
  });

  it('service-key без scope addons:install — 403 SCOPE_REQUIRED', async () => {
    const res = await postRegistry('svc-noscope', { name: 'svc-noscope', config: credConfig('cred-self') });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('привязка несуществующего credentialId не создаёт запись в реестре', async () => {
    const res = await postRegistry('dev', { name: 'ghost', config: credConfig('cred-missing') });
    expect(res.status).toBe(404);
    const list = await makeApp().request('/api/v2/mcp/registry', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
  });

  it('коннектор без привязки доступа создаётся как раньше — 201', async () => {
    const res = await postRegistry('dev', { name: 'plain', config: plainConfig() });
    expect(res.status).toBe(201);
  });

  // --- Legacy `/servers` (точки записи `auth`) -----------------------------

  it('POST /servers: ADMIN привязывает инстансный доступ — 201', async () => {
    const res = await makeApp().request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv-inst', config: credConfig('cred-instance') }),
    });
    expect(res.status).toBe(201);
  });

  it('POST /servers: несуществующий доступ — 404', async () => {
    const res = await makeApp().request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv-missing', config: credConfig('cred-missing') }),
    });
    expect(res.status).toBe(404);
  });

  it('PUT /servers/:name: ADMIN добавляет привязку — 200', async () => {
    await registry.add({ name: 'srv', config: plainConfig(), origin: 'instance', trust: 'builtin' });
    const res = await makeApp().request('/api/v2/mcp/servers/srv', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify(credConfig('cred-instance')),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { config: { auth?: { credentialId: string } } };
    expect(body.config.auth?.credentialId).toBe('cred-instance');
  });

  it('PUT /servers/:name: смена привязки на чужую — 403', async () => {
    await registry.add({
      name: 'srv',
      config: credConfig('cred-instance'),
      origin: 'instance',
      trust: 'builtin',
    });
    const res = await makeApp().request('/api/v2/mcp/servers/srv', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify(credConfig('cred-foreign')),
    });
    expect(res.status).toBe(403);
  });

  it('PUT /servers/:name: та же привязка — право не переспрашивается (200)', async () => {
    await registry.add({
      name: 'srv',
      config: credConfig('cred-instance'),
      origin: 'instance',
      trust: 'builtin',
    });
    const res = await makeApp().request('/api/v2/mcp/servers/srv', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify(credConfig('cred-instance')),
    });
    expect(res.status).toBe(200);
  });

  // --- Реестр: обновление записи (`PUT /registry/:id`) -----------------------

  it('PUT /registry/:id: автор привязывает свой доступ — 200', async () => {
    const entry = await registry.add({
      name: 'reg',
      config: plainConfig(),
      origin: 'user',
      trust: 'community',
      author: { userId: 'developer', username: 'developer' },
    });
    const res = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: credConfig('cred-self') }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { config: { auth?: { credentialId: string } } };
    expect(body.config.auth?.credentialId).toBe('cred-self');
  });

  it('PUT /registry/:id: несуществующий доступ — 404 и запись не меняется', async () => {
    const entry = await registry.add({
      name: 'reg',
      config: plainConfig(),
      origin: 'user',
      trust: 'community',
      author: { userId: 'developer', username: 'developer' },
    });
    const res = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: credConfig('cred-missing') }),
    });
    expect(res.status).toBe(404);
    const stored = await registry.get(entry.id);
    expect(stored?.config.auth).toBeUndefined();
  });

  it('PUT /registry/:id: чужой доступ — 403', async () => {
    const entry = await registry.add({
      name: 'reg',
      config: plainConfig(),
      origin: 'user',
      trust: 'community',
      author: { userId: 'developer', username: 'developer' },
    });
    const res = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: credConfig('cred-foreign') }),
    });
    expect(res.status).toBe(403);
  });
});
