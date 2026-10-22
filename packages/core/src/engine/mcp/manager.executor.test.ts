/**
 * ADR-077 (шаг B2): серверы исполнителя в `McpManager`.
 *
 * Проверяет, что runtime-записи исполнителя (`origin: 'executor'`)
 * регистрируются штатным путём (`{server}_{tool}`, `source:'mcp'`) и
 * вызываются через `ExecutorMcpClient`, а inline-режим (без источника) не
 * меняется: фабрика клиента и прежние пути работают как раньше.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpManager } from './manager.js';
import { ExecutorMcpSource, attachExecutorMcpSource } from './executor-mcp-source.js';
import type { ExecutorFetch } from './executor-mcp-client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpServerConfig, ToolContext, ToolDefinition } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';

const TOKEN = 'manager-executor-token';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeMockToolRegistry(): ToolRegistry & { get(name: string): ToolDefinition | undefined } {
  const tools = new Map<string, ToolDefinition>();
  return {
    register(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    deregister(name: string) {
      tools.delete(name);
    },
    deregisterByCapability(_capability: ToolCapability) {
      let count = 0;
      for (const [name, def] of tools) {
        if (def.capabilities?.includes(ToolCapability.MCP)) {
          tools.delete(name);
          count++;
        }
      }
      return count;
    },
    get(name: string) {
      return tools.get(name);
    },
    list() {
      return [...tools.values()];
    },
    toLLMFormat() {
      return [];
    },
    execute() {
      return Promise.resolve({ content: '', isError: false });
    },
    get count() {
      return tools.size;
    },
  } as unknown as ToolRegistry & { get(name: string): ToolDefinition | undefined };
}

/** Исполнитель, у которого поднят `playwright-mcp` с одним инструментом. */
function playwrightExecutorFetch(onCall?: (body: Record<string, unknown>) => void): ExecutorFetch {
  return (url, init) => {
    if (url.endsWith('/mcp/servers')) {
      return Promise.resolve(json([{ name: 'playwright-mcp', status: 'up', toolCount: 1 }]));
    }
    if (url.endsWith('/mcp/tools')) {
      return Promise.resolve(
        json([
          {
            server: 'playwright-mcp',
            name: 'browser_navigate',
            description: 'Открыть URL',
            inputSchema: { type: 'object' },
          },
        ]),
      );
    }
    if (url.endsWith('/mcp/call')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      onCall?.(body);
      return Promise.resolve(json({ content: 'navigated', isError: false }));
    }
    return Promise.resolve(json({ error: { message: 'unexpected' } }, 500));
  };
}

