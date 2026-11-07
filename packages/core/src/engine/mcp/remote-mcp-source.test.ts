/**
 * PROP-125 §2: источник состава серверных MCP-серверов гибрида.
 *
 * Проверяет снимок состава (статусы, дефолты, `remoteMode`), TTL/повтор,
 * офлайн-состояние (backend не подключён / discovery провалился) и фабрику
 * клиента сервера (фасад берёт текущего клиента на каждый вызов).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RemoteMcpSource,
  resolveRemoteMcpMode,
  REMOTE_MCP_OFFLINE_REASON,
  REMOTE_MCP_SOURCE_RETRY_MS,
  REMOTE_MCP_SOURCE_TTL_MS,
} from './remote-mcp-source.js';
import { RemoteBackendMcpClient, type RemoteMcpBackendApi } from './remote-backend-mcp-client.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type {
  RemoteMcpCallRequest,
  RemoteMcpCallResult,
  RemoteMcpServerInfo,
  RemoteMcpToolsResponse,
} from '@itphx/synth-shared';

/**
 * Проводка T3a-2: клиент гибрида (`RemoteBackendClient`) структурно подходит
 * под фасад `RemoteMcpBackendApi` — источник получает его через
 * `getClient(): RemoteMcpBackendApi | null`.
 *
 * Импорт — только типа: в рантайме `engine/mcp/*` не должен тянуть
 * `remote/client.ts` (иначе получается цикл `remote → engine/mcp → remote`).
 */
type _AssertHybridClientFitsFacade = RemoteBackendClient extends RemoteMcpBackendApi ? true : never;
const _fitsFacade: _AssertHybridClientFitsFacade = true;
void _fitsFacade;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    toolCount: 25,
    ...overrides,
  };
}

/** Подставной backend-API с изменяемым состоянием и счётчиками вызовов. */
class FakeApi implements RemoteMcpBackendApi {
  /** Адрес backend'а (PROP-125: адрес релея собирается из него). */
  backendUrl = 'http://backend.test';
  /** Текущий access-токен гибрида (`null` — токена нет). */
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
 * Источник с включённой фичей серверных MCP (PROP-125 §3).
 *
 * По умолчанию фича **выключена** (старый backend без `features.remoteMcp`
 * → запросов нет, снимок пуст), поэтому тесты состава включают её явно.
 */
function makeSource(opts: {
  getClient: () => RemoteMcpBackendApi | null;
  ttlMs?: number;
  retryMs?: number;
  fetchImpl?: typeof fetch;
}): RemoteMcpSource {
  const source = new RemoteMcpSource(opts);
  source.setSupported(true);
  return source;
}

describe('RemoteMcpSource: снимок состава', () => {
  it('ensureFresh загружает снимок: статусы, дефолты, remoteMode', async () => {
    const api = new FakeApi();
    api.servers = [
      serverInfo({ name: 'scm', status: 'down', toolCount: 0, error: 'токен недействителен' }),
      serverInfo({ name: 'playwright-mcp', status: 'up', toolCount: 25, remoteMode: 'auto' }),
    ];
    const source = makeSource({ getClient: () => api });

    await source.ensureFresh();

    const servers = source.listServers();
    // Сортировка по имени.
    expect(servers.map((server) => server.name)).toEqual(['playwright-mcp', 'scm']);
    expect(servers[0]).toEqual({
      name: 'playwright-mcp',
      status: 'up',
      toolCount: 25,
      enabled: true,
      enabledByDefault: true,
      remoteMode: 'auto',
      type: 'stdio',
    });
    expect(servers[1]).toMatchObject({ status: 'down', error: 'токен недействителен' });
    expect(source.getServer('playwright-mcp')?.status).toBe('up');
    expect(source.getServer('unknown')).toBeUndefined();
    expect(source.offlineReason).toBeUndefined();
  });

  it('getDefaultServerNames — только серверы с enabledByDefault', async () => {
    const api = new FakeApi();
    api.servers = [
      serverInfo({ name: 'a', enabledByDefault: true }),
      serverInfo({ name: 'b', enabledByDefault: false }),
    ];
    const source = makeSource({ getClient: () => api });

    await source.ensureFresh();

    expect(source.getDefaultServerNames()).toEqual(['a']);
  });

  it('listServers/getServer отдают копии (снимок нельзя изменить извне)', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = makeSource({ getClient: () => api });
    await source.ensureFresh();

    const servers = source.listServers();
    servers[0]!.status = 'down';
    servers[0]!.toolCount = 0;

    expect(source.listServers()[0]).toMatchObject({ status: 'up', toolCount: 25 });
  });
});

