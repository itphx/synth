import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createExecutorApp } from './server.js';
import { ExecutorMcpHost, type McpServerSpec } from './mcp.js';
import type { ExecErrorBody } from './protocol.js';

const TOKEN = 'executor-token-test-1234567890';
const FIXTURE = fileURLToPath(new URL('../test-fixtures/mcp-stdio-server.mjs', import.meta.url));

const hosts: ExecutorMcpHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop();
    await host?.close();
  }
});

/** Описание тестового MCP-сервера. */
function spec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    name: 'test-mcp',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    ...overrides,
  };
}

/** Приложение с MCP-хостом (короткие таймауты — тесты не ждут минуты). */
function makeApp(
  servers: McpServerSpec[],
  opts: { toolTimeoutMs?: number } = {},
): Hono {
  const host = new ExecutorMcpHost(servers, {
    connectTimeoutMs: 5_000,
    toolTimeoutMs: opts.toolTimeoutMs ?? 5_000,
  });
  hosts.push(host);
  return createExecutorApp({
    token: TOKEN,
    workspaceRoot: process.cwd(),
    toolchain: { git: 'git version 2.39.2' },
    mcpHost: host,
  }) as unknown as Hono;
}

/** GET с токеном (или без него). */
function get(app: Hono, path: string, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(app.request(path, { headers }));
}

/** POST /mcp/call с телом. */
function call(app: Hono, body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(
    app.request('/mcp/call', { method: 'POST', headers, body: JSON.stringify(body) }),
  );
}

async function readError(res: Response): Promise<ExecErrorBody> {
  const body = (await res.json()) as { error: ExecErrorBody };
  return body.error;
}

describe('исполнитель: MCP-эндпоинты — аутентификация', () => {
  it('/mcp/servers без токена — 401', async () => {
    const app = makeApp([spec()]);
    const res = await get(app, '/mcp/servers', null);
    expect(res.status).toBe(401);
    expect((await readError(res)).reason).toBe('unauthorized');
  });

  it('/mcp/tools без токена — 401', async () => {
    const app = makeApp([spec()]);
    const res = await get(app, '/mcp/tools', null);
    expect(res.status).toBe(401);
  });

  it('/mcp/call без токена — 401', async () => {
    const app = makeApp([spec()]);
    const res = await call(app, { server: 'test-mcp', tool: 'echo' }, null);
    expect(res.status).toBe(401);
  });
});

describe('исполнитель: MCP-эндпоинты — серверы и инструменты', () => {
  it('/mcp/servers — список серверов без значений env', async () => {
    const app = makeApp([spec({ env: { TEST_SECRET: 'super-secret-value' } })]);
    const res = await get(app, '/mcp/servers');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('super-secret-value');
    const body = JSON.parse(text) as Array<{
      name: string;
      status: string;
      toolCount: number;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.name).toBe('test-mcp');
    expect(body[0]?.status).toBe('idle');
  });

  it('/mcp/tools — инструменты поднятых серверов', async () => {
    const app = makeApp([spec()]);
    const res = await get(app, '/mcp/tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      server: string;
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]?.server).toBe('test-mcp');
    expect(body[0]?.inputSchema).toBeTypeOf('object');
  });

  it('/mcp/tools — упавший сервер пропускается, его причина видна в /mcp/servers', async () => {
    const app = makeApp([
      spec({ name: 'broken-mcp', args: [FIXTURE, '--mode=crash'] }),
      spec({ name: 'ok-mcp' }),
    ]);
    const tools = (await (await get(app, '/mcp/tools')).json()) as Array<{ server: string }>;
    expect(tools.every((tool) => tool.server === 'ok-mcp')).toBe(true);
    const servers = (await (await get(app, '/mcp/servers')).json()) as Array<{
      name: string;
      status: string;
      error?: string;
    }>;
    const broken = servers.find((server) => server.name === 'broken-mcp');
    expect(broken?.status).toBe('down');
    expect(broken?.error).toBeTruthy();
  });

  it('/mcp/servers — несуществующий бинарник даёт down с причиной, а не idle', async () => {
    // Регрессия: при неудачном спавне (нет бинарника) статус обязан быть `down`
    // с причиной — иначе оператор видит `idle` («ещё не поднимали») и не может
    // отличить «сервер не настроен подниматься» от «сервер не запускается».
    const app = makeApp([spec({ command: '/nonexistent-binary-synth-b1' })]);
    const tools = await (await get(app, '/mcp/tools')).json();
    expect(tools).toEqual([]);
    const servers = (await (await get(app, '/mcp/servers')).json()) as Array<{
      name: string;
      status: string;
      toolCount: number;
      error?: string;
    }>;
    expect(servers[0]?.status).toBe('down');
    expect(servers[0]?.toolCount).toBe(0);
    expect(servers[0]?.error).toMatch(/ENOENT/);
  });
});

describe('исполнитель: MCP-эндпоинты — вызов инструмента', () => {
  it('успешный вызов — 200 { content, isError }', async () => {
    const app = makeApp([spec()]);
    const res = await call(app, { server: 'test-mcp', tool: 'echo', arguments: { text: 'ок' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; isError: boolean };
    expect(body.content).toBe('ок');
    expect(body.isError).toBe(false);
  });

  it('ошибка инструмента — 200 с isError', async () => {
    const app = makeApp([spec()]);
    const res = await call(app, { server: 'test-mcp', tool: 'boom' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; isError: boolean };
    expect(body.isError).toBe(true);
  });

  it('неизвестный сервер — 404', async () => {
    const app = makeApp([spec()]);
    const res = await call(app, { server: 'nope', tool: 'echo' });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('неизвестный инструмент — 404', async () => {
    const app = makeApp([spec()]);
    const res = await call(app, { server: 'test-mcp', tool: 'nope' });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('невалидное тело — 400', async () => {
    const app = makeApp([spec()]);
    const res = await call(app, { tool: 'echo' });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('невалидный JSON — 400', async () => {
    const app = makeApp([spec()]);
    const res = await app.request('/mcp/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('ошибка MCP (таймаут вызова) — 500 с текстом ошибки', async () => {
    const app = makeApp([spec()], { toolTimeoutMs: 300 });
    const res = await call(app, { server: 'test-mcp', tool: 'slow', arguments: { sleepMs: 5000 } });
    expect(res.status).toBe(500);
    const error = await readError(res);
    expect(error.reason).toBe('internal_error');
    expect(error.message).toMatch(/Таймаут вызова/);
  });

  it('недоступный сервер — 500 с понятной причиной', async () => {
    const app = makeApp([spec({ args: [FIXTURE, '--mode=crash'] })]);
    const res = await call(app, { server: 'test-mcp', tool: 'echo' });
    expect(res.status).toBe(500);
    const error = await readError(res);
    expect(error.reason).toBe('internal_error');
    expect(error.message).toMatch(/недоступен/);
  });

  it('секрет из env сервера не попадает в ответ', async () => {
    const app = makeApp([spec({ env: { TEST_SECRET: 'super-secret-value' } })]);
    const res = await call(app, { server: 'test-mcp', tool: 'boom' });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('super-secret-value');
  });
});
