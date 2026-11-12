/**
 * PROP-138 (Ф2, слайс 138b): тесты host-side прокси runtime'а
 * (`remote/runtime-proxy.ts`).
 *
 * Проверки — на **настоящем** HTTP-сервере прокси (`node:http`, loopback) и
 * **настоящей** фейковой поверхности исполнения: подмена `fetch` скрыла бы
 * ровно те дефекты (bearer-токен, привязка к invocation, маппинг ошибок
 * порта), ради которых прокси написан.
 *
 * Проверяется контракт:
 * - 401 без токена / с чужим токеном; токен не появляется в ответах;
 * - неизвестный `invocation_id` → 404 (привязка обязательна);
 * - `exec`/`fs.read`/`fs.write`/`fs.stat`/`fs.readdir`/`fs.realpath` — через
 *   **порт** (единая точка маппинга `createPluginRuntime`) и через готовый
 *   runtime-фасад;
 * - ошибки порта (`ExecutionError`/`FsPathError`) → свой HTTP-статус и
 *   машинный код в `{ error: { code, message } }`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_RUNTIME_PATHS } from '@itphx/synth-shared';
import type { PluginRuntime } from '@itphx/synth-shared';

import {
  ExecutionError,
  FsPathError,
  type ExecRequest,
  type ExecResult,
  type ExecutionFs,
  type ExecutionPort,
} from '../../../execution/ports/index.js';
import { createPluginRuntime } from '../../../execution/plugin-runtime.js';
import { createRuntimeProxy, type RuntimeProxy } from './runtime-proxy.js';

const TOKEN = 'runtime-proxy-token-1234567890abcdef';

/** Поднятые прокси (закрываются в `afterEach`). */
const proxies: RuntimeProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

/** Фейковая поверхность исполнения: команды и файлы. */
interface FakeSurface {
  port: ExecutionPort;
  /** Команды, дошедшие до порта. */
  execCalls: ExecRequest[];
  /** Записи файла, дошедшие до порта. */
  writes: Array<{ path: string; bytes: Buffer }>;
}

/** Создать фейковый порт исполнения (с FS-частью). */
function fakeSurface(over: {
  exec?: (req: ExecRequest) => Promise<ExecResult> | ExecResult;
  download?: (path: string, maxBytes: number) => Promise<Buffer>;
  upload?: (path: string, bytes: Buffer) => Promise<void>;
  stat?: () => Promise<{ kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number }>;
  readdir?: () => Promise<Array<{ name: string; kind: 'file' | 'directory' | 'other'; size: number }>>;
  realpath?: (path: string) => Promise<string>;
} = {}): FakeSurface {
  const execCalls: ExecRequest[] = [];
  const writes: Array<{ path: string; bytes: Buffer }> = [];

  const fs: ExecutionFs = {
    realpath: async (path) => (over.realpath ? over.realpath(path) : path),
    stat: async () =>
      over.stat ? over.stat() : { kind: 'file' as const, size: 0, mtimeMs: 0 },
    readdir: async () => (over.readdir ? over.readdir() : []),
    readText: async () => ({ lines: [], totalLines: 0, truncated: false, bytes: 0 }),
    sniff: async () => ({ binary: false }),
    readBytes: async () => ({ dataBase64: '', size: 0 }),
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    remove: async () => undefined,
    readRawText: async () => ({ text: '', size: 0 }),
    rename: async () => undefined,
    download: async (path, maxBytes) =>
      over.download ? over.download(path, maxBytes) : Buffer.from(''),
    upload: async (path, bytes) => {
      writes.push({ path, bytes: Buffer.from(bytes) });
      if (over.upload) await over.upload(path, bytes);
    },
    hash: async () => '0'.repeat(64),
  };

  const port: ExecutionPort = {
    execute: async (req) => {
      execCalls.push(req);
      if (over.exec) return over.exec(req);
      return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
    },
    fs,
  };

  return { port, execCalls, writes };
}

/** Поднять прокси (с токеном по умолчанию). */
async function startProxy(
  over: Partial<Parameters<typeof createRuntimeProxy>[0]> = {},
): Promise<RuntimeProxy> {
  const proxy = await createRuntimeProxy({ token: TOKEN, ...over });
  proxies.push(proxy);
  return proxy;
}