describe('RemoteMcpSource: TTL и повтор', () => {
  it('TTL: в пределах TTL снимок не перечитывается', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = makeSource({ getClient: () => api, ttlMs: 60_000 });

    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);
    expect(source.isStale()).toBe(false);

    vi.advanceTimersByTime(59_000);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);

    vi.advanceTimersByTime(2_000);
    expect(source.isStale()).toBe(true);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(2);
  });

  it('ttlMs: 0 → каждый ensureFresh перечитывает состав', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = makeSource({ getClient: () => api, ttlMs: 0 });

    await source.ensureFresh();
    await source.ensureFresh();

    expect(api.serversCalls).toBe(2);
  });

  it('пустой состав — валидный снимок (действует TTL)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const api = new FakeApi();
    const source = makeSource({ getClient: () => api, ttlMs: REMOTE_MCP_SOURCE_TTL_MS });

    await source.ensureFresh();

    expect(source.listServers()).toEqual([]);
    expect(source.isStale()).toBe(false);
    expect(source.offlineReason).toBeUndefined();
  });
});

describe('RemoteMcpSource: офлайн-состояние', () => {
  it('ошибка discovery → имена сохранены, все серверы down с причиной', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = new FakeApi();
    api.servers = [serverInfo({ name: 'playwright-mcp' }), serverInfo({ name: 'scm' })];
    // ttlMs: 0 — каждый ensureFresh перечитывает состав (иначе снимок живёт TTL).
    const source = makeSource({ getClient: () => api, ttlMs: 0 });

    await source.ensureFresh();
    expect(source.listServers()).toHaveLength(2);

    // Backend стал недоступен.
    api.serversError = new Error('Сервер недоступен: fetch failed');
    await source.ensureFresh();

    const servers = source.listServers();
    // Имена прошлого снимка сохранены — серверы не исчезают молча (решение 4).
    expect(servers.map((server) => server.name)).toEqual(['playwright-mcp', 'scm']);
    expect(servers.every((server) => server.status === 'down')).toBe(true);
    expect(servers[0]!.error).toContain('Сервер недоступен');
    expect(source.offlineReason).toContain('Сервер недоступен');
    // После неудачи — пауза повтора (`retryMs`), а не «проверяем backend на
    // каждом обращении» (иначе офлайн дёргает backend из каждого хода).
    expect(source.isStale()).toBe(false);
    expect(source.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('backend не подключён → офлайн-снимок без исключения', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ name: 'playwright-mcp' })];
    let connected = true;
    // ttlMs: 0 — каждый ensureFresh перечитывает состав (иначе снимок живёт TTL).
    const source = makeSource({ getClient: () => (connected ? api : null), ttlMs: 0 });

    await source.ensureFresh();
    expect(source.listServers()).toHaveLength(1);

    // Дисконнект гибрида.
    connected = false;
    await expect(source.ensureFresh()).resolves.toBeUndefined();

    const servers = source.listServers();
    expect(servers.map((server) => server.name)).toEqual(['playwright-mcp']);
    expect(servers[0]).toMatchObject({
      status: 'down',
      error: REMOTE_MCP_OFFLINE_REASON,
    });
    expect(source.offlineReason).toBe(REMOTE_MCP_OFFLINE_REASON);
    // Офлайн-состояние не должно дёргать backend на каждом обращении.
    expect(source.isStale()).toBe(false);
  });

  it('после неудачи повтор не ждёт полного TTL (окно retry)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = new FakeApi();
    api.serversError = new Error('boom');
    const source = makeSource({
      getClient: () => api,
      ttlMs: REMOTE_MCP_SOURCE_TTL_MS,
      retryMs: REMOTE_MCP_SOURCE_RETRY_MS,
    });

    await source.ensureFresh();

    // Неудача discovery — короткая пауза (`retryMs`), а не полный TTL.
    expect(source.isStale()).toBe(false);
    expect(source.nextRetryAt).toBeGreaterThan(Date.now());
    expect(source.isStale(source.nextRetryAt)).toBe(true);
  });

  it('после неудачи повтор не идёт раньше retryAt (backend не дёргается)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const api = new FakeApi();
    api.serversError = new Error('boom');
    const source = makeSource({
      getClient: () => api,
      ttlMs: REMOTE_MCP_SOURCE_TTL_MS,
      retryMs: REMOTE_MCP_SOURCE_RETRY_MS,
    });

    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);
    expect(source.isStale()).toBe(false);

    // До истечения окна повтора backend не опрашивается.
    vi.advanceTimersByTime(REMOTE_MCP_SOURCE_RETRY_MS - 1_000);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);
    expect(source.isStale()).toBe(false);

    // Окно истекло — повтор разрешён.
    vi.advanceTimersByTime(2_000);
    expect(source.isStale()).toBe(true);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(2);
  });

  it('после восстановления снимок снова валиден, offlineReason снят', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const api = new FakeApi();
    api.serversError = new Error('boom');
    const source = makeSource({ getClient: () => api });

    await source.ensureFresh();
    expect(source.offlineReason).toBe('boom');

    api.serversError = null;
    api.servers = [serverInfo()];
    // Повтор разрешён только после окна `retryMs` (иначе backend дёргается
    // на каждом обращении) — перематываем время.
    vi.advanceTimersByTime(REMOTE_MCP_SOURCE_RETRY_MS + 1_000);
    await source.ensureFresh();

    expect(source.offlineReason).toBeUndefined();
    expect(source.listServers()).toHaveLength(1);
    expect(source.listServers()[0]!.status).toBe('up');
  });
});

