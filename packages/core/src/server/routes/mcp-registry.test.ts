/**
 * ADR-071 §2.5: единый реестр MCP-серверов — core-фабрика HTTP-контура.
 *
 * Тест проверяет **core-дефолты** guard'ов (standalone-инстанс: локальный
 * пользователь — `ADMIN`; service-key — со scope'ами). Managed-специфика
 * (backend-guard'ы, i18n) покрыта в `packages/backend/src/routes/mcp-registry.test.ts`
 * — реализация там и здесь одна (core-фабрика).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig, McpNetworkPolicy } from '@itphx/synth-shared';
import { McpRegistryStore, MemoryExternalCredentialRepository } from '../../index.js';
import type { McpManager } from '../../engine/mcp/index.js';
import type { SessionManager } from '../../sessions/manager.js';
import { createMcpRegistryRoutes } from './mcp-registry.js';

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

const USERS: Record<string, MockUser> = {
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] },
  dev: { id: 'developer', username: 'developer', roles: ['USER'] },
  other: { id: 'other', username: 'other', roles: ['USER'] },
  local: { id: 'local', username: 'local', roles: ['ADMIN'] },
};

/** service-key (ADR-052): синтетический пользователь + scope'ы. */
const SERVICE_KEYS: Record<string, { user: MockUser; scopes: string[] }> = {
  'svc-scope': {
    user: { id: 'service:svc1', username: 'installer', roles: ['USER'] },
    scopes: ['addons:install'],
  },
  'svc-noscope': {
    user: { id: 'service:svc2', username: 'installer', roles: ['USER'] },
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

/** Auth-контракт фабрики: `requireAuth` + дефолтная проверка роли ADMIN. */
function createMockAuth() {
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
    getServerTools: vi.fn(() => []),
    probeServer: vi.fn(async () => []),
  };
}

const PUBLIC_IP = '93.184.216.34';
const httpConfig = (url = `http://${PUBLIC_IP}/mcp`): McpServerConfig => ({ type: 'sse', url });
const stdioConfig = (): McpServerConfig => ({ type: 'stdio', command: 'node', args: ['s.js'] });

describe('createMcpRegistryRoutes (core)', () => {
  let registry: McpRegistryStore;
  let credentials: MemoryExternalCredentialRepository;
  let tmpDir: string;
  let mcpManager: ReturnType<typeof createMockMcpManager>;
  let policy: McpNetworkPolicy;

  /**
   * `policyOverride` — политика сети для теста; `undefined` — дефолт (deny),
   * `null` — политики нет (проверка сети не применяется).
   */
  function makeApp(policyOverride?: McpNetworkPolicy | null, withCredentials = true) {
    const app = new Hono();
    // В standalone контекст ставит `requireAuth`; в тест-харнесе (роуты
    // монтируются напрямую) воспроизводим его для guard'ов, читающих
    // `user`/`serviceKey`.
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
    const routes = createMcpRegistryRoutes(
      createMockAuth(),
      mcpManager as unknown as McpManager,
      null,
      {
        registry,
        networkPolicy: policyOverride === undefined ? policy : (policyOverride ?? undefined),
        ...(withCredentials ? { credentials } : {}),
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
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-mcp-registry-'));
    registry = new McpRegistryStore({ dataDir: tmpDir });
    credentials = new MemoryExternalCredentialRepository();
    mcpManager = createMockMcpManager();
    policy = { mode: 'deny', list: ['10.0.0.0/8', '127.0.0.0/8'] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── CRUD реестра ──────────────────────────────────────────────────────────

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

  it('POST /registry: HTTP-сервер добавляет пользователя, автор фиксируется', async () => {
    const res = await postRegistry('dev', { name: 'user-http', config: httpConfig() });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string; author: { userId: string } };
    expect(entry.origin).toBe('user');
    expect(entry.trust).toBe('community');
    expect(entry.author.userId).toBe('developer');
    // Менеджер перечитал карты реестра (источник истины).
    expect(mcpManager.setConfig).toHaveBeenCalled();
  });

  it('POST /registry: невалидное тело → 400', async () => {
    const res = await postRegistry('dev', { name: '', config: {} });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /registry: дубликат имени → 409', async () => {
    await registry.add({ name: 'dup', config: httpConfig(), origin: 'user' });
    const res = await postRegistry('dev', { name: 'dup', config: httpConfig() });
    expect(res.status).toBe(409);
  });

  it('POST /registry: remoteMode=tools → 201 и сохраняется в записи', async () => {
    const res = await postRegistry('dev', { name: 'srv-tools', config: httpConfig(), remoteMode: 'tools' });
    expect(res.status).toBe(201);
    const entry = await res.json() as { id: string; remoteMode: string };
    expect(entry.remoteMode).toBe('tools');
    expect((await registry.get(entry.id))?.remoteMode).toBe('tools');
  });

  it('PUT /registry/:id: автор обновляет запись', async () => {
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

  it('PUT /registry/:id: чужой пользователь → 403, ADMIN → 200', async () => {
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

  // ── origin / trust ────────────────────────────────────────────────────────

  it('POST /registry: stdio не-админом → 403', async () => {
    const res = await postRegistry('dev', { name: 'bad-stdio', config: stdioConfig() });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('POST /registry: stdio админом → 201 instance/builtin', async () => {
    const res = await postRegistry('admin', { name: 'sys-stdio', config: stdioConfig(), enabledByDefault: true });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string; enabledByDefault: boolean };
    expect(entry.origin).toBe('instance');
    expect(entry.trust).toBe('builtin');
    expect(entry.enabledByDefault).toBe(true);
  });

  it('POST /registry: не-админ с origin:"instance" → остаётся user', async () => {
    const res = await postRegistry('dev', { name: 'dev-wants-instance', config: httpConfig(), origin: 'instance' });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string };
    expect(entry.origin).toBe('user');
    expect(entry.trust).toBe('community');
  });

  it('POST /registry: installer-ключ (scope addons:install) создаёт instance-запись', async () => {
    const res = await postRegistry('svc-scope', { name: 'installer-http', config: httpConfig() });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string; trust: string; author: { userId: string } };
    expect(entry.origin).toBe('instance');
    expect(entry.trust).toBe('builtin');
    expect(entry.author.userId).toBe('service:svc1');
  });

  it('POST /registry: service-key без scope → 403 SCOPE_REQUIRED', async () => {
    const res = await postRegistry('svc-noscope', { name: 'no-scope', config: httpConfig() });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  // ── ADR-105 Ф3: plaintext-секрет в заголовках запрещён ───────────────────

  describe('ADR-105 Ф3: запрет plaintext-секрета в заголовках', () => {
    const SECRET = 'Bearer super-secret-token';
    const secretConfig = (): McpServerConfig => ({
      type: 'sse',
      url: `http://${PUBLIC_IP}/mcp`,
      headers: { Authorization: SECRET },
    });

    it('POST /registry с секретом → 400 MCP_SECRET_HEADER_FORBIDDEN, запись не создана', async () => {
      const res = await postRegistry('admin', { name: 'srv-secret', config: secretConfig() });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('MCP_SECRET_HEADER_FORBIDDEN');
      expect(body.error.message).not.toContain(SECRET);
      expect(await registry.getByName('srv-secret')).toBeNull();
    });

    it('PUT /registry/:id с секретом → 400, запись не изменена', async () => {
      const entry = await registry.add({
        name: 'srv-plain',
        config: httpConfig(),
        origin: 'instance',
        trust: 'builtin',
        author: { userId: 'admin', username: 'admin' },
      });
      const res = await makeApp().request(`/api/v2/mcp/registry/${entry.id}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: secretConfig() }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('MCP_SECRET_HEADER_FORBIDDEN');
      expect((await registry.get(entry.id))?.config.headers).toBeUndefined();
    });
  });

  // ── ADR-071 §2.3.1: сетевая политика ──────────────────────────────────────

  it('POST /registry: приватный HTTP при deny → 400 NETWORK_POLICY_VIOLATION', async () => {
    const res = await postRegistry('dev', { name: 'private', config: httpConfig('http://10.0.0.5/mcp') });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NETWORK_POLICY_VIOLATION');
    expect(body.error.message).toContain('10.0.0.5');
  });

  it('POST /registry: приватный HTTP разрешён при allow-политике', async () => {
    const app = makeApp({ mode: 'allow', list: ['10.0.0.0/8'] });
    const res = await app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private-ok', config: httpConfig('http://10.0.0.5/mcp') }),
    });
    expect(res.status).toBe(201);
  });

  it('POST /registry: instance-origin (ADMIN) не блокируется сетевой политикой', async () => {
    const res = await postRegistry('admin', {
      name: 'internal',
      config: httpConfig('http://10.0.0.5/mcp'),
      origin: 'instance',
    });
    expect(res.status).toBe(201);
    const entry = await res.json() as { origin: string };
    expect(entry.origin).toBe('instance');
  });

  // ── ADR-105 Ф3: право привязки внешнего доступа ──────────────────────────

  it('POST /registry: привязка несуществующего доступа → 404, запись не создана', async () => {
    const res = await postRegistry('dev', {
      name: 'cred-missing',
      config: { type: 'http', url: 'https://api.example.com/mcp', auth: { kind: 'credential', credentialId: 'nope' } },
    });
    expect(res.status).toBe(404);
    expect(await registry.getByName('cred-missing')).toBeNull();
  });

  it('POST /registry: чужой доступ → 403', async () => {
    await credentials.create({
      provider: 'github',
      clientId: 'client-1',
      accessToken: 'token-secret',
      createdBy: 'developer',
      id: 'cred-other',
      owner: { kind: 'user', id: 'other' },
    });
    const res = await postRegistry('dev', {
      name: 'cred-foreign',
      config: { type: 'http', url: 'https://api.example.com/mcp', auth: { kind: 'credential', credentialId: 'cred-other' } },
    });
    expect(res.status).toBe(403);
    expect(await registry.getByName('cred-foreign')).toBeNull();
  });

  it('POST /registry: свой доступ → 201', async () => {
    await credentials.create({
      provider: 'github',
      clientId: 'client-1',
      accessToken: 'token-secret',
      createdBy: 'developer',
      id: 'cred-self',
      owner: { kind: 'user', id: 'developer' },
    });
    const res = await makeApp(null).request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'cred-self',
        config: { type: 'http', url: 'https://api.example.com/mcp', auth: { kind: 'credential', credentialId: 'cred-self' } },
      }),
    });
    expect(res.status).toBe(201);
  });

  it('POST /registry: без порта доступов привязка запрещена (fail-closed) → 403', async () => {
    const app = makeApp(null, false);
    const res = await app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'cred-noport',
        config: { type: 'http', url: 'https://api.example.com/mcp', auth: { kind: 'credential', credentialId: 'cred-self' } },
      }),
    });
    expect(res.status).toBe(403);
  });

  // ── Legacy `/servers*` (адаптеры над реестром) ───────────────────────────

  it('GET /servers отдаёт записи реестра', async () => {
    await registry.add({ name: 'legacy-a', config: httpConfig(), origin: 'instance', trust: 'builtin' });
    const res = await makeApp().request('/api/v2/mcp/servers', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, { name: string }>;
    expect(body['legacy-a']?.name).toBe('legacy-a');
  });

  it('POST /servers: не-админом → 403 (core-дефолт requireAdmin)', async () => {
    const res = await makeApp().request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'legacy-add', config: httpConfig() }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('POST /servers: админом → 201 instance-запись', async () => {
    const res = await makeApp().request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'legacy-add', config: httpConfig() }),
    });
    expect(res.status).toBe(201);
    const entry = await registry.getByName('legacy-add');
    expect(entry?.origin).toBe('instance');
    expect(entry?.trust).toBe('builtin');
  });

  it('DELETE /servers/:name: service-key без scope → 403 SCOPE_REQUIRED', async () => {
    await registry.add({ name: 'srv-x', config: httpConfig(), origin: 'instance', trust: 'builtin' });
    const res = await makeApp().request('/api/v2/mcp/servers/srv-x', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer svc-noscope' },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('DELETE /servers/:name: installer-ключ со scope → 200', async () => {
    await registry.add({ name: 'srv-ops', config: httpConfig(), origin: 'instance', trust: 'builtin' });
    const res = await makeApp().request('/api/v2/mcp/servers/srv-ops', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer svc-scope' },
    });
    expect(res.status).toBe(200);
    expect(await registry.getByName('srv-ops')).toBeNull();
  });
});

describe('createMcpRegistryRoutes: session-owner guard (legacy /session/:id)', () => {
  let registry: McpRegistryStore;
  let tmpDir: string;
  let mcpManager: ReturnType<typeof createMockMcpManager>;
  let sessions: Map<string, { id: string; ownerId: string; settings: Record<string, unknown> }>;

  function makeApp() {
    const app = new Hono();
    app.use('*', async (c: Context, next: Next) => {
      const auth = resolveAuth(c.req.header('Authorization'));
      if (auth) c.set('user', auth.user);
      await next();
    });
    const sessionManager = {
      getSession: async (id: string) => (sessions.get(id) ?? null),
      saveSession: async (session: { id: string; ownerId: string; settings: Record<string, unknown> }) => {
        sessions.set(session.id, session);
      },
    } as unknown as SessionManager;
    const routes = createMcpRegistryRoutes(
      createMockAuth(),
      mcpManager as unknown as McpManager,
      sessionManager,
      { registry },
    );
    app.route('/api/v2/mcp', routes);
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-mcp-session-'));
    registry = new McpRegistryStore({ dataDir: tmpDir });
    mcpManager = createMockMcpManager();
    sessions = new Map([
      ['own', { id: 'own', ownerId: 'developer', settings: { mcpServers: [] } }],
      ['foreign', { id: 'foreign', ownerId: 'other', settings: { mcpServers: [] } }],
    ]);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('владелец читает MCP-скоуп своей сессии', async () => {
    const res = await makeApp().request('/api/v2/mcp/session/own', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { mcpServers: string[] };
    expect(body.mcpServers).toEqual([]);
  });

  it('чужая сессия → 403 (инвариант 16: guard на границе)', async () => {
    const res = await makeApp().request('/api/v2/mcp/session/foreign', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(403);
  });

  it('несуществующая сессия → 404', async () => {
    const res = await makeApp().request('/api/v2/mcp/session/missing', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(404);
  });

  it('ADMIN читает чужую сессию', async () => {
    const res = await makeApp().request('/api/v2/mcp/session/foreign', {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(200);
  });

  it('PUT /session/:id: несуществующий сервер → 400', async () => {
    const res = await makeApp().request('/api/v2/mcp/session/own', {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: ['unknown-server'] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /session/:id: известный сервер сохраняется в скоуп сессии', async () => {
    await registry.add({ name: 'known', config: httpConfig(), origin: 'user' });
    const res = await makeApp().request('/api/v2/mcp/session/own', {
      method: 'PUT',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: ['known'] }),
    });
    expect(res.status).toBe(200);
    expect(sessions.get('own')?.settings.mcpServers).toEqual(['known']);
  });
});
