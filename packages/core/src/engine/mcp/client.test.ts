import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpClient } from './client.js';
import { egressFetch } from '../../security/tls.js';
import { resetEgressProxyState, setEgressProxyConfig } from '../../security/proxy-state.js';
import { resolveProxyConfig, type McpServerConfig } from '@itphx/synth-shared';

const mockConnect = vi.fn<() => Promise<void>>();
const mockListTools = vi.fn<() => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>>();
const mockCallTool = vi.fn<(params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError: boolean }>>();
const mockClose = vi.fn<() => Promise<void>>();
let mockInstructions: string | undefined;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
    getInstructions() {
      return mockInstructions;
    }
  },
}));

const mockStdioCtor = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(...args: unknown[]) {
      mockStdioCtor(...args);
    }
  },
}));

const mockStreamableCtor = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      mockStreamableCtor(...args);
    }
  },
}));

function makeStdioConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { NODE_ENV: 'test' },
    ...overrides,
  };
}

function makeSseConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    type: 'sse',
    url: 'http://localhost:8080/mcp',
    ...overrides,
  };
}

describe('McpClient (stdio)', () => {
  let client: McpClient;
  let config: McpServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeStdioConfig();
    client = new McpClient('test-stdio', config);
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
        { name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object' } },
      ],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'search result' }],
      isError: false,
    });
    mockClose.mockResolvedValue(undefined);
    mockInstructions = 'Инструкции тестового сервера';
  });

  afterEach(async () => {
    if (client.isConnected) {
      await client.disconnect();
    }
  });

  it('имя клиента доступно через getter', () => {
    expect(client.name).toBe('test-stdio');
  });

  it('isConnected = false до connect', () => {
    expect(client.isConnected).toBe(false);
  });

  it('tools = [] до connect', () => {
    expect(client.tools).toEqual([]);
  });

  it('connect загружает инструменты', async () => {
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(client.tools).toHaveLength(2);
    expect(client.tools[0]!.name).toBe('search');
    expect(client.tools[1]!.name).toBe('fetch');
  });

  it('ADR-071 §2.2: connect сохраняет instructions', async () => {
    expect(client.instructions).toBeUndefined();

    await client.connect();
    expect(client.instructions).toBe('Инструкции тестового сервера');

    await client.disconnect();
    expect(client.instructions).toBeUndefined();
  });

  it('повторный connect не переподключается', async () => {
    await client.connect();
    await client.connect();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('disconnect очищает инструменты', async () => {
    await client.connect();
    await client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(client.tools).toEqual([]);
  });

  it('callTool возвращает результат', async () => {
    await client.connect();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello from tool' }],
      isError: false,
    });

    const result = await client.callTool('search', { q: 'test' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Hello from tool');
  });

  it('callTool передаёт _meta в tools/call, если meta задан', async () => {
    await client.connect();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    await client.callTool('search', { q: 'test' }, { 'synth/session_id': 'sess-42' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: { q: 'test' },
      _meta: { 'synth/session_id': 'sess-42' },
    });
  });

  it('callTool без meta не передаёт _meta (поведение без сессии не меняется)', async () => {
    await client.connect();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    await client.callTool('search', { q: 'test' });

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'test' } });
    expect(mockCallTool.mock.calls[0]![0]).not.toHaveProperty('_meta');
  });

  it('callTool без подключения возвращает ошибку', async () => {
    const result = await client.callTool('search', { q: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('не подключён');
  });

  it('callTool обрабатывает ошибку инструмента', async () => {
    await client.connect();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Tool error message' }],
      isError: true,
    });

    const result = await client.callTool('search', { q: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Tool error message');
  });

  it('callTool обрабатывает пустой результат', async () => {
    await client.connect();
    mockCallTool.mockResolvedValueOnce({
      content: [],
      isError: false,
    });

    const result = await client.callTool('search', { q: 'test' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('пустой результат');
  });

  it('connect обрабатывает пустой список инструментов', async () => {
    mockListTools.mockResolvedValueOnce({ tools: [] });
    await client.connect();
    expect(client.tools).toEqual([]);
    expect(client.isConnected).toBe(true);
  });

  it('ADR-099 D1: прокси-переменные доезжают в env дочернего stdio-процесса', async () => {
    setEgressProxyConfig(
      resolveProxyConfig(
        {
          proxy: {
            url: 'http://proxy.corp:3128',
            httpsProxy: 'http://https.corp:3128',
            noProxy: ['localhost', '.corp.example'],
            fromEnv: false,
          },
        },
        {},
      ),
    );

    await client.connect();
    const options = mockStdioCtor.mock.calls[0]![0] as { env?: Record<string, string> };
    expect(options.env).toMatchObject({
      NODE_ENV: 'test',
      HTTP_PROXY: 'http://proxy.corp:3128',
      HTTPS_PROXY: 'http://https.corp:3128',
      ALL_PROXY: 'http://proxy.corp:3128',
      NO_PROXY: 'localhost,.corp.example',
    });
    await client.disconnect();
    resetEgressProxyState();
  });

  it('ADR-099 D1: без прокси в env нет прокси-переменных (поведение не меняется)', async () => {
    setEgressProxyConfig(resolveProxyConfig({ proxy: { enabled: false } }, {}));
    await client.connect();
    const options = mockStdioCtor.mock.calls[0]![0] as { env?: Record<string, string> };
    expect(options.env).toEqual({ NODE_ENV: 'test' });
    await client.disconnect();
    resetEgressProxyState();
  });
});

describe('McpClient (sse)', () => {
  let client: McpClient;
  let config: McpServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeSseConfig();
    client = new McpClient('test-sse', config);
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object' } }],
    });
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (client.isConnected) {
      await client.disconnect();
    }
  });

  it('connect работает для SSE', async () => {
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0]!.name).toBe('web_search');
  });

  it('disconnect очищает состояние для SSE', async () => {
    await client.connect();
    await client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(client.tools).toEqual([]);
  });

  it('ADR-090: headers конфига прокидываются в транспорт (requestInit.headers)', async () => {
    const headers = { Authorization: 'Bearer tok', 'X-Tenant': 'tg-dev' };
    const withHeaders = new McpClient('hdr', makeSseConfig({ headers }));
    await withHeaders.connect();
    await withHeaders.disconnect();

    expect(mockStreamableCtor).toHaveBeenCalledTimes(1);
    const [url, options] = mockStreamableCtor.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    // ADR-099: транспорт всегда получает `fetch` с единым доверием TLS/CA.
    expect(options).toEqual({ fetch: egressFetch, requestInit: { headers } });
  });

  it('без headers requestInit не передаётся, но fetch доверия TLS остаётся (ADR-099)', async () => {
    const noHeaders = new McpClient('nohdr', makeSseConfig());
    await noHeaders.connect();
    await noHeaders.disconnect();

    expect(mockStreamableCtor).toHaveBeenCalledTimes(1);
    expect(mockStreamableCtor.mock.calls[0]![1]).toEqual({ fetch: egressFetch });
  });
});