describe('RemoteMcpSource: фича-флаг поддержки (PROP-125 §3)', () => {
  it('без поддержки (по умолчанию) запросов нет, снимок пуст', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = new RemoteMcpSource({ getClient: () => api });

    expect(source.isSupported).toBe(false);

    await source.ensureFresh();

    expect(api.serversCalls).toBe(0);
    expect(source.listServers()).toEqual([]);
    expect(source.getDefaultServerNames()).toEqual([]);
  });

  it('выключенная фича: isStale() false (менеджер не гоняет refresh вхолостую)', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = new RemoteMcpSource({ getClient: () => api });

    expect(source.isStale()).toBe(false);

    await source.ensureFresh();
    expect(api.serversCalls).toBe(0);
    expect(source.isStale()).toBe(false);

    // Включение поддержки — снимок просрочен, следующий refresh перечитает.
    source.setSupported(true);
    expect(source.isStale()).toBe(true);
  });

  it('setSupported(true) — снимок загружается', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = new RemoteMcpSource({ getClient: () => api });

    source.setSupported(true);
    expect(source.isSupported).toBe(true);

    await source.ensureFresh();

    expect(api.serversCalls).toBe(1);
    expect(source.listServers()).toHaveLength(1);
    expect(source.getDefaultServerNames()).toEqual(['playwright-mcp']);
  });

  it('setSupported(false) — снимок очищается, api не вызывается', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = new RemoteMcpSource({ getClient: () => api });
    source.setSupported(true);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);

    source.setSupported(false);
    expect(source.isSupported).toBe(false);
    expect(source.listServers()).toEqual([]);
    expect(source.offlineReason).toBeUndefined();

    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);
  });

  it('повторный setSupported(true) перечитывает состав', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = new RemoteMcpSource({ getClient: () => api });
    source.setSupported(true);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);

    // Выключили и снова включили — состав перечитывается.
    source.setSupported(false);
    source.setSupported(true);
    await source.ensureFresh();

    expect(api.serversCalls).toBe(2);
    expect(source.listServers()).toHaveLength(1);
  });

  it('повторный setSupported(true) без выключения не сбрасывает снимок', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = new RemoteMcpSource({ getClient: () => api });
    source.setSupported(true);
    await source.ensureFresh();
    expect(api.serversCalls).toBe(1);

    source.setSupported(true);
    await source.ensureFresh();

    expect(api.serversCalls).toBe(1);
  });
});

