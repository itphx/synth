/**
 * ADR-077 (шаг B2): клиент MCP-инструментов пула исполнителей.
 *
 * Проверяет поверхность `McpClientLike` поверх HTTP API исполнителя
 * (`/mcp/tools`, `/mcp/servers`, `/mcp/call`): фильтрация тулов по серверу,
 * сохранение `isError`, коды 404/500, таймаут, failover по пулу адресов,
 * усечение результата и отсутствие токена в текстах ошибок.
 */
import { describe, it, expect } from 'vitest';
import {
  ExecutorMcpClient,
  ExecutorMcpPool,
  ExecutorMcpUnavailableError,
  type ExecutorFetch,
} from './executor-mcp-client.js';
import { MAX_TOOL_RESULT_CHARS } from './client.js';

const TOKEN = 'executor-secret-token';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): ExecutorFetch {
  return (url, init) => Promise.resolve(handler(url, init));
}

/** Ответы «сервер поднят» для connect-фазы. */
function upServerFetch(tools: unknown[] = []): ExecutorFetch {
  return makeFetch((url) => {
    if (url.endsWith('/mcp/tools')) return json(tools);
    if (url.endsWith('/mcp/servers')) {
      return json([{ name: 'playwright-mcp', status: 'up', toolCount: tools.length }]);
    }
    return json({ error: { message: 'unexpected' } }, 500);
  });
}

describe('ExecutorMcpClient: /mcp/tools и фильтрация по серверу', () => {
  it('connect() читает тулы исполнителя и оставляет только свой сервер', async () => {
    const fetchImpl = upServerFetch([
      { server: 'playwright-mcp', name: 'browser_navigate', description: 'Открыть URL', inputSchema: { type: 'object' } },
      { server: 'playwright-mcp', name: 'browser_evaluate', description: 'JS', inputSchema: {} },
      { server: 'other-server', name: 'do_something', description: 'чужой', inputSchema: {} },
    ]);
    const pool = new ExecutorMcpPool({ urls: ['http://exec-a:5100'], token: TOKEN, fetchImpl });
    const client = new ExecutorMcpClient('playwright-mcp', pool);

    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.tools.map((tool) => tool.name)).toEqual(['browser_navigate', 'browser_evaluate']);
    expect(client.serverStatus).toBe('up');
    expect(client.instructions).toBeUndefined();
  });

  it('connect() бросает ошибку, если сервер у исполнителя упал (down)', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/mcp/tools')) return json([]);
      return json([{ name: 'playwright-mcp', status: 'down', toolCount: 0, error: 'нет Chromium' }]);
    });
    const pool = new ExecutorMcpPool({ urls: ['http://exec-a'], token: TOKEN, fetchImpl });
    const client = new ExecutorMcpClient('playwright-mcp', pool);

    await expect(client.connect()).rejects.toThrow(/недоступен: нет Chromium/);
    expect(client.isConnected).toBe(false);
  });
});

describe('ExecutorMcpClient: вызов через /mcp/call', () => {
  it('вызывает инструмент и сохраняет isError из ответа, не передавая _meta', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = makeFetch((url, init) => {
      if (url.endsWith('/mcp/tools')) {
        return json([{ server: 'playwright-mcp', name: 'browser_navigate', description: '', inputSchema: {} }]);
      }
      if (url.endsWith('/mcp/servers')) {
        return json([{ name: 'playwright-mcp', status: 'up', toolCount: 1 }]);
      }
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return json({ content: 'navigation failed', isError: true });
    });
    const pool = new ExecutorMcpPool({ urls: ['http://exec-a'], token: TOKEN, fetchImpl });
    const client = new ExecutorMcpClient('playwright-mcp', pool);
    await client.connect();

    const result = await client.callTool(
      'browser_navigate',
      { url: 'https://example.com' },
      { 'synth/session_id': 'sess-1' },
    );

    expect(result).toEqual({ content: 'navigation failed', isError: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      server: 'playwright-mcp',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });
    // API исполнителя (шаг B1) `_meta` не принимает — поле не выдумываем.
    expect(calls[0]!.body).not.toHaveProperty('_meta');
  });

  it('404 → понятная ошибка «не найден у исполнителя»', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/mcp/tools')) return json([]);
      if (url.endsWith('/mcp/servers')) return json([{ name: 'playwright-mcp', status: 'up', toolCount: 0 }]);
      return json({ error: { message: 'Инструмент "nope" не найден' } }, 404);
    });
    const pool = new ExecutorMcpPool({ urls: ['http://exec-a'], token: TOKEN, fetchImpl });
    const client = new ExecutorMcpClient('playwright-mcp', pool);
    await client.connect();

    const result = await client.callTool('nope', {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain('не найден у исполнителя');
  });

  it('усекает результат до 30 000 символов', async () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith('/mcp/tools')) return json([]);
      if (url.endsWith('/mcp/servers')) return json([{ name: 'playwright-mcp', status: 'up', toolCount: 0 }]);
      return json({ content: long, isError: false });
    });
    const pool = new ExecutorMcpPool({ urls: ['http://exec-a'], token: TOKEN, fetchImpl });
    const client = new ExecutorMcpClient('playwright-mcp', pool);
    await client.connect();

    const result = await client.callTool('dump', {});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('усечено');
    expect(result.content.length).toBeLessThan(long.length);
  });
});

