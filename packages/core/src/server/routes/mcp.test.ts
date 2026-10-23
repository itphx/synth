import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMcpRoutes } from './mcp.js';
import type { McpManager } from '../../engine/mcp/index.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createMockMcpManager(overrides: Partial<McpManager> = {}): McpManager {
  return {
    isServerConfigured: vi.fn(() => false),
    getServerConfig: vi.fn(() => undefined),
    probeServer: vi.fn(),
    ...overrides,
  } as unknown as McpManager;
}

function createTestApp(mcpManager: McpManager) {
  const app = new Hono();
  app.route('/api/v2/mcp', createMcpRoutes(createMockAuth(), { mcpManager }));
  return app;
}

describe('MCP API Routes (probe)', () => {
  it('POST /probe возвращает список инструментов сервера', async () => {
    const probeServer = vi.fn().mockResolvedValue([
      { name: 'list_issues', description: 'Список issues', inputSchema: { type: 'object' } },
      { name: 'create_issue', description: 'Создать issue', inputSchema: { type: 'object' } },
    ]);
    const mcpManager = createMockMcpManager({
      isServerConfigured: vi.fn(() => true) as McpManager['isServerConfigured'],
      probeServer: probeServer as McpManager['probeServer'],
    });
    const app = createTestApp(mcpManager);

    const res = await app.request('/api/v2/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'github' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.name).toBe('github');
    expect(body.tools).toEqual([
      { name: 'list_issues', description: 'Список issues' },
      { name: 'create_issue', description: 'Создать issue' },
    ]);
  });

  it('POST /probe для ненастроенного сервера → 400 VALIDATION_ERROR', async () => {
    const mcpManager = createMockMcpManager();
    const app = createTestApp(mcpManager);

    const res = await app.request('/api/v2/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'unknown' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /probe с пустым name → 400 VALIDATION_ERROR', async () => {
    const mcpManager = createMockMcpManager();
    const app = createTestApp(mcpManager);

    const res = await app.request('/api/v2/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /probe без McpManager → 500 INTERNAL_ERROR', async () => {
    const app = new Hono();
    app.route('/api/v2/mcp', createMcpRoutes(createMockAuth(), { mcpManager: null }));

    const res = await app.request('/api/v2/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'github' }),
    });
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('POST /probe при ошибке подключения → 500 MCP_CONNECT_ERROR', async () => {
    const probeServer = vi.fn().mockRejectedValue(new Error('connection refused'));
    const mcpManager = createMockMcpManager({
      isServerConfigured: vi.fn(() => true) as McpManager['isServerConfigured'],
      probeServer: probeServer as McpManager['probeServer'],
    });
    const app = createTestApp(mcpManager);

    const res = await app.request('/api/v2/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'github' }),
    });
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error.code).toBe('MCP_CONNECT_ERROR');
    expect(body.error.message).toContain('connection refused');
  });

  // ADR-105 (Ф3): probe не подключается к коннектору с plaintext-секретом.
  it('POST /probe с plaintext-секретом в заголовках → 400 MCP_SECRET_HEADER_FORBIDDEN', async () => {
    const probeServer = vi.fn();
    const mcpManager = createMockMcpManager({
      isServerConfigured: vi.fn(() => true) as McpManager['isServerConfigured'],
      getServerConfig: vi.fn(() => ({
        type: 'sse',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer super-secret-token' },
      })) as unknown as McpManager['getServerConfig'],
      probeServer: probeServer as McpManager['probeServer'],
    });
    const app = createTestApp(mcpManager);

    const res = await app.request('/api/v2/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'github' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('MCP_SECRET_HEADER_FORBIDDEN');
    expect(body.error.message).toContain("auth.kind='credential'");
    // Значение секрета в ответе не утекает, подключения не было.
    expect(body.error.message).not.toContain('super-secret-token');
    expect(probeServer).not.toHaveBeenCalled();
  });
});