describe('RemoteMcpSource: клиент сервера', () => {
  it('createClient отдаёт RemoteBackendMcpClient нужного сервера', () => {
    const source = makeSource({ getClient: () => new FakeApi() });

    const client = source.createClient('playwright-mcp');

    expect(client).toBeInstanceOf(RemoteBackendMcpClient);
    expect(client.name).toBe('playwright-mcp');
  });

  it('без backend клиент connect() падает с понятной причиной', async () => {
    const source = makeSource({ getClient: () => null });
    const client = source.createClient('playwright-mcp');

    await expect(client.connect()).rejects.toThrow(/Гибридный backend не подключён/);
  });

  it('после появления backend клиент работает (фасад берёт клиента на каждый вызов)', async () => {
    const api = new FakeApi();
    api.tools = {
      server: 'playwright-mcp',
      instructions: 'Правила',
      tools: [
        {
          server: 'playwright-mcp',
          name: 'browser_navigate',
          description: 'Открыть URL',
          inputSchema: { type: 'object' },
        },
      ],
    };
    let connected = false;
    const source = makeSource({ getClient: () => (connected ? api : null) });
    const client = source.createClient('playwright-mcp');

    // До подключения backend — отказ.
    await expect(client.connect()).rejects.toThrow(/Гибридный backend не подключён/);

    // Backend подключился — тот же клиент работает.
    connected = true;
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.tools.map((tool) => tool.name)).toEqual(['browser_navigate']);
    expect(client.instructions).toBe('Правила');

    const result = await client.callTool('browser_navigate', { url: 'https://example.com' });
    expect(result).toEqual({ content: 'ok', isError: false });
    expect(api.lastCall).toEqual({
      server: 'playwright-mcp',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });
  });

  it('после дисконнекта вызов клиента падает, а не «успешно» ничего не делает', async () => {
    const api = new FakeApi();
    let connected = true;
    const source = makeSource({ getClient: () => (connected ? api : null) });
    const client = source.createClient('playwright-mcp');
    await client.connect();

    connected = false;

    await expect(client.callTool('browser_navigate', {})).rejects.toThrow(
      /Гибридный backend не подключён/,
    );
  });

  it('close() сбрасывает снимок', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo()];
    const source = makeSource({ getClient: () => api });
    await source.ensureFresh();
    expect(source.listServers()).toHaveLength(1);

    source.close();

    expect(source.closed).toBe(true);
    expect(source.listServers()).toEqual([]);
  });
});

/** Запрос, ушедший в релей (для проверок URL и заголовков). */
interface RelayRequest {
  url: string;
  method: string;
  authorization: string | null;
  rpcMethod: string | undefined;
}

/**
 * Подставной релей: отвечает на MCP-запросы (initialize/tools/list/tools/call)
 * и фиксирует заголовки. `GET` → 405 (как у настоящего stateless-релея).
 */
function makeRelayFetch(
  opts: {
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    failWith?: Error;
  } = {},
): { impl: typeof fetch; requests: RelayRequest[] } {
  const requests: RelayRequest[] = [];
  const tools = opts.tools ?? [
    { name: 'browser_navigate', description: 'Открыть URL', inputSchema: { type: 'object' } },
  ];

  const jsonRpc = (body: unknown, result: unknown): Response =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: (body as { id?: unknown })?.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (opts.failWith) throw opts.failWith;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    let body: { method?: string } | undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as { method?: string };
      } catch {
        body = undefined;
      }
    }
    requests.push({
      url,
      method,
      authorization: new Headers(init?.headers).get('authorization'),
      rpcMethod: body?.method,
    });

    if (method === 'GET') {
      // Релей без SSE-стрима (stateless, JSON-режим) — 405, как у настоящего.
      return new Response(null, { status: 405 });
    }
    if (body?.method === 'initialize') {
      return jsonRpc(body, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'synth-hybrid-mcp', version: '1.0.0' },
      });
    }
    if (body?.method === 'tools/list') {
      return jsonRpc(body, { tools });
    }
    if (body?.method === 'tools/call') {
      return jsonRpc(body, { content: [{ type: 'text', text: 'ok' }] });
    }
    // Уведомление (notifications/initialized) — 202 без тела.
    return new Response(null, { status: 202 });
  };

  return { impl: impl as typeof fetch, requests };
}