describe('ExecutorMcpClient: пул и failover', () => {
  it('первый адрес лежит (5xx) → вызов уходит на второй', async () => {
    const callHosts: string[] = [];
    const fetchImpl = makeFetch((url, init) => {
      const host = new URL(url).host;
      if (url.endsWith('/mcp/tools')) {
        if (host === 'hlocal:5100') return json({ error: { message: 'boom' } }, 500);
        return json([{ server: 'playwright-mcp', name: 'browser_navigate', description: '', inputSchema: {} }]);
      }
      if (url.endsWith('/mcp/servers')) {
        if (host === 'hlocal:5100') return json({ error: { message: 'boom' } }, 500);
        return json([{ name: 'playwright-mcp', status: 'up', toolCount: 1 }]);
      }
      void init;
      callHosts.push(host);
      if (host === 'hlocal:5100') return json({ error: { message: 'boom' } }, 500);
      return json({ content: 'ok', isError: false });
    });
    const pool = new ExecutorMcpPool({
      urls: ['http://hlocal:5100', 'http://hremote:5100'],
      token: TOKEN,
      fetchImpl,
    });
    const client = new ExecutorMcpClient('playwright-mcp', pool);
    await client.connect();

    const result = await client.callTool('browser_navigate', { url: 'https://example.com' });

    expect(result).toEqual({ content: 'ok', isError: false });
    // Первая попытка — «лежащий» адрес, вторая — рабочий.
    expect(callHosts[0]).toBe('hlocal:5100');
    expect(callHosts[callHosts.length - 1]).toBe('hremote:5100');
  });

  it('все адреса лежат → ошибка (без тихого успеха) и без токена в тексте', async () => {
    const fetchImpl = makeFetch((_url) => {
      return json({ error: { message: `нет связи, token=${TOKEN}` } }, 502);
    });
    const pool = new ExecutorMcpPool({
      urls: ['http://a:5100', 'http://b:5100'],
      token: TOKEN,
      fetchImpl,
    });
    const client = new ExecutorMcpClient('playwright-mcp', pool);

    await expect(client.connect()).rejects.toBeInstanceOf(ExecutorMcpUnavailableError);
    await client.connect().catch((err: Error) => {
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).toContain('ни один исполнитель пула не ответил');
    });
  });

  it('пустой пул адресов → ошибка недоступности', async () => {
    const pool = new ExecutorMcpPool({ urls: [], token: TOKEN, fetchImpl: upServerFetch() });
    const client = new ExecutorMcpClient('playwright-mcp', pool);
    await expect(client.connect()).rejects.toThrow(/пул исполнителей не настроен/);
  });

  it('таймаут запроса → ошибка с упоминанием таймаута', async () => {
    const fetchImpl: ExecutorFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const pool = new ExecutorMcpPool({ urls: ['http://slow:5100'], token: TOKEN, fetchImpl });
    const client = new ExecutorMcpClient('playwright-mcp', pool, { connectTimeoutMs: 20 });

    await expect(client.connect()).rejects.toThrow(/таймаут/);
    expect(client.isConnected).toBe(false);
  });
});
