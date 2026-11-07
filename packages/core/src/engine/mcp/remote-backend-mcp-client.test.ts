/**
 * PROP-125 §2: клиент серверного MCP-сервера в режиме `tools`.
 *
 * Проверяет поверхность `McpClientLike` поверх HTTP-контракта backend'а:
 * загрузку схем инструментов и `instructions`, маппинг вложений (ADR-115),
 * усечение результата, `isError` без вложений и отказ «не подключён».
 */
import { describe, it, expect } from 'vitest';
import {
  RemoteBackendMcpClient,
  REMOTE_MCP_CONNECT_TIMEOUT_MS,
  REMOTE_MCP_TOOL_TIMEOUT_MS,
  type RemoteMcpBackendApi,
} from './remote-backend-mcp-client.js';
import { MAX_TOOL_RESULT_CHARS } from './client.js';
import type {
  RemoteMcpCallRequest,
  RemoteMcpCallResult,
  RemoteMcpServerInfo,
  RemoteMcpToolsResponse,
} from '@itphx/synth-shared';

const SERVER = 'playwright-mcp';

/** Минимальный ответ сервера в списке серверов. */
function serverInfo(name: string): RemoteMcpServerInfo {
  return {
    name,
    type: 'stdio',
    origin: 'instance',
    trust: 'community',
    enabled: true,
    enabledByDefault: true,
    remoteMode: 'tools',
    status: 'up',
    toolCount: 2,
  };
}

/** Подставной backend-API с фиксированными ответами. */
function fakeApi(overrides: {
  tools?: RemoteMcpToolsResponse;
  call?: RemoteMcpCallResult;
  toolsError?: Error;
} = {}): RemoteMcpBackendApi & { calls: RemoteMcpCallRequest[] } {
  const calls: RemoteMcpCallRequest[] = [];
  return {
    calls,
    backendUrl: 'http://backend.test',
    getAccessToken: async () => 'tok',
    getRemoteMcpServers: async () => [serverInfo(SERVER)],
    getRemoteMcpTools: async (server: string) => {
      if (overrides.toolsError) throw overrides.toolsError;
      return (
        overrides.tools ?? {
          server,
          instructions: 'Правила сервера',
          tools: [
            {
              server,
              name: 'browser_navigate',
              description: 'Открыть URL',
              inputSchema: { type: 'object' },
            },
            { server, name: 'browser_evaluate', description: '', inputSchema: {} },
          ],
        }
      );
    },
    callRemoteMcp: async (body: RemoteMcpCallRequest) => {
      calls.push(body);
      return overrides.call ?? { content: 'ok', isError: false };
    },
  };
}

describe('RemoteBackendMcpClient: подключение', () => {
  it('connect() наполняет tools и instructions', async () => {
    const client = new RemoteBackendMcpClient(SERVER, fakeApi());

    expect(client.isConnected).toBe(false);
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.name).toBe(SERVER);
    expect(client.tools.map((tool) => tool.name)).toEqual(['browser_navigate', 'browser_evaluate']);
    expect(client.tools[0]).toEqual({
      name: 'browser_navigate',
      description: 'Открыть URL',
      inputSchema: { type: 'object' },
    });
    expect(client.instructions).toBe('Правила сервера');
  });

  it('connect() без instructions → instructions не задано', async () => {
    const api = fakeApi({ tools: { server: SERVER, tools: [] } });
    const client = new RemoteBackendMcpClient(SERVER, api);

    await client.connect();

    expect(client.tools).toEqual([]);
    expect(client.instructions).toBeUndefined();
  });

  it('connect() пробрасывает ошибку backend (менеджер её запишет)', async () => {
    const api = fakeApi({ toolsError: new Error('MCP_REMOTE_SERVER_DOWN') });
    const client = new RemoteBackendMcpClient(SERVER, api);

    await expect(client.connect()).rejects.toThrow(/MCP_REMOTE_SERVER_DOWN/);
    expect(client.isConnected).toBe(false);
  });

  it('disconnect() сбрасывает состояние клиента', async () => {
    const client = new RemoteBackendMcpClient(SERVER, fakeApi());
    await client.connect();

    await client.disconnect();

    expect(client.isConnected).toBe(false);
    expect(client.tools).toEqual([]);
    expect(client.instructions).toBeUndefined();
  });

  it('таймауты совпадают с контрактом MCP (connect 60 c, вызов 120 c)', () => {
    expect(REMOTE_MCP_CONNECT_TIMEOUT_MS).toBe(60_000);
    expect(REMOTE_MCP_TOOL_TIMEOUT_MS).toBe(120_000);
  });
});