describe('resolveRemoteMcpMode (PROP-125 §0: режим доставки)', () => {
  it('явный remoteMode — как есть', () => {
    expect(resolveRemoteMcpMode({ remoteMode: 'relay', type: 'stdio' })).toBe('relay');
    expect(resolveRemoteMcpMode({ remoteMode: 'tools', type: 'http' })).toBe('tools');
  });

  it('auto: http/sse → relay, stdio → tools', () => {
    expect(resolveRemoteMcpMode({ remoteMode: 'auto', type: 'http' })).toBe('relay');
    expect(resolveRemoteMcpMode({ remoteMode: 'auto', type: 'sse' })).toBe('relay');
    expect(resolveRemoteMcpMode({ remoteMode: 'auto', type: 'stdio' })).toBe('tools');
  });

  it('без снимка — tools (fail-safe)', () => {
    expect(resolveRemoteMcpMode(undefined)).toBe('tools');
  });
});

describe('RemoteMcpSource: режим relay (PROP-125 §2)', () => {
  it('relay-клиент ходит на /api/v2/mcp/relay/:name с динамическим Bearer', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'relay', type: 'http' })];
    const relay = makeRelayFetch();
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl });
    await source.ensureFresh();

    const client = source.createClient('playwright-mcp');
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.tools.map((tool) => tool.name)).toEqual(['browser_navigate']);

    // URL релея — с адресом backend'а и экранированным именем сервера.
    expect(relay.requests.length).toBeGreaterThan(0);
    for (const request of relay.requests) {
      expect(request.url).toBe('http://backend.test/api/v2/mcp/relay/playwright-mcp');
      // Bearer подставляется на КАЖДЫЙ запрос (токен обновляется в рантайме).
      expect(request.authorization).toBe('Bearer tok');
    }
    // Режим relay — инструменты берутся у релея, а не из tools-контракта.
    expect(api.toolsCalls).toBe(0);
    expect(source.getServerError('playwright-mcp')).toBeUndefined();
  });

  it('имя сервера экранируется в URL релея', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ name: 'srv/with space', remoteMode: 'relay', type: 'http' })];
    const relay = makeRelayFetch();
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl });
    await source.ensureFresh();

    const client = source.createClient('srv/with space');
    await client.connect();

    expect(relay.requests[0]!.url).toBe(
      'http://backend.test/api/v2/mcp/relay/srv%2Fwith%20space',
    );
  });

  it('auto + http → relay; auto + stdio → tools (релея нет)', async () => {
    const api = new FakeApi();
    api.servers = [
      serverInfo({ name: 'http-srv', remoteMode: 'auto', type: 'http' }),
      serverInfo({ name: 'stdio-srv', remoteMode: 'auto', type: 'stdio' }),
    ];
    const relay = makeRelayFetch();
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl });
    await source.ensureFresh();

    await source.createClient('http-srv').connect();
    expect(relay.requests.length).toBeGreaterThan(0);

    const relayCallsBefore = relay.requests.length;
    const toolsClient = source.createClient('stdio-srv');
    expect(toolsClient).toBeInstanceOf(RemoteBackendMcpClient);
    await toolsClient.connect();
    expect(relay.requests.length).toBe(relayCallsBefore);
  });

  it('remoteMode: tools — релей не используется вовсе', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'tools', type: 'http' })];
    const relay = makeRelayFetch();
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl });
    await source.ensureFresh();

    const client = source.createClient('playwright-mcp');
    expect(client).toBeInstanceOf(RemoteBackendMcpClient);
    await client.connect();

    expect(relay.requests).toHaveLength(0);
    expect(api.toolsCalls).toBe(1);
  });

  it('без backend клиент connect() падает с понятной причиной', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'relay', type: 'http' })];
    let connected = true;
    const source = makeSource({ getClient: () => (connected ? api : null) });
    await source.ensureFresh();

    // Дисконнект: клиента нет, снимок сохранён (серверы помечены `down`).
    connected = false;
    await source.ensureFresh();

    const client = source.createClient('playwright-mcp');
    await expect(client.connect()).rejects.toThrow(/Гибридный backend не подключён/);
    // Причина деградации видна в статусе.
    expect(source.getServerError('playwright-mcp')).toContain('Гибридный backend не подключён');
  });
});

