/**
 * PROP-125 §2: серверные MCP-серверы гибрида в `McpManager` — третий вид
 * runtime-записей (рядом с локальным реестром и серверами исполнителя).
 *
 * Проверяет, что:
 * - состав серверов гибрида попадает в `_config` как runtime-записи и даёт
 *   тулы штатным путём (`{server}_{tool}`, `source:'mcp'`) через
 *   `RemoteBackendMcpClient`;
 * - коллизия имён решается в пользу локального сервера;
 * - недоступный сервер (`down`) остаётся в составе с причиной, но его тулы
 *   не предлагаются (решение 4 владельца);
 * - офлайн (backend недоступен) не теряет имена серверов;
 * - исчезнувший сервер снимается вместе с тулами.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpManager } from './manager.js';
import { RemoteMcpSource } from './remote-mcp-source.js';
import { RemoteBackendMcpClient, type RemoteMcpBackendApi } from './remote-backend-mcp-client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpServerConfig, ToolContext, ToolDefinition } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  RemoteMcpCallRequest,
  RemoteMcpCallResult,
  RemoteMcpServerInfo,
  RemoteMcpToolsResponse,
} from '@itphx/synth-shared';

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

/** Ответ сервера в списке серверов (все обязательные поля контракта). */
function serverInfo(overrides: Partial<RemoteMcpServerInfo> = {}): RemoteMcpServerInfo {
  return {
    name: 'playwright-mcp',
    type: 'stdio',
    origin: 'instance',
    trust: 'community',
    enabled: true,
    enabledByDefault: true,
    remoteMode: 'tools',
    status: 'up',
    toolCount: 1,
    ...overrides,
  };
}

/** Подставной backend-API с изменяемым состоянием и счётчиками вызовов. */
class FakeApi implements RemoteMcpBackendApi {
  /** Адрес backend'а (PROP-125: адрес релея собирается из него). */
  backendUrl = 'http://backend.test';
  /** Текущий access-токен гибрида. */
  token: string | null = 'tok';
  servers: RemoteMcpServerInfo[] = [];
  tools: RemoteMcpToolsResponse = { server: 'playwright-mcp', tools: [] };
  callResult: RemoteMcpCallResult = { content: 'ok', isError: false };
  /** Ошибка discovery (бросается из `getRemoteMcpServers`). */
  serversError: Error | null = null;
  serversCalls = 0;
  toolsCalls = 0;
  callCalls = 0;
  lastCall: RemoteMcpCallRequest | null = null;

  async getAccessToken(): Promise<string | null> {
    return this.token;
  }

  async getRemoteMcpServers(): Promise<RemoteMcpServerInfo[]> {
    this.serversCalls += 1;
    if (this.serversError) throw this.serversError;
    return this.servers;
  }

  async getRemoteMcpTools(server: string): Promise<RemoteMcpToolsResponse> {
    this.toolsCalls += 1;
    return { ...this.tools, server };
  }

  async callRemoteMcp(body: RemoteMcpCallRequest): Promise<RemoteMcpCallResult> {
    this.callCalls += 1;
    this.lastCall = body;
    return this.callResult;
  }
}

/**
 * Источник с управляемым TTL (0 — каждый refresh перечитывает состав).
 *
 * Фича серверных MCP включена явно (PROP-125 §3): по умолчанию источник
 * пуст — запросов нет.
 */
function makeSource(api: FakeApi, ttlMs = 0): RemoteMcpSource {
  const source = new RemoteMcpSource({ getClient: () => api, ttlMs });
  source.setSupported(true);
  return source;
}

/** Источник с одним сервером `playwright-mcp` и одним инструментом. */
function makePlaywrightApi(): FakeApi {
  const api = new FakeApi();
  api.servers = [serverInfo()];
  api.tools = {
    server: 'playwright-mcp',
    instructions: 'Правила сервера',
    tools: [
      {
        server: 'playwright-mcp',
        name: 'browser_navigate',
        description: 'Открыть URL',
        inputSchema: { type: 'object' },
      },
    ],
  };
  api.callResult = { content: 'navigated', isError: false };
  return api;
}