describe('McpClient (пограничные случаи)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClose.mockResolvedValue(undefined);
  });

  it('connect с ошибкой SDK оставляет isConnected = false', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection refused'));
    const client = new McpClient('failing', makeStdioConfig());
    await expect(client.connect()).rejects.toThrow('Connection refused');
    expect(client.isConnected).toBe(false);
    expect(client.tools).toEqual([]);
  });

  it('connect с ошибкой listTools подключается с пустым списком инструментов', async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockRejectedValueOnce(new Error('Tool listing failed'));
    const client = new McpClient('failing-tools', makeStdioConfig());
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(client.tools).toEqual([]);
  });

  it('disconnect без подключения не падает', async () => {
    const client = new McpClient('no-connect', makeStdioConfig());
    await expect(client.disconnect()).resolves.not.toThrow();
  });

  it('connect без command для stdio выбрасывает ошибку', async () => {
    const client = new McpClient('no-cmd', {
      type: 'stdio',
      command: undefined,
    } as McpServerConfig);
    await expect(client.connect()).rejects.toThrow('не указана команда');
  });

  it('connect без url для SSE выбрасывает ошибку', async () => {
    const client = new McpClient('no-url', {
      type: 'sse',
      url: undefined,
    } as McpServerConfig);
    await expect(client.connect()).rejects.toThrow('не указан URL');
  });
});