describe('RemoteMcpSource: деградация relay → tools (PROP-125, решение 8)', () => {
  it('неудачный relay → клиент работает в tools, причина в getServerError', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'relay', type: 'http' })];
    api.tools = {
      server: 'playwright-mcp',
      instructions: 'Правила',
      tools: [
        {
          server: 'playwright-mcp',
          name: 'browser_navigate',
          description: 'Открыть URL',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const relay = makeRelayFetch({ failWith: new Error('relay недоступен: 502') });
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl });
    await source.ensureFresh();

    const client = source.createClient('playwright-mcp');
    await client.connect();

    // Сервер не исчез — инструменты доступны через tool-level proxy.
    expect(client.isConnected).toBe(true);
    expect(client.tools.map((tool) => tool.name)).toEqual(['browser_navigate']);
    expect(api.toolsCalls).toBe(1);
    // Причина деградации видна в статусе (без секретов).
    expect(source.getServerError('playwright-mcp')).toContain('relay недоступен');
  });

  it('причина деградации снимается после успешного подключения релея', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'relay', type: 'http' })];
    const failing = makeRelayFetch({ failWith: new Error('relay недоступен') });
    const source = makeSource({ getClient: () => api, fetchImpl: failing.impl });
    await source.ensureFresh();

    await source.createClient('playwright-mcp').connect();
    expect(source.getServerError('playwright-mcp')).toContain('relay недоступен');

    // Следующая попытка — релей жив: деградация снята.
    const working = makeRelayFetch();
    const recovered = makeSource({ getClient: () => api, fetchImpl: working.impl });
    await recovered.ensureFresh();
    await recovered.createClient('playwright-mcp').connect();
    expect(recovered.getServerError('playwright-mcp')).toBeUndefined();
  });

  it('сервер исчез из состава — причина деградации чистится', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'relay', type: 'http' })];
    const relay = makeRelayFetch({ failWith: new Error('relay недоступен') });
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl, ttlMs: 0 });
    await source.ensureFresh();
    await source.createClient('playwright-mcp').connect();
    expect(source.getServerError('playwright-mcp')).toContain('relay недоступен');

    api.servers = [];
    await source.ensureFresh();

    expect(source.getServerError('playwright-mcp')).toBeUndefined();
  });

  it('снятие фичи и close() чистят причины деградации', async () => {
    const api = new FakeApi();
    api.servers = [serverInfo({ remoteMode: 'relay', type: 'http' })];
    const relay = makeRelayFetch({ failWith: new Error('relay недоступен') });
    const source = makeSource({ getClient: () => api, fetchImpl: relay.impl });
    await source.ensureFresh();
    await source.createClient('playwright-mcp').connect();
    expect(source.getServerError('playwright-mcp')).toContain('relay недоступен');

    source.setSupported(false);
    expect(source.getServerError('playwright-mcp')).toBeUndefined();

    source.setSupported(true);
    await source.ensureFresh();
    await source.createClient('playwright-mcp').connect();
    expect(source.getServerError('playwright-mcp')).toContain('relay недоступен');

    source.close();
    expect(source.getServerError('playwright-mcp')).toBeUndefined();
  });
});
