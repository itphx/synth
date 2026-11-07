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

/**
 * ADR-052/O1: mock service-key — `svc-mcp` несёт scope `mcp:invoke`,
 * `svc-noscope` — пустые scopes.
 */
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
  /** PROP-125: у части записей поле отсутствует (записи до PROP-125). */
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

/** Реестр-заглушка: только чтение (выдача `/remote/*`). */
function createMockRegistry(entries: MockRegistryEntry[]): McpRegistryRepository {
  return {
    list: async () => entries,
    get: async (id: string) => entries.find((e) => e.id === id) ?? null,
    getByName: async (name: string) => entries.find((e) => e.name === name) ?? null,
    add: async () => {
      throw new Error('не используется в тестах /remote/*');
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

type ManagerStatus = 'connected' | 'disconnected' | 'error' | 'circuit-open';

function createMockMcpManager() {
  const statuses = new Map<string, ManagerStatus>();
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
    getServerStatus: vi.fn((name: string): ManagerStatus => statuses.get(name) ?? 'disconnected'),
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

describe('PROP-125: backend-контракт удалённого MCP (/api/v2/mcp/remote/*)', () => {
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

  beforeEach(() => {
    registryEntries = [
      makeEntry('srv-up', { remoteMode: 'tools', enabledByDefault: true }),
      makeEntry('srv-idle'),
    ];
    mcpManager = createMockMcpManager();
  });

  it('роуты требуют аутентификации (401)', async () => {
    const app = makeApp();
    expect((await app.request('/api/v2/mcp/remote/servers')).status).toBe(401);
    expect((await app.request('/api/v2/mcp/remote/tools?server=srv-up')).status).toBe(401);
    const call = await app.request('/api/v2/mcp/remote/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'srv-up', tool: 'tool1' }),
    });
    expect(call.status).toBe(401);
  });

  describe('GET /remote/servers', () => {
    it('отдаёт все записи реестра со статусом и числом тулов', async () => {
      mcpManager.statuses.set('srv-up', 'connected');
      mcpManager.tools.set('srv-up', [
        { name: 'tool1', description: 'First', inputSchema: { type: 'object' } },
        { name: 'tool2', description: 'Second', inputSchema: { type: 'object' } },
      ]);
      mcpManager.instructions.set('srv-up', 'Инструкции сервера');

      const res = await makeApp().request('/api/v2/mcp/remote/servers', {
        headers: { Authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{
        name: string;
        type: string;
        origin: string;
        trust: string;
        enabled: boolean;
        enabledByDefault: boolean;
        remoteMode: string;
        status: string;
        toolCount: number;
        instructions?: string;
      }>;
      expect(body).toHaveLength(2);
      const up = body.find((s) => s.name === 'srv-up')!;
      expect(up.type).toBe('http');
      expect(up.origin).toBe('instance');
      expect(up.trust).toBe('builtin');
      expect(up.enabled).toBe(true);
      expect(up.enabledByDefault).toBe(true);
      expect(up.remoteMode).toBe('tools');
      expect(up.status).toBe('up');
      expect(up.toolCount).toBe(2);
      expect(up.instructions).toBe('Инструкции сервера');

      const idle = body.find((s) => s.name === 'srv-idle')!;
      expect(idle.remoteMode).toBe('auto');
      expect(idle.status).toBe('idle');
      expect(idle.toolCount).toBe(0);
    });

    it('в ответе нет конфига, URL и заголовков (секреты наружу не уходят)', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/servers', {
        headers: { Authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain('mcp.example.com');
      expect(raw).not.toContain('config');
      expect(raw).not.toContain('headers');
      expect(raw).not.toContain('url');
    });

    it('статус down при ошибке подключения', async () => {
      mcpManager.statuses.set('srv-up', 'error');
      const res = await makeApp().request('/api/v2/mcp/remote/servers', {
        headers: { Authorization: 'Bearer dev' },
      });
      const body = await res.json() as Array<{ name: string; status: string }>;
      expect(body.find((s) => s.name === 'srv-up')!.status).toBe('down');
    });
  });

  describe('GET /remote/tools', () => {
    it('подключённый сервер → 200 с тулами и instructions', async () => {
      mcpManager.statuses.set('srv-up', 'connected');
      mcpManager.tools.set('srv-up', [
        { name: 'tool1', description: 'First', inputSchema: { type: 'object' } },
      ]);
      mcpManager.instructions.set('srv-up', 'Инструкции сервера');

      const res = await makeApp().request('/api/v2/mcp/remote/tools?server=srv-up', {
        headers: { Authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        server: string;
        instructions?: string;
        tools: Array<{ server: string; name: string; description: string; inputSchema: Record<string, unknown> }>;
      };
      expect(body.server).toBe('srv-up');
      expect(body.instructions).toBe('Инструкции сервера');
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]!.server).toBe('srv-up');
      expect(body.tools[0]!.name).toBe('tool1');
    });

    it('без параметра server → 400 VALIDATION_ERROR', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/tools', {
        headers: { Authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('неизвестный сервер → 404 MCP_REMOTE_SERVER_NOT_FOUND', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/tools?server=missing', {
        headers: { Authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('MCP_REMOTE_SERVER_NOT_FOUND');
    });

    it('ошибка подключения → 502 MCP_REMOTE_SERVER_DOWN', async () => {
      mcpManager.statuses.set('srv-up', 'disconnected');
      mcpManager.connectServer.mockRejectedValueOnce(new Error('connect failed'));

      const res = await makeApp().request('/api/v2/mcp/remote/tools?server=srv-up', {
        headers: { Authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(502);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('MCP_REMOTE_SERVER_DOWN');
      expect(body.error.message).toBe('connect failed');
    });
  });

  describe('POST /remote/call', () => {
    it('вызов инструмента → 200 {content,isError}', async () => {
      mcpManager.statuses.set('srv-up', 'connected');
      mcpManager.callServerTool.mockResolvedValueOnce({ content: 'результат', isError: false });

      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-up', tool: 'tool1', arguments: { a: 1 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string; isError: boolean };
      expect(body.content).toBe('результат');
      expect(body.isError).toBe(false);
      expect(mcpManager.callServerTool).toHaveBeenCalledWith('srv-up', 'tool1', { a: 1 }, undefined);
    });

    it('вложения результата пробрасываются в ответе', async () => {
      mcpManager.statuses.set('srv-up', 'connected');
      mcpManager.callServerTool.mockResolvedValueOnce({
        content: 'снимок',
        isError: false,
        attachments: [{ mime: 'image/png', name: 'shot.png', base64: 'AAAA' }],
      });

      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-up', tool: 'shot' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        content: string;
        isError: boolean;
        attachments?: Array<{ mime: string; name?: string; base64: string }>;
      };
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments![0]!.mime).toBe('image/png');
      expect(body.attachments![0]!.name).toBe('shot.png');
      expect(body.attachments![0]!.base64).toBe('AAAA');
    });

    it('невалидное тело → 400 VALIDATION_ERROR', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: '', tool: '' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(mcpManager.callServerTool).not.toHaveBeenCalled();
    });

    it('не-объект в arguments → 400 VALIDATION_ERROR', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-up', tool: 'tool1', arguments: 'oops' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(mcpManager.callServerTool).not.toHaveBeenCalled();
    });

    it('неизвестный сервер → 404 MCP_REMOTE_SERVER_NOT_FOUND', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'missing', tool: 'tool1' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('MCP_REMOTE_SERVER_NOT_FOUND');
    });

    it('отключённый администратором сервер → 409 MCP_SERVER_DISABLED', async () => {
      const entries = [makeEntry('srv-off', { enabled: false })];
      const res = await makeApp(entries).request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-off', tool: 'tool1' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('MCP_SERVER_DISABLED');
      expect(body.error.message).toBe('MCP-сервер отключён администратором');
      expect(mcpManager.callServerTool).not.toHaveBeenCalled();
    });

    it('ошибка вызова → 502 MCP_REMOTE_CALL_FAILED', async () => {
      mcpManager.statuses.set('srv-up', 'connected');
      mcpManager.callServerTool.mockRejectedValueOnce(new Error('call boom'));

      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-up', tool: 'tool1' }),
      });
      expect(res.status).toBe(502);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('MCP_REMOTE_CALL_FAILED');
      expect(body.error.message).toBe('call boom');
    });

    it('service-key без scope mcp:invoke → 403 SCOPE_REQUIRED', async () => {
      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer svc-noscope', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-up', tool: 'tool1' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('SCOPE_REQUIRED');
      expect(mcpManager.callServerTool).not.toHaveBeenCalled();
    });

    it('service-key со scope mcp:invoke → 200', async () => {
      mcpManager.statuses.set('srv-up', 'connected');
      mcpManager.callServerTool.mockResolvedValueOnce({ content: 'через ключ', isError: false });

      const res = await makeApp().request('/api/v2/mcp/remote/call', {
        method: 'POST',
        headers: { Authorization: 'Bearer svc-mcp', 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'srv-up', tool: 'tool1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBe('через ключ');
    });
  });
});
