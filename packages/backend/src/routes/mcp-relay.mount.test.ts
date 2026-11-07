import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { McpRegistryRepository, McpToolResult } from '@itphx/synth-core';
import type {
  McpRegistryOrigin,
  McpRegistryTrust,
  McpRemoteMode,
  McpServerConfig,
} from '@itphx/synth-shared';
import { createMcpRoutes } from './mcp.js';

/**
 * PROP-125 §1: монтирование серверного MCP-relay в backend.
 *
 * Проверяем, что маршрут `/api/v2/mcp/relay/:name` смонтирован и что его
 * авторизация совпадает с контрактом режима `tools` (`requireAuth` +
 * scope `mcp:invoke` для service-key).
 */

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

function userFromHeader(header: string | undefined): MockUser | null {
  if (header === 'Bearer admin') return { id: 'admin', username: 'admin', roles: ['ADMIN'] };
  if (header === 'Bearer dev') return { id: 'developer', username: 'developer', roles: ['USER'] };
  return null;
}

/** ADR-052/O1: mock service-key — `svc-mcp` несёт scope `mcp:invoke`. */
function serviceKeyFromHeader(
  header: string | undefined,
): { user: MockUser; scopes: string[] } | null {
  if (header === 'Bearer svc-mcp') {
    return { user: { id: 'service:svc1', username: 'invoker', roles: ['USER'] }, scopes: ['mcp:invoke'] };
  }
  if (header === 'Bearer svc-noscope') {
    return { user: { id: 'service:svc2', username: 'invoker', roles: ['USER'] }, scopes: [] };
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

interface MockRegistryEntry {
  id: string;
  name: string;
  config: McpServerConfig;
  origin: McpRegistryOrigin;
  trust: McpRegistryTrust;
  author: null;
  enabled: boolean;
  enabledByDefault: boolean;
  remoteMode?: McpRemoteMode;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

const NOW = '2026-11-07T00:00:00.000Z';

function makeEntry(
  name: string,
  overrides: Partial<MockRegistryEntry> = {},
): MockRegistryEntry {
  return {
    id: `id-${name}`,
    name,
    config: { type: 'http', url: 'https://mcp.example.com/mcp' },
    origin: 'instance',
    trust: 'builtin',
    author: null,
    enabled: true,
    enabledByDefault: false,
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Реестр-заглушка: только чтение (выдача `/remote/*` и `/relay/*`). */
function createMockRegistry(entries: MockRegistryEntry[]): McpRegistryRepository {
  return {
    list: async () => entries,
    get: async (id: string) => entries.find((e) => e.id === id) ?? null,
    getByName: async (name: string) => entries.find((e) => e.name === name) ?? null,
    add: async () => {
      throw new Error('не используется в тестах /relay/*');
    },
    update: async () => null,
    remove: async () => false,
    seedFromConfig: async () => 0,
    toServerConfigMap: async () => ({}),
    toOriginMap: async () => ({}),
    toTrustMap: async () => ({}),
    toAuthorMap: async () => ({}),
    toDefaultServers: async () => [],
    toManagerMaps: async () => ({
      servers: {},
      origins: {},
      trusts: {},
      authors: {},
      systemEnabled: {},
      defaults: [],
    }),
  } as unknown as McpRegistryRepository;
}

function createMockMcpManager() {
  const statuses = new Map<string, 'connected' | 'disconnected' | 'error' | 'circuit-open'>();
  const tools = new Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>();
  const instructions = new Map<string, string>();

  const manager = {
    statuses,
    tools,
    instructions,
    connectServer: vi.fn(async (name: string) => {
      statuses.set(name, 'connected');
    }),
    callServerTool: vi.fn(async (
      _server: string,
      _tool: string,
      _args: Record<string, unknown>,
      _meta?: Record<string, unknown>,
    ): Promise<McpToolResult> => ({ content: 'ok', isError: false })),
    getServerStatus: vi.fn((name: string) => statuses.get(name) ?? 'disconnected'),
    getServerTools: vi.fn((name: string) => tools.get(name) ?? null),
    getServerInstructions: vi.fn((name: string) => instructions.get(name)),
    // Методы реестровых роутов (`createMcpRegistryRoutes`) — заглушки.
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
  return manager;
}

describe('PROP-125: монтирование серверного MCP-relay (/api/v2/mcp/relay/*)', () => {
  let registryEntries: MockRegistryEntry[];
  let mcpManager: ReturnType<typeof createMockMcpManager>;

  function makeApp(entries: MockRegistryEntry[] = registryEntries) {
    const app = new Hono();
    const kit = createMockKit();
    // В реальном backend контекст ставит глобальный `attachUser`; в тест-харнесе
    // (роуты монтируются напрямую) воспроизводим его — иначе scope-guard'ы
    // не увидят service-кредентал.
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
      { registry: createMockRegistry(entries) },
    );
    app.route('/api/v2/mcp', routes);
    return app;
  }

  const jsonHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  const initializeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    },
  });

  beforeEach(() => {
    registryEntries = [
      makeEntry('srv-up', { remoteMode: 'relay', enabledByDefault: true }),
      makeEntry('srv-off', { enabled: false }),
    ];
    mcpManager = createMockMcpManager();
  });

  it('маршрут смонтирован: неизвестный сервер → 404 MCP_RELAY_SERVER_NOT_FOUND', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/unknown', {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: 'Bearer dev' },
      body: initializeBody,
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_RELAY_SERVER_NOT_FOUND');
  });

  it('GET без аутентификации → 401', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/unknown');
    expect(res.status).toBe(401);
  });

  it('POST без аутентификации → 401', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/unknown', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(401);
  });

  it('отключённый администратором сервер → 409 MCP_SERVER_DISABLED', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/srv-off', {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: 'Bearer dev' },
      body: initializeBody,
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_SERVER_DISABLED');
  });

  it('service-key без scope mcp:invoke → 403 SCOPE_REQUIRED', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/srv-up', {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: 'Bearer svc-noscope' },
      body: initializeBody,
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('service-key со scope mcp:invoke → 404 (доходит до реестра)', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/unknown', {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: 'Bearer svc-mcp' },
      body: initializeBody,
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_RELAY_SERVER_NOT_FOUND');
  });

  it('POST initialize → 200 и JSON-RPC result.serverInfo', async () => {
    mcpManager.tools.set('srv-up', [
      { name: 'tool1', description: 'First', inputSchema: { type: 'object' } },
    ]);
    mcpManager.instructions.set('srv-up', 'Инструкции сервера');

    const res = await makeApp().request('/api/v2/mcp/relay/srv-up', {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: 'Bearer dev' },
      body: initializeBody,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: number;
      result: { serverInfo: { name: string; version: string }; instructions?: string };
    };
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe('synth-hybrid-mcp');
    expect(body.result.instructions).toBe('Инструкции сервера');
    expect(mcpManager.connectServer).toHaveBeenCalledWith('srv-up');
  });

  it('GET с аутентификацией → 405 MCP_RELAY_SESSIONLESS', async () => {
    const res = await makeApp().request('/api/v2/mcp/relay/srv-up', {
      headers: { Authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(405);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_RELAY_SESSIONLESS');
  });
});