function makeSource(fetchImpl: ExecutorFetch, ttlMs?: number): ExecutorMcpSource {
  return new ExecutorMcpSource({
    urls: ['http://exec-a:5100'],
    token: TOKEN,
    fetchImpl,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

describe('McpManager: серверы исполнителя (ADR-077 шаг B2)', () => {
  it('refreshExecutorServers вносит runtime-запись, а registerTools даёт тулы штатным путём', async () => {
    const callBodies: Array<Record<string, unknown>> = [];
    const manager = new McpManager();
    manager.setExecutorMcpSource(makeSource(playwrightExecutorFetch((body) => callBodies.push(body))));
    const registry = makeMockToolRegistry();

    await manager.refreshExecutorServers();

    expect(manager.isExecutorServer('playwright-mcp')).toBe(true);
    expect(manager.getExecutorServerNames()).toEqual(['playwright-mcp']);
    // System-level (ADR-071): origin instance, включён по умолчанию.
    expect(manager.getServerOrigin('playwright-mcp')).toBe('instance');
    expect(manager.isDefaultServer('playwright-mcp')).toBe(true);
    expect(manager.getServerConfig('playwright-mcp')?.type).toBe('http');

    await manager.ensureToolsLoaded(['playwright-mcp'], registry);

    const tool = registry.get('playwright-mcp_browser_navigate');
    expect(tool).toBeDefined();
    expect(tool!.source).toBe('mcp');
    expect(tool!.mcpServer).toBe('playwright-mcp');
    expect(tool!.capabilities).toContain(ToolCapability.MCP);

    const result = await tool!.execute(
      { url: 'https://example.com' },
      { sessionId: 'sess-1', extra: {} } as unknown as ToolContext,
    );
    expect(result).toEqual({ content: 'navigated', isError: false });
    // Вызов ушёл через HTTP API исполнителя, а не через локальный MCP-клиент.
    expect(callBodies).toEqual([
      { server: 'playwright-mcp', tool: 'browser_navigate', arguments: { url: 'https://example.com' } },
    ]);

    // Прямой вызов по полному имени идёт в тот же `ExecutorMcpClient`.
    const direct = await manager.callTool('playwright-mcp_browser_navigate', { url: 'https://2.example' });
    expect(direct).toEqual({ content: 'navigated', isError: false });
    expect(callBodies[1]).toEqual({
      server: 'playwright-mcp',
      tool: 'browser_navigate',
      arguments: { url: 'https://2.example' },
    });
  });

  it('коллизия имён: локальный/реестровый сервер приоритетнее, предупреждение', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Локальный сервер — фейковый клиент (реальный stdio не поднимаем).
    const manager = new McpManager({
      createClient: (name) => ({
        name,
        isConnected: true,
        tools: [{ name: 'local_tool', description: '', inputSchema: {} }],
        connect: async () => {},
        disconnect: async () => {},
        callTool: async () => ({ content: 'local', isError: false }),
      }),
    });
    const local: McpServerConfig = { type: 'stdio', command: 'node', args: ['local.js'] };
    manager.setConfig({ 'playwright-mcp': local });
    manager.setExecutorMcpSource(makeSource(playwrightExecutorFetch()));

    await manager.refreshExecutorServers();

    expect(manager.isExecutorServer('playwright-mcp')).toBe(false);
    expect(manager.getServerConfig('playwright-mcp')).toEqual(local);
    const registry = makeMockToolRegistry();
    await manager.ensureToolsLoaded(['playwright-mcp'], registry);
    // Локальный сервер остался подключён, тулы исполнителя не подмешались.
    expect(registry.list().map((tool) => tool.name)).toEqual(['playwright-mcp_local_tool']);
    warn.mockRestore();
  });

  it('исчезнувший у исполнителя сервер снимается вместе с тулами', async () => {
    let servers = [{ name: 'playwright-mcp', status: 'up', toolCount: 1 }];
    const fetchImpl: ExecutorFetch = (url) => {
      if (url.endsWith('/mcp/servers')) return Promise.resolve(json(servers));
      if (url.endsWith('/mcp/tools')) {
        return Promise.resolve(
          json([{ server: 'playwright-mcp', name: 'browser_navigate', description: '', inputSchema: {} }]),
        );
      }
      return Promise.resolve(json({ content: 'ok', isError: false }));
    };
    const manager = new McpManager();
    manager.setExecutorMcpSource(makeSource(fetchImpl, 0));
    const registry = makeMockToolRegistry();
    await manager.refreshExecutorServers();
    await manager.ensureToolsLoaded(['playwright-mcp'], registry);
    expect(registry.get('playwright-mcp_browser_navigate')).toBeDefined();

    servers = [];
    await manager.refreshExecutorServers(registry);

    expect(manager.isExecutorServer('playwright-mcp')).toBe(false);
    expect(manager.getServerConfig('playwright-mcp')).toBeUndefined();
    expect(registry.get('playwright-mcp_browser_navigate')).toBeUndefined();
  });

  it('setExecutorMcpSource(null) снимает runtime-записи (возврат в inline-поведение)', async () => {
    const manager = new McpManager();
    manager.setExecutorMcpSource(makeSource(playwrightExecutorFetch()));
    await manager.refreshExecutorServers();
    expect(manager.getConfig()['playwright-mcp']).toBeDefined();

    manager.setExecutorMcpSource(null);

    expect(manager.getConfig()['playwright-mcp']).toBeUndefined();
    expect(manager.isExecutorServer('playwright-mcp')).toBe(false);
  });
});

describe('McpManager: inline-режим не изменился', () => {
  it('без источника работает инъектированная фабрика клиента (прежний путь)', async () => {
    const connect = vi.fn(async () => {});
    const callTool = vi.fn(async () => ({ content: 'local-ok', isError: false }));
    const tools = [{ name: 'tool1', description: 'First', inputSchema: { type: 'object' } }];
    const manager = new McpManager({
      createClient: (name) => ({
        name,
        isConnected: true,
        tools,
        instructions: 'local instructions',
        connect,
        disconnect: async () => {},
        callTool,
      }),
    });
    manager.setConfig({ 'local-server': { type: 'stdio', command: 'node' } });
    const registry = makeMockToolRegistry();

    await manager.ensureToolsLoaded(['local-server'], registry);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(manager.isExecutorServer('local-server')).toBe(false);
    expect(manager.getServerOrigin('local-server')).toBe('instance');
    const tool = registry.get('local-server_tool1');
    expect(tool!.source).toBe('mcp');
    const result = await tool!.execute({}, { sessionId: 's' } as unknown as ToolContext);
    expect(result).toEqual({ content: 'local-ok', isError: false });
    expect(callTool).toHaveBeenCalledWith('tool1', {}, { 'synth/session_id': 's' });
  });

  it('attachExecutorMcpSource при execution.mode=inline не меняет конфиг', async () => {
    const manager = new McpManager();
    const local = { 'local-server': { type: 'stdio' as const, command: 'node' } };
    manager.setConfig(local);

    const source = await attachExecutorMcpSource(manager, {
      mode: 'inline',
      remote: { url: ['http://exec-a:5100'], timeoutMs: 1000, concurrency: 1, failMode: 'fail', tokenSecret: '' },
    });

    expect(source).toBeNull();
    expect(manager.getConfig()).toEqual(local);
    expect(manager.getExecutorServerNames()).toEqual([]);
  });
});

describe('McpManager: circuit breaker для серверов исполнителя', () => {
  it('после 5 ошибок подключения сервер не опрашивается (тот же механизм)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let connectCalls = 0;
    let connected = false;
    let fail = false;
    const manager = new McpManager({
      createClient: (name) => ({
        name,
        get isConnected() {
          return connected;
        },
        tools: [{ name: 'tool1', description: '', inputSchema: {} }],
        connect: async () => {
          connectCalls += 1;
          if (fail) throw new Error('executor down');
          connected = true;
        },
        disconnect: async () => {
          connected = false;
        },
        callTool: async () => ({ content: 'ok', isError: false }),
      }),
    });
    manager.setConfig({ srv: { type: 'stdio', command: 'node' } });
    const registry = makeMockToolRegistry();

    await manager.ensureToolsLoaded(['srv'], registry);
    expect(connectCalls).toBe(1);

    connected = false;
    fail = true;
    for (let i = 0; i < 5; i++) {
      await manager.ensureToolsLoaded(['srv'], registry);
    }
    expect(connectCalls).toBe(6);

    // Circuit open: попыток подключения больше нет.
    await manager.ensureToolsLoaded(['srv'], registry);
    expect(connectCalls).toBe(6);
  });
});