describe('McpManager: серверные MCP-серверы гибрида (PROP-125)', () => {
  it('refreshRemoteServers вносит runtime-запись, тулы идут через RemoteBackendMcpClient', async () => {
    const api = makePlaywrightApi();
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(api));
    const registry = makeMockToolRegistry();

    await manager.refreshRemoteServers();

    expect(manager.hasRemoteMcpSource()).toBe(true);
    expect(manager.isRemoteServer('playwright-mcp')).toBe(true);
    expect(manager.getRemoteServerNames()).toEqual(['playwright-mcp']);
    expect(manager.getConfig()['playwright-mcp']).toBeDefined();
    expect(manager.getServerConfig('playwright-mcp')?.type).toBe('http');
    // System-level (ADR-071): origin instance.
    expect(manager.getServerOrigin('playwright-mcp')).toBe('instance');

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
    // Вызов ушёл в backend по контракту удалённого MCP, а не в локальный клиент.
    // `_meta` (PROP-125 §1) — идентификатор сессии Synth.
    expect(api.lastCall).toEqual({
      server: 'playwright-mcp',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
      meta: { 'synth/session_id': 'sess-1' },
    });
  });

  it('системный мастер-флаг сервера учитывается (enabled: false → выключен)', async () => {
    const api = makePlaywrightApi();
    api.servers = [serverInfo({ enabled: false })];
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(api));

    await manager.refreshRemoteServers();

    expect(manager.isServerSystemEnabled('playwright-mcp')).toBe(false);
  });

  it('getRemoteDefaultServerNames — только серверы с enabledByDefault', async () => {
    const api = new FakeApi();
    api.servers = [
      serverInfo({ name: 'a', enabledByDefault: true }),
      serverInfo({ name: 'b', enabledByDefault: false }),
    ];
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(api));

    await manager.refreshRemoteServers();

    expect(manager.getRemoteDefaultServerNames()).toEqual(['a']);
  });

  it('коллизия имён: локальный сервер приоритетнее, серверный пропущен', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    manager.setRemoteMcpSource(makeSource(makePlaywrightApi()));

    await manager.refreshRemoteServers();

    expect(manager.isRemoteServer('playwright-mcp')).toBe(false);
    expect(manager.getServerConfig('playwright-mcp')).toEqual(local);
    const registry = makeMockToolRegistry();
    await manager.ensureToolsLoaded(['playwright-mcp'], registry);
    // Локальный сервер остался подключён, тулы серверного не подмешались.
    expect(registry.list().map((tool) => tool.name)).toEqual(['playwright-mcp_local_tool']);
    warn.mockRestore();
  });

  it('исчезнувший сервер снимается вместе с тулами', async () => {
    const api = makePlaywrightApi();
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(api));
    const registry = makeMockToolRegistry();

    await manager.refreshRemoteServers();
    await manager.ensureToolsLoaded(['playwright-mcp'], registry);
    expect(registry.get('playwright-mcp_browser_navigate')).toBeDefined();

    api.servers = [];
    await manager.refreshRemoteServers(registry);

    expect(manager.isRemoteServer('playwright-mcp')).toBe(false);
    expect(manager.getServerConfig('playwright-mcp')).toBeUndefined();
    expect(manager.getRemoteServerNames()).toEqual([]);
    expect(registry.get('playwright-mcp_browser_navigate')).toBeUndefined();
  });

  it('недоступный сервер (down): тулы снимаются, статус — error, причина видна', async () => {
    const api = makePlaywrightApi();
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(api));
    const registry = makeMockToolRegistry();

    await manager.refreshRemoteServers();
    await manager.ensureToolsLoaded(['playwright-mcp'], registry);
    expect(registry.get('playwright-mcp_browser_navigate')).toBeDefined();

    // Сервер упал.
    api.servers = [serverInfo({ status: 'down', error: 'сервер недоступен' })];
    await manager.refreshRemoteServers(registry);

    // Решение 4: сервер остаётся в составе, но тулы не предлагаются.
    expect(manager.isRemoteServer('playwright-mcp')).toBe(true);
    expect(registry.get('playwright-mcp_browser_navigate')).toBeUndefined();
    expect(manager.getServerStatus('playwright-mcp')).toBe('error');
    expect(manager.getServerError('playwright-mcp')).toContain('сервер недоступен');
  });

  it('офлайн: имена сохранены, статус — error, причина из источника', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makePlaywrightApi();
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(api));

    await manager.refreshRemoteServers();
    expect(manager.getRemoteServerNames()).toEqual(['playwright-mcp']);

    // Backend стал недоступен — серверы не исчезают молча.
    api.serversError = new Error('Сервер недоступен: fetch failed');
    await manager.refreshRemoteServers();

    expect(manager.getRemoteServerNames()).toEqual(['playwright-mcp']);
    expect(manager.getServerStatus('playwright-mcp')).toBe('error');
    expect(manager.getServerError('playwright-mcp')).toContain('Сервер недоступен');
    warn.mockRestore();
  });

  it('setRemoteMcpSource(null) снимает runtime-записи', async () => {
    const manager = new McpManager();
    manager.setRemoteMcpSource(makeSource(makePlaywrightApi()));
    await manager.refreshRemoteServers();
    expect(manager.getConfig()['playwright-mcp']).toBeDefined();

    manager.setRemoteMcpSource(null);

    expect(manager.getConfig()['playwright-mcp']).toBeUndefined();
    expect(manager.isRemoteServer('playwright-mcp')).toBe(false);
    expect(manager.hasRemoteMcpSource()).toBe(false);
  });

  it('клиент сервера — RemoteBackendMcpClient (транспорт выбирает источник)', async () => {
    const api = makePlaywrightApi();
    const manager = new McpManager();
    const source = makeSource(api);
    manager.setRemoteMcpSource(source);

    await manager.refreshRemoteServers();
    await manager.connectServer('playwright-mcp');

    expect(manager.getServerStatus('playwright-mcp')).toBe('connected');
    expect(manager.getServerTools('playwright-mcp')?.map((tool) => tool.name)).toEqual([
      'browser_navigate',
    ]);
    // Схемы инструментов пришли из backend по контракту удалённого MCP.
    expect(api.toolsCalls).toBe(1);
    expect(source.createClient('playwright-mcp')).toBeInstanceOf(RemoteBackendMcpClient);
  });
});