describe('RemoteBackendMcpClient: вызов инструмента', () => {
  it('передаёт server/tool/arguments и _meta в meta', async () => {
    const api = fakeApi({ call: { content: 'navigation failed', isError: true } });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool(
      'browser_navigate',
      { url: 'https://example.com' },
      { 'synth/session_id': 'sess-1' },
    );

    expect(result).toEqual({ content: 'navigation failed', isError: true });
    expect(api.calls).toEqual([
      {
        server: SERVER,
        tool: 'browser_navigate',
        arguments: { url: 'https://example.com' },
        meta: { 'synth/session_id': 'sess-1' },
      },
    ]);
  });

  it('без meta поле meta не добавляется', async () => {
    const api = fakeApi();
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    await client.callTool('browser_evaluate', { code: '1+1' });

    expect(api.calls[0]).not.toHaveProperty('meta');
  });

  it('вызов без connect → понятная ошибка «не подключён»', async () => {
    const api = fakeApi();
    const client = new RemoteBackendMcpClient(SERVER, api);

    const result = await client.callTool('browser_navigate', {});

    expect(result).toEqual({
      content: `MCP-сервер "${SERVER}" не подключён`,
      isError: true,
    });
    expect(api.calls).toHaveLength(0);
  });

  it('ADR-115: attachments ответа пробрасываются в McpToolResult', async () => {
    const api = fakeApi({
      call: {
        content: 'снимок готов',
        isError: false,
        attachments: [
          { mime: 'image/png', base64: 'iVBORw0KGgo=', name: 'shot.png' },
          { mime: 'audio/wav', base64: 'UklGRg==' },
          { mime: '', base64: 'AAAA' }, // невалидная запись — пропускается
        ],
      },
    });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool('browser_screenshot', {});

    expect(result.content).toBe('снимок готов');
    expect(result.attachments).toEqual([
      { mime: 'image/png', base64: 'iVBORw0KGgo=', name: 'shot.png' },
      { mime: 'audio/wav', base64: 'UklGRg==' },
    ]);
  });

  it('ADR-115: isError — вложения из ответа не берутся', async () => {
    const api = fakeApi({
      call: {
        content: 'упало',
        isError: true,
        attachments: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
    });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool('browser_screenshot', {});

    expect(result.isError).toBe(true);
    expect(result.attachments).toBeUndefined();
  });

  it('ADR-115: только вложения без текста — заглушка про количество', async () => {
    const api = fakeApi({
      call: {
        content: '',
        isError: false,
        attachments: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
    });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool('browser_screenshot', {});

    expect(result.content).toBe('Инструмент вернул 1 вложений (текста нет)');
    expect(result.attachments).toHaveLength(1);
  });

  it('пустой результат без вложений — осмысленная заглушка', async () => {
    const api = fakeApi({ call: { content: '', isError: false } });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool('noop', {});

    expect(result).toEqual({ content: 'Инструмент выполнен (пустой результат)', isError: false });
  });

  it('пустой результат с ошибкой — заглушка «вернул ошибку»', async () => {
    const api = fakeApi({ call: { content: '', isError: true } });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool('noop', {});

    expect(result).toEqual({ content: 'Инструмент вернул ошибку', isError: true });
  });

  it('усекает результат до 30 000 символов', async () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    const api = fakeApi({ call: { content: long, isError: false } });
    const client = new RemoteBackendMcpClient(SERVER, api);
    await client.connect();

    const result = await client.callTool('dump', {});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('усечено');
    expect(result.content.length).toBeLessThan(long.length);
  });
});
