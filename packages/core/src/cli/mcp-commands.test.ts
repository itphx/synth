/**
 * Тесты CLI `synth mcp …`: сборка payload'а добавления, резолвинг ключа,
 * HTTP-контур (метод/URL/тело/заголовок), разбор ответа и коды выхода.
 *
 * Команды вызываются программно (`parseAsync`) на отдельном `Command`;
 * транспорт — подменённый `fetchImpl` (сети нет).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';

import type { SynthConfig } from '@itphx/synth-shared';

import { createMcpCommand, buildMcpAddPayload, resolveMcpApiKey } from './mcp-commands.js';

interface FetchCall {
  url: string;
  method: string;
  authorization?: string;
  body?: unknown;
}

type Responder = (call: FetchCall) => Response;

const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = originalExitCode;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(responders: Responder[]): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const responder = responders.shift();
    if (!responder) throw new Error(`Неожиданный запрос: ${call.method} ${call.url}`);
    return responder(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

interface RunOptions {
  responders?: Responder[];
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  calls: FetchCall[];
}

async function runMcp(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { impl, calls } = makeFetch(opts.responders ?? []);
  const outLines: string[] = [];
  const errLines: string[] = [];

  const program = new Command().name('synth');
  program.exitOverride();
  program.addCommand(
    createMcpCommand({
      resolveConnection: async () => ({
        baseUrl: opts.baseUrl ?? 'http://127.0.0.1:5000',
        token: opts.token ?? 'test-token',
      }),
      fetchImpl: opts.fetchImpl ?? impl,
      stdout: (line) => outLines.push(line),
      stderr: (line) => errLines.push(line),
    }),
  );

  await program.parseAsync(['node', 'synth', 'mcp', ...args]);

  return {
    code: typeof process.exitCode === 'number' ? process.exitCode : 0,
    out: outLines.join('\n'),
    err: errLines.join('\n'),
    calls,
  };
}

describe('buildMcpAddPayload', () => {
  it('http: url + description, origin user по умолчанию', () => {
    expect(
      buildMcpAddPayload({
        name: 'search',
        type: 'http',
        url: 'https://mcp.example/mcp',
        description: 'Поиск',
      }),
    ).toEqual({
      name: 'search',
      config: { type: 'http', url: 'https://mcp.example/mcp', description: 'Поиск' },
      origin: 'user',
      enabled: true,
      enabledByDefault: false,
    });
  });

  it('явный --origin instance сохраняется', () => {
    expect(
      buildMcpAddPayload({
        name: 'local',
        type: 'http',
        url: 'http://127.0.0.1:8080/mcp',
        origin: 'instance',
      }),
    ).toMatchObject({ origin: 'instance' });
  });

  it('stdio: command/args/env, origin user, enabledByDefault', () => {
    expect(
      buildMcpAddPayload({
        name: 'files',
        type: 'stdio',
        command: 'npx',
        arg: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        env: ['TOKEN=abc', 'EMPTY='],
        origin: 'user',
        enabledByDefault: true,
      }),
    ).toEqual({
      name: 'files',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        env: { TOKEN: 'abc', EMPTY: '' },
      },
      origin: 'user',
      enabled: true,
      enabledByDefault: true,
    });
  });

  it('отклоняет неверные комбинации флагов', () => {
    expect(() => buildMcpAddPayload({ name: 'x', type: 'stdio' })).toThrow(/--command/);
    expect(() => buildMcpAddPayload({ name: 'x', type: 'http' })).toThrow(/--url/);
    expect(() => buildMcpAddPayload({ name: 'x', type: 'ftp', url: 'u' })).toThrow(/--type/);
    expect(() =>
      buildMcpAddPayload({ name: 'x', type: 'http', url: 'u', command: 'c' }),
    ).toThrow(/--command/);
    expect(() =>
      buildMcpAddPayload({ name: 'x', type: 'stdio', command: 'c', env: ['BROKEN'] }),
    ).toThrow(/--env/);
    expect(() =>
      buildMcpAddPayload({ name: 'x', type: 'http', url: 'u', origin: 'other' }),
    ).toThrow(/--origin/);
  });
});

describe('resolveMcpApiKey', () => {
  const config = { core: { apiKey: 'config-key' } } as unknown as SynthConfig;

  it('приоритет: --api-key > env > config > файл', async () => {
    const readFileImpl = async () => 'file-key';
    await expect(
      resolveMcpApiKey({
        apiKey: 'flag-key',
        env: { SYNTH_API_KEY: 'env-key' },
        config,
        dataDir: '/data',
        readFileImpl,
      }),
    ).resolves.toBe('flag-key');

    await expect(
      resolveMcpApiKey({ env: { SYNTH_API_KEY: 'env-key' }, config, dataDir: '/data', readFileImpl }),
    ).resolves.toBe('env-key');

    await expect(
      resolveMcpApiKey({ env: {}, config, dataDir: '/data', readFileImpl }),
    ).resolves.toBe('config-key');
  });

  it('читает файл {dataDir}/secrets/api-key и обрезает пробелы', async () => {
    const seen: string[] = [];
    await expect(
      resolveMcpApiKey({
        env: {},
        config: { core: { apiKey: '' } } as unknown as SynthConfig,
        dataDir: '/data',
        readFileImpl: async (path) => {
          seen.push(path);
          return '  file-key\n';
        },
      }),
    ).resolves.toBe('file-key');
    expect(seen[0]).toMatch(/secrets[/\\]api-key$/);
  });

  it('нет ключа — пустая строка (ошибку формирует run)', async () => {
    await expect(
      resolveMcpApiKey({
        env: {},
        config: { core: { apiKey: '' } } as unknown as SynthConfig,
        dataDir: '/data',
        readFileImpl: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).resolves.toBe('');
  });
});

describe('synth mcp list', () => {
  it('печатает таблицу реестра и ходит на /registry', async () => {
    const result = await runMcp(['list'], {
      responders: [
        () =>
          json(200, {
            entries: [
              { name: 'fs', origin: 'instance', trust: 'builtin', enabled: true, config: { type: 'stdio' } },
              { name: 'web', origin: 'user', trust: 'community', enabled: false, config: { type: 'http' } },
            ],
          }),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:5000/api/v2/mcp/registry',
      method: 'GET',
      authorization: 'Bearer test-token',
    });
    expect(result.out).toContain('fs');
    expect(result.out).toContain('web');
    expect(result.out).toContain('Всего: 2');
  });

  it('--json печатает сырой ответ', async () => {
    const body = { entries: [{ name: 'fs' }] };
    const result = await runMcp(['list', '--json'], {
      responders: [() => json(200, body)],
    });
    expect(JSON.parse(result.out)).toEqual(body);
  });
});

describe('synth mcp add', () => {
  it('отправляет payload в POST /registry', async () => {
    const result = await runMcp(
      [
        'add',
        '--name', 'search',
        '--type', 'http',
        '--url', 'https://mcp.example/mcp',
        '--description', 'Поиск',
      ],
      { responders: [() => json(201, { name: 'search' })] },
    );

    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:5000/api/v2/mcp/registry',
      method: 'POST',
      body: {
        name: 'search',
        config: { type: 'http', url: 'https://mcp.example/mcp', description: 'Поиск' },
        origin: 'user',
        enabled: true,
        enabledByDefault: false,
      },
    });
    expect(result.out).toContain('Сервер "search" добавлен');
  });

  it('stdio с повторяющимися --arg/--env', async () => {
    const result = await runMcp(
      [
        'add', '--name', 'fs', '--type', 'stdio', '--command', 'npx',
        '--arg', 'a', '--arg', 'b', '--env', 'A=1', '--env', 'B=2',
      ],
      { responders: [() => json(201, { name: 'fs' })] },
    );

    expect(result.code).toBe(0);
    expect(result.calls[0]?.body).toMatchObject({
      config: { type: 'stdio', command: 'npx', args: ['a', 'b'], env: { A: '1', B: '2' } },
    });
  });
});

describe('synth mcp test', () => {
  it('печатает инструменты и toolCount', async () => {
    const result = await runMcp(['test', 'fs'], {
      responders: [
        () =>
          json(200, {
            success: true,
            toolCount: 1,
            tools: [{ name: 'read_file', description: 'Read' }],
          }),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:5000/api/v2/mcp/servers/fs/test',
      method: 'POST',
      body: {},
    });
    expect(result.out).toContain('инструментов: 1');
    expect(result.out).toContain('read_file');
  });

  it('success:false → код 1 и ошибка в stderr', async () => {
    const result = await runMcp(['test', 'fs'], {
      responders: [() => json(200, { success: false, error: 'connection refused' })],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('MCP_TEST_FAILED');
    expect(result.err).toContain('connection refused');
  });
});

describe('synth mcp remove / reconnect', () => {
  it('remove: DELETE /servers/:name', async () => {
    const result = await runMcp(['remove', 'fs'], {
      responders: [() => json(200, { success: true })],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:5000/api/v2/mcp/servers/fs',
      method: 'DELETE',
    });
    expect(result.out).toContain('удалён');
  });

  it('reconnect: POST /servers/:name/reconnect', async () => {
    const result = await runMcp(['reconnect', 'fs'], {
      responders: [
        () => json(200, { success: true, name: 'fs', status: 'connected', connected: true, toolCount: 3 }),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:5000/api/v2/mcp/servers/fs/reconnect',
      method: 'POST',
    });
    expect(result.out).toContain('переподключён');
    expect(result.out).toContain('инструментов: 3');
  });

  it('reconnect success:false → код 1', async () => {
    const result = await runMcp(['reconnect', 'fs'], {
      responders: [() => json(200, { success: false, error: 'boom' })],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('MCP_RECONNECT_FAILED');
  });
});

describe('synth mcp: ошибки транспорта', () => {
  it('HTTP-ошибка → код/текст из тела, exit 1', async () => {
    const result = await runMcp(['list'], {
      responders: [
        () => json(409, { error: { code: 'CONFLICT', message: 'Сервер уже существует' } }),
      ],
    });

    expect(result.code).toBe(1);
    expect(result.err).toBe('Ошибка: CONFLICT: Сервер уже существует');
  });

  it('сервер не отвечает → подсказка запустить synth serve', async () => {
    const result = await runMcp(['list'], {
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('сервер не отвечает на 127.0.0.1:5000; запустите synth serve');
  });

  it('пустой ключ → NO_API_KEY, без запроса', async () => {
    const result = await runMcp(['list'], { token: '' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('NO_API_KEY');
    expect(result.err).toContain('--api-key');
    expect(result.calls).toHaveLength(0);
  });
});