/** Запрос к прокси (bearer-токен — по умолчанию верный). */
async function call(
  proxy: RuntimeProxy,
  path: string,
  body: unknown,
  over: { token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = over.token === undefined ? TOKEN : over.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${proxy.url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

describe('createRuntimeProxy: аутентификация', () => {
  it('без токена → 401; с чужим токеном → 401', async () => {
    const proxy = await startProxy();

    const anonymous = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, { invocation_id: 'x' }, { token: null });
    expect(anonymous.status).toBe(401);

    const wrong = await call(
      proxy,
      PLUGIN_RUNTIME_PATHS.exec,
      { invocation_id: 'x' },
      { token: 'wrong-token' },
    );
    expect(wrong.status).toBe(401);
    expect(String((wrong.body.error as { code?: string }).code)).toBe('unauthorized');
  });

  it('токен не появляется в ответах (ни в успешном, ни в ошибочном)', async () => {
    const surface = fakeSurface();
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const ok = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['echo', 'hi'],
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);

    const failed = await call(
      proxy,
      PLUGIN_RUNTIME_PATHS.exec,
      { invocation_id: 'inv-1', argv: [] },
    );
    expect(failed.status).toBe(400);
    expect(JSON.stringify(failed.body)).not.toContain(TOKEN);
  });

  it('прокси слушает только loopback', async () => {
    const proxy = await startProxy();
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('createRuntimeProxy: привязка к invocation', () => {
  it('неизвестный invocation → 404 (привязка обязательна)', async () => {
    const proxy = await startProxy();
    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'not-registered',
      argv: ['echo', 'hi'],
    });
    expect(result.status).toBe(404);
    expect(String((result.body.error as { code?: string }).code)).toBe('unknown_invocation');
  });

  it('после unregister invocation больше не работает', async () => {
    const surface = fakeSurface();
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const before = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['echo', 'hi'],
    });
    expect(before.status).toBe(200);

    proxy.unregisterInvocation('inv-1');

    const after = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['echo', 'hi'],
    });
    expect(after.status).toBe(404);
  });

  it('резолвер порта используется, когда привязка не зарегистрирована', async () => {
    const surface = fakeSurface();
    const proxy = await startProxy({ resolvePort: () => surface.port });

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-resolved',
      argv: ['echo', 'hi'],
    });
    expect(result.status).toBe(200);
    expect(surface.execCalls).toHaveLength(1);
  });
});

describe('createRuntimeProxy: операции', () => {
  it('exec → stdout/stderr/exit_code; команда уходит в порт без shell', async () => {
    const surface = fakeSurface({
      exec: async () => ({ stdout: 'hello', stderr: 'warn', exitCode: 0, truncated: false, durationMs: 3 }),
    });
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['git', 'log', '--oneline'],
      cwd: '/ws',
      timeout_ms: 1000,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ stdout: 'hello', stderr: 'warn', exit_code: 0 });
    // argv без shell: команда уходит массивом, а не строкой.
    expect(surface.execCalls[0]?.command).toEqual({
      kind: 'argv',
      file: 'git',
      args: ['log', '--oneline'],
    });
    expect(surface.execCalls[0]?.cwd).toBe('/ws');
    expect(surface.execCalls[0]?.timeoutMs).toBe(1000);
  });

  it('fs/read → data_base64', async () => {
    const surface = fakeSurface({
      download: async () => Buffer.from('ПРИВЕТ', 'utf-8'),
    });
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.fsRead, {
      invocation_id: 'inv-1',
      path: '/ws/a.txt',
      max_bytes: 1024,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data_base64: Buffer.from('ПРИВЕТ', 'utf-8').toString('base64') });
  });

  it('fs/write → пустой ответ; содержимое дошло до порта', async () => {
    const surface = fakeSurface();
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.fsWrite, {
      invocation_id: 'inv-1',
      path: '/ws/a.txt',
      data_base64: Buffer.from('данные', 'utf-8').toString('base64'),
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({});
    expect(surface.writes).toHaveLength(1);
    expect(surface.writes[0]?.path).toBe('/ws/a.txt');
    expect(surface.writes[0]?.bytes.toString('utf-8')).toBe('данные');
  });

  it('fs/stat, fs/readdir, fs/realpath → DTO как у PluginRuntimeFs', async () => {
    const surface = fakeSurface({
      stat: async () => ({ kind: 'file' as const, size: 42, mtimeMs: 1_700_000_000_000 }),
      readdir: async () => [
        { name: 'a.txt', kind: 'file' as const, size: 1 },
        { name: 'sub', kind: 'directory' as const, size: 0 },
      ],
      realpath: async () => '/real/a.txt',
    });
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const stat = await call(proxy, PLUGIN_RUNTIME_PATHS.fsStat, {
      invocation_id: 'inv-1',
      path: '/ws/a.txt',
    });
    expect(stat.body).toEqual({ kind: 'file', size: 42, mtime_ms: 1_700_000_000_000 });

    const readdir = await call(proxy, PLUGIN_RUNTIME_PATHS.fsReaddir, {
      invocation_id: 'inv-1',
      path: '/ws',
    });
    expect(readdir.body).toEqual({
      entries: [
        { name: 'a.txt', kind: 'file', size: 1 },
        { name: 'sub', kind: 'directory', size: 0 },
      ],
    });

    const realpath = await call(proxy, PLUGIN_RUNTIME_PATHS.fsRealpath, {
      invocation_id: 'inv-1',
      path: '/ws/a.txt',
    });
    expect(realpath.body).toEqual({ path: '/real/a.txt' });
  });

  it('привязка к готовому runtime-фасаду работает так же (путь загрузчика)', async () => {
    const surface = fakeSurface();
    const runtime: PluginRuntime = createPluginRuntime(surface.port);
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', runtime);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['echo', 'hi'],
    });
    expect(result.status).toBe(200);
    expect(surface.execCalls).toHaveLength(1);
  });
});

