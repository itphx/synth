import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SYNTH_VERSION, type McpRegistryEntry } from '@itphx/synth-shared';
import type { McpManager } from '../../engine/mcp/index.js';
import type { McpToolResult } from '../../engine/mcp/index.js';
import { createMcpRelayRoutes, createRelayServer, toMcpContent } from './mcp-relay.js';

/**
 * PROP-125 §1: серверный MCP-relay (режим `relay`).
 *
 * Покрыты: конвертация результата в content-блоки, MCP-сервер релея
 * (через in-memory транспорт SDK) и HTTP-контур фабрики.
 */

interface MockManager {
  connectServer: ReturnType<typeof vi.fn>;
  getServerTools: ReturnType<typeof vi.fn>;
  getServerInstructions: ReturnType<typeof vi.fn>;
  callServerTool: ReturnType<typeof vi.fn>;
}

function createMockManager(overrides: Partial<MockManager> = {}): McpManager {
  const manager: MockManager = {
    connectServer: vi.fn(async () => {}),
    getServerTools: vi.fn(() => [
      { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
      { name: 'tool2', description: 'Second tool', inputSchema: { type: 'object' } },
    ]),
    getServerInstructions: vi.fn(() => 'Инструкции сервера'),
    callServerTool: vi.fn(async (): Promise<McpToolResult> => ({ content: 'ok', isError: false })),
    ...overrides,
  };
  return manager as unknown as McpManager;
}

function makeEntry(overrides: Partial<McpRegistryEntry> = {}): McpRegistryEntry {
  return {
    schemaVersion: 1,
    id: 'id-srv',
    name: 'srv',
    config: { type: 'http', url: 'https://mcp.example.com/mcp' },
    origin: 'instance',
    author: null,
    trust: 'builtin',
    enabled: true,
    enabledByDefault: false,
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('toMcpContent (PROP-125: конвертация результата в content-блоки MCP)', () => {
  it('текст результата → блок text', () => {
    const blocks = toMcpContent({ content: 'результат', isError: false });
    expect(blocks).toEqual([{ type: 'text', text: 'результат' }]);
  });

  it('вложение image/* → блок image', () => {
    const blocks = toMcpContent({
      content: 'снимок',
      isError: false,
      attachments: [{ mime: 'image/png', name: 'shot.png', base64: 'AAAA' }],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'снимок' });
    expect(blocks[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });

  it('неизображения → блок resource с blob', () => {
    const blocks = toMcpContent({
      content: 'файл',
      isError: false,
      attachments: [{ mime: 'application/pdf', name: 'doc.pdf', base64: 'BBBB' }],
    });
    expect(blocks[1]).toEqual({
      type: 'resource',
      resource: { uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: 'BBBB' },
    });
  });

  it('имя без path traversal (берётся последний сегмент, ".." вычищается)', () => {
    const blocks = toMcpContent({
      content: '',
      isError: false,
      attachments: [{ mime: 'application/octet-stream', name: '../../etc/passwd', base64: 'CCCC' }],
    });
    const resource = blocks[0] as { type: string; resource: { uri: string } };
    expect(resource.resource.uri).toBe('file:///passwd');
  });

  it('без имени → attachment', () => {
    const blocks = toMcpContent({
      content: '',
      isError: false,
      attachments: [{ mime: 'application/octet-stream', base64: 'DDDD' }],
    });
    const resource = blocks[0] as { type: string; resource: { uri: string } };
    expect(resource.resource.uri).toBe('file:///attachment');
  });

  it('пустой успешный результат → текстовая заглушка', () => {
    const blocks = toMcpContent({ content: '', isError: false });
    expect(blocks).toEqual([{ type: 'text', text: 'Инструмент выполнен (пустой результат)' }]);
  });

  it('ошибка без вложений → текст ошибки, вложения не добавляются', () => {
    const blocks = toMcpContent({
      content: 'упало',
      isError: true,
      attachments: [{ mime: 'image/png', name: 'shot.png', base64: 'EEEE' }],
    });
    expect(blocks).toEqual([{ type: 'text', text: 'упало' }]);
  });

  it('ошибка без текста → «Инструмент вернул ошибку»', () => {
    const blocks = toMcpContent({ content: '', isError: true });
    expect(blocks).toEqual([{ type: 'text', text: 'Инструмент вернул ошибку' }]);
  });
});

describe('createRelayServer (PROP-125: MCP-сервер релея)', () => {
  async function connectRelay(manager: McpManager) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createRelayServer(manager, 'srv');
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, server };
  }

  it('tools/list отдаёт имена и схемы инструментов upstream-сервера', async () => {
    const manager = createMockManager();
    const { client } = await connectRelay(manager);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['tool1', 'tool2']);
    expect(tools.tools[0]!.description).toBe('First tool');
    expect(tools.tools[0]!.inputSchema).toMatchObject({ type: 'object' });
    // Список подтягивается с подключением сервера.
    expect(manager.connectServer).toHaveBeenCalledWith('srv');
  });

  it('tools/call возвращает текст и image-блок для вложения', async () => {
    const manager = createMockManager({
      callServerTool: vi.fn(async (): Promise<McpToolResult> => ({
        content: 'снимок экрана',
        isError: false,
        attachments: [{ mime: 'image/png', name: 'shot.png', base64: 'AAAA' }],
      })),
    });
    const { client } = await connectRelay(manager);

    const result = await client.callTool({ name: 'tool1', arguments: { a: 1 } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text', text: 'снимок экрана' });
    expect(content[1]).toMatchObject({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(manager.callServerTool).toHaveBeenCalledWith('srv', 'tool1', { a: 1 }, undefined);
  });

  it('tools/call ошибки → isError в ответе', async () => {
    const manager = createMockManager({
      callServerTool: vi.fn(async (): Promise<McpToolResult> => ({
        content: 'инструмент упал',
        isError: true,
      })),
    });
    const { client } = await connectRelay(manager);

    const result = await client.callTool({ name: 'tool2', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text', text: 'инструмент упал' });
  });

  it('instructions upstream-сервера видны MCP-клиенту', async () => {
    const manager = createMockManager({
      getServerInstructions: vi.fn(() => 'Правила работы сервера'),
    });
    const { client } = await connectRelay(manager);
    expect(client.getInstructions()).toBe('Правила работы сервера');
  });
});

describe('createMcpRelayRoutes (PROP-125: HTTP-контур релея)', () => {
  function createTestApp(opts: {
    manager: McpManager | null;
    entry?: McpRegistryEntry | null;
    authed?: boolean;
  }) {
    const app = new Hono();
    const requireAuth: MiddlewareHandler = async (c: Context, next: Next) => {
      if (opts.authed === false) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'нет аутентификации' } }, 401);
      }
      await next();
    };
    app.route(
      '/api/v2/mcp',
      createMcpRelayRoutes(
        { requireAuth },
        {
          mcpManager: opts.manager,
          getEntry: async () => opts.entry ?? null,
        },
      ),
    );
    return app;
  }

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

  const jsonHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  it('без аутентификации → 401', async () => {
    const app = createTestApp({ manager: createMockManager(), entry: makeEntry(), authed: false });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(401);
  });

  it('неизвестный сервер → 404 MCP_RELAY_SERVER_NOT_FOUND', async () => {
    const app = createTestApp({ manager: createMockManager(), entry: null });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_RELAY_SERVER_NOT_FOUND');
  });

  it('отключённый администратором сервер → 409 MCP_SERVER_DISABLED', async () => {
    const app = createTestApp({
      manager: createMockManager(),
      entry: makeEntry({ enabled: false }),
    });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_SERVER_DISABLED');
  });

  it('без MCP-менеджера → 503 MCP_REMOTE_UNAVAILABLE', async () => {
    const app = createTestApp({ manager: null, entry: makeEntry() });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_REMOTE_UNAVAILABLE');
  });

  it('ошибка подключения к серверу → 502 MCP_REMOTE_SERVER_DOWN', async () => {
    const manager = createMockManager({
      connectServer: vi.fn(async () => { throw new Error('connect failed'); }),
    });
    const app = createTestApp({ manager, entry: makeEntry() });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('MCP_REMOTE_SERVER_DOWN');
    expect(body.error.message).toBe('connect failed');
  });

  it('GET → 405 MCP_RELAY_SESSIONLESS (релей без сессий)', async () => {
    const app = createTestApp({ manager: createMockManager(), entry: makeEntry() });
    const res = await app.request('/api/v2/mcp/relay/srv');
    expect(res.status).toBe(405);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('MCP_RELAY_SESSIONLESS');
    expect(body.error.message).toBe('Relay работает без сессий (stateless)');
  });

  it('DELETE → 405 MCP_RELAY_SESSIONLESS', async () => {
    const app = createTestApp({ manager: createMockManager(), entry: makeEntry() });
    const res = await app.request('/api/v2/mcp/relay/srv', { method: 'DELETE' });
    expect(res.status).toBe(405);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MCP_RELAY_SESSIONLESS');
  });

  it('POST initialize → 200 и JSON-RPC result.serverInfo', async () => {
    const manager = createMockManager();
    const app = createTestApp({ manager, entry: makeEntry() });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      jsonrpc: string;
      id: number;
      result: { serverInfo: { name: string; version: string }; instructions?: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe('synth-hybrid-mcp');
    expect(body.result.serverInfo.version).toBe(SYNTH_VERSION);
    expect(body.result.instructions).toBe('Инструкции сервера');
  });

  it('POST tools/call через relay → результат вызова upstream-сервера', async () => {
    const manager = createMockManager({
      callServerTool: vi.fn(async (): Promise<McpToolResult> => ({
        content: 'ответ инструмента',
        isError: false,
      })),
    });
    const app = createTestApp({ manager, entry: makeEntry() });
    const res = await app.request('/api/v2/mcp/relay/srv', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'tool1', arguments: { q: 'x' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: number;
      result: { content: Array<{ type: string; text?: string }>; isError?: boolean };
    };
    expect(body.id).toBe(7);
    expect(body.result.content[0]).toMatchObject({ type: 'text', text: 'ответ инструмента' });
    expect(manager.callServerTool).toHaveBeenCalledWith('srv', 'tool1', { q: 'x' }, undefined);
  });
});
