import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMcpRoutes, type McpConfigStore } from './mcp.js';
import type { McpServerConfig, SessionSettings } from '@itphx/synth-shared';

function createMockKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
    requireAdmin: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

function createMockConfigStore(servers: Record<string, McpServerConfig> = {}): McpConfigStore {
  const store = new Map(Object.entries(servers));
  return {
    getServers() {
      return Object.fromEntries(store);
    },
    async addServer(name: string, config: McpServerConfig) {
      store.set(name, config);
    },
    async updateServer(name: string, config: McpServerConfig) {
      store.set(name, config);
    },
    async deleteServer(name: string) {
      store.delete(name);
    },
    hasServer(name: string) {
      return store.has(name);
    },
    getServer(name: string) {
      return store.get(name);
    },
  };
}

function makeStdioConfig(): McpServerConfig {
  return {
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
  };
}

function makeSseConfig(): McpServerConfig {
  return {
    type: 'sse',
    url: 'http://localhost:8080/mcp',
  };
}

function createMockMcpManager(connected: boolean = false) {
  return {
    getConfiguredServers: vi.fn(() => [
      { name: 'test-server', config: makeStdioConfig(), connected },
    ]),
    isServerConfigured: vi.fn((name: string) => name === 'test-server'),
    getServerConfig: vi.fn((name: string) => (name === 'test-server' ? makeStdioConfig() : undefined)),
    connectServer: vi.fn(),
    disconnectServer: vi.fn(),
    disconnectAll: vi.fn(),
    probeServer: vi.fn(async (name: string) => {
      if (name !== 'test-server') throw new Error(`MCP-сервер "${name}" не настроен`);
      return [
        { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
        { name: 'tool2', description: 'Second tool', inputSchema: { type: 'object' } },
      ];
    }),
    getServerTools: vi.fn((name: string) => {
      if (name !== 'test-server') return null;
      return connected
        ? [
            { name: 'tool1', description: 'First', inputSchema: { type: 'object' } },
            { name: 'tool2', description: 'Second', inputSchema: { type: 'object' } },
          ]
        : null;
    }),
    refreshServer: vi.fn(),
    setConfig: vi.fn(),
    getConfig: vi.fn(() => ({ 'test-server': makeStdioConfig() })),
  };
}

function createMockSessionManager() {
  const sessions = new Map<string, { id: string; settings: SessionSettings }>();
  return {
    getSession: async (id: string) => {
      return sessions.get(id) ?? null;
    },
    saveSession: async (session: { id: string; settings: SessionSettings }) => {
      sessions.set(session.id, session);
    },
    _setSession(id: string, settings: Partial<SessionSettings>) {
      sessions.set(id, { id, settings: settings as SessionSettings });
    },
  };
}

function createTestApp(configStore: McpConfigStore, mcpManager: ReturnType<typeof createMockMcpManager>, sessionManager: ReturnType<typeof createMockSessionManager>) {
  const app = new Hono();
  const kit = createMockKit();
  const mcpRoutes = createMcpRoutes(kit as any, configStore, mcpManager as any, sessionManager as any);
  app.route('/api/v2/mcp', mcpRoutes);
  return app;
}

describe('MCP API Routes', () => {
  let configStore: McpConfigStore;
  let mcpManager: ReturnType<typeof createMockMcpManager>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    configStore = createMockConfigStore({ 'test-server': makeStdioConfig() });
    mcpManager = createMockMcpManager(true);
    sessionManager = createMockSessionManager();
  });

  describe('GET /api/v2/mcp/servers', () => {
    it('возвращает список серверов со статусом подключения', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body['test-server']).toBeDefined();
      expect(body['test-server'].config.type).toBe('stdio');
      expect(body['test-server'].connected).toBe(true);
    });

    it('возвращает empty объект когда серверов нет', async () => {
      configStore = createMockConfigStore({});
      mcpManager = createMockMcpManager(false);
      mcpManager.getConfiguredServers.mockReturnValue([]);
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(Object.keys(body)).toHaveLength(0);
    });
  });

  describe('POST /api/v2/mcp/servers', () => {
    it('добавляет новый сервер', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'new-server',
          config: { type: 'stdio', command: 'python', args: ['server.py'] },
        }),
      });
      expect(res.status).toBe(201);
      expect(configStore.hasServer('new-server')).toBe(true);
    });

    it('AD-071: сохраняет description сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'described',
          config: { type: 'sse', url: 'http://localhost/mcp', description: 'Мой MCP' },
        }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.config.description).toBe('Мой MCP');
      expect(configStore.getServer('described')?.description).toBe('Мой MCP');
    });

    it('возвращает 409 для дубликата', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-server',
          config: makeStdioConfig(),
        }),
      });
      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body.error.code).toBe('CONFLICT');
    });

    it('возвращает 400 для невалидного тела', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', config: {} }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v2/mcp/servers/:name', () => {
    it('возвращает конфигурацию сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.name).toBe('test-server');
      expect(body.config.type).toBe('stdio');
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v2/mcp/servers/:name', () => {
    it('обновляет существующий сервер', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeSseConfig()),
      });
      expect(res.status).toBe(200);
      expect(configStore.getServer('test-server')?.type).toBe('sse');
      expect(mcpManager.setConfig).toHaveBeenCalled();
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeStdioConfig()),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v2/mcp/servers/:name', () => {
    it('удаляет сервер', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(configStore.hasServer('test-server')).toBe(false);
      expect(mcpManager.disconnectServer).toHaveBeenCalledWith('test-server');
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/mcp/servers/:name/test', () => {
    it('успешно тестирует подключение', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/test', { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.tools).toHaveLength(2);
    });

    it('возвращает ошибку для неизвестного сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown/test', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('возвращает ошибку при сбое probe', async () => {
      mcpManager.probeServer.mockRejectedValueOnce(new Error('Connection timeout'));
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/test', { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Connection timeout');
    });
  });

  describe('POST /api/v2/mcp/probe', () => {
    it('успешно пробует сервер и возвращает инструменты', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-server' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.name).toBe('test-server');
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0]).toEqual({ name: 'tool1', description: 'First tool' });
    });

    it('возвращает 400 для пустого name', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  ' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 400 для ненастроенного сервера', async () => {
      mcpManager.isServerConfigured.mockReturnValue(false);
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'unknown' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 500 при сбое probe', async () => {
      mcpManager.probeServer.mockRejectedValueOnce(new Error('Connection timeout'));
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-server' }),
      });
      expect(res.status).toBe(500);
      const body: any = await res.json();
      expect(body.error.code).toBe('MCP_CONNECT_ERROR');
      expect(body.error.message).toContain('Connection timeout');
    });
  });

  describe('GET /api/v2/mcp/servers/:name/tools', () => {
    it('возвращает инструменты подключённого сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/tools');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.server).toBe('test-server');
      expect(body.connected).toBe(true);
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].name).toBe('tool1');
    });

    it('пробует получить инструменты отключённого сервера', async () => {
      mcpManager = createMockMcpManager(false);
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/tools');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.connected).toBe(false);
      expect(body.probed).toBe(true);
      expect(body.tools).toHaveLength(2);
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown/tools');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/mcp/session/:sessionId', () => {
    it('возвращает активные MCP-серверы сессии', async () => {
      sessionManager._setSession('s1', { mcpServers: ['test-server', 'other'] });
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/s1');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mcpServers).toContain('test-server');
      const testSrv = body.allServers.find((s: any) => s.name === 'test-server');
      expect(testSrv).toBeDefined();
      expect(testSrv.active).toBe(true);
    });

    it('возвращает 404 для несуществующей сессии', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v2/mcp/session/:sessionId', () => {
    it('устанавливает активные MCP-серверы для сессии', async () => {
      sessionManager._setSession('s1', { mcpServers: [] });
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/s1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: ['test-server'] }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mcpServers).toContain('test-server');
    });

    it('возвращает 400 для невалидного тела', async () => {
      sessionManager._setSession('s1', { mcpServers: [] });
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/s1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong: 'field' }),
      });
      expect(res.status).toBe(400);
    });

    it('возвращает 404 для несуществующей сессии', async () => {
      const app = createTestApp(configStore, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/nonexistent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: ['test-server'] }),
      });
      expect(res.status).toBe(404);
    });
  });
});