describe('createRuntimeProxy: ошибки', () => {
  it('невалидное тело → 400 invalid_request', async () => {
    const proxy = await startProxy();
    const response = await fetch(`${proxy.url}${PLUGIN_RUNTIME_PATHS.exec}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: 'не json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_request');
  });

  it('пустой argv → 400 (команда не запускается)', async () => {
    const surface = fakeSurface();
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: [],
    });
    expect(result.status).toBe(400);
    expect(surface.execCalls).toHaveLength(0);
  });

  it('ошибка исполнения (ExecutionError) → 500 и машинный код причины', async () => {
    const surface = fakeSurface({
      exec: async () => {
        throw new ExecutionError({
          message: 'Command failed: git log',
          reason: 'nonzero_exit',
          code: 128,
          stdout: 'out',
          stderr: 'err',
        });
      },
    });
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['git', 'log'],
    });

    expect(result.status).toBe(500);
    const error = result.body.error as { code?: string; message?: string; stdout?: string };
    expect(error.code).toBe('nonzero_exit');
    expect(error.message).toContain('Command failed');
    // Вывод команды не теряется: плагин видит, чем закончилась команда.
    expect(error.stdout).toBe('out');
  });

  it('таймаут исполнения → 504', async () => {
    const surface = fakeSurface({
      exec: async () => {
        throw new ExecutionError({ message: 'timeout', reason: 'timeout' });
      },
    });
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const result = await call(proxy, PLUGIN_RUNTIME_PATHS.exec, {
      invocation_id: 'inv-1',
      argv: ['sleep', '10'],
    });
    expect(result.status).toBe(504);
  });

  it('ошибка FS (FsPathError) → статус по коду: not_found → 404, permission → 403', async () => {
    const surface = fakeSurface({
      download: async (path) => {
        throw new FsPathError('not_found', path);
      },
    });
    const proxy = await startProxy();
    proxy.registerInvocation('inv-1', surface.port);

    const notFound = await call(proxy, PLUGIN_RUNTIME_PATHS.fsRead, {
      invocation_id: 'inv-1',
      path: '/ws/none.txt',
    });
    expect(notFound.status).toBe(404);
    expect(String((notFound.body.error as { code?: string }).code)).toBe('not_found');

    const denied = fakeSurface({
      download: async (path) => {
        throw new FsPathError('permission', path);
      },
    });
    const proxy2 = await startProxy();
    proxy2.registerInvocation('inv-2', denied.port);
    const forbidden = await call(proxy2, PLUGIN_RUNTIME_PATHS.fsRead, {
      invocation_id: 'inv-2',
      path: '/ws/secret.txt',
    });
    expect(forbidden.status).toBe(403);
    expect(String((forbidden.body.error as { code?: string }).code)).toBe('permission');
  });

  it('неизвестный путь → 404; не-POST → 405', async () => {
    const proxy = await startProxy();

    const unknown = await call(proxy, '/runtime/unknown', { invocation_id: 'inv-1' });
    expect(unknown.status).toBe(404);

    const response = await fetch(`${proxy.url}${PLUGIN_RUNTIME_PATHS.exec}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(405);
  });
});
