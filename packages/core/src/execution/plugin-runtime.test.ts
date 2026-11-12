/**
 * PROP-138 (Ф1, слайс 138a): runtime плагинного тула поверх порта исполнения.
 *
 * Проверяем контракт узкой обёртки: команды — argv без shell, файловые
 * операции — через FS-часть порта, ошибки порта пробрасываются как есть, а
 * порт без FS даёт типизированный отказ (`ExecutionFsUnavailableError`).
 */

import { describe, it, expect } from 'vitest';
import {
  ExecutionError,
  ExecutionFsUnavailableError,
  type ExecRequest,
  type ExecResult,
  type ExecutionFs,
  type ExecutionPort,
} from './ports/index.js';
import {
  createPluginRuntime,
  isPluginRuntimeError,
  PluginRuntimeError,
  PLUGIN_RUNTIME_DEFAULT_MAX_READ_BYTES,
} from './plugin-runtime.js';

interface FakePort {
  port: ExecutionPort;
  requests: ExecRequest[];
}

/** Порт с журналом запросов; `fs` — по требованию (порта может не быть). */
function makePort(opts: {
  fs?: Partial<ExecutionFs>;
  execute?: (req: ExecRequest) => Promise<ExecResult>;
} = {}): FakePort {
  const requests: ExecRequest[] = [];
  const port: ExecutionPort = {
    async execute(req: ExecRequest): Promise<ExecResult> {
      requests.push(req);
      if (opts.execute) return await opts.execute(req);
      return { stdout: 'out', stderr: 'err', exitCode: 0, truncated: false, durationMs: 1 };
    },
    ...(opts.fs ? { fs: opts.fs as ExecutionFs } : {}),
  };
  return { port, requests };
}

describe('createPluginRuntime — exec (PROP-138 Ф1)', () => {
  it('выполняет argv без shell и пробрасывает cwd/timeoutMs', async () => {
    const { port, requests } = makePort();
    const runtime = createPluginRuntime(port);

    const result = await runtime.exec(['git', 'status', '--short'], {
      cwd: '/workspace/project',
      timeoutMs: 5000,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toEqual({ kind: 'argv', file: 'git', args: ['status', '--short'] });
    expect(requests[0]?.cwd).toBe('/workspace/project');
    expect(requests[0]?.timeoutMs).toBe(5000);
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('без опций запрос не несёт cwd/timeoutMs', async () => {
    const { port, requests } = makePort();
    const runtime = createPluginRuntime(port);

    await runtime.exec(['ls']);

    expect(requests[0]?.command).toEqual({ kind: 'argv', file: 'ls', args: [] });
    expect(requests[0]?.cwd).toBeUndefined();
    expect(requests[0]?.timeoutMs).toBeUndefined();
  });

  it('пустой argv — отказ с машинным кодом, порт не вызывается', async () => {
    const { port, requests } = makePort();
    const runtime = createPluginRuntime(port);

    const error = await runtime.exec([]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPluginRuntimeError(error)).toBe(true);
    expect((error as PluginRuntimeError).code).toBe('invalid_argv');
    expect(requests).toHaveLength(0);
  });

  it('ошибка порта пробрасывается плагину как есть', async () => {
    const failure = new ExecutionError({ message: 'Command failed: git', reason: 'nonzero_exit', code: 1 });
    const { port } = makePort({
      execute: async () => {
        throw failure;
      },
    });
    const runtime = createPluginRuntime(port);

    await expect(runtime.exec(['git', 'status'])).rejects.toBe(failure);
  });
});

describe('createPluginRuntime — fs (PROP-138 Ф1)', () => {
  it('readFile идёт через download с дефолтным потолком', async () => {
    const calls: Array<{ path: string; maxBytes: number }> = [];
    const { port } = makePort({
      fs: {
        async download(path: string, maxBytes: number) {
          calls.push({ path, maxBytes });
          return Buffer.from('payload');
        },
      },
    });
    const runtime = createPluginRuntime(port);

    const data = await runtime.fs.readFile('/workspace/project/file.txt');

    expect(data.toString('utf-8')).toBe('payload');
    expect(calls).toEqual([{ path: '/workspace/project/file.txt', maxBytes: PLUGIN_RUNTIME_DEFAULT_MAX_READ_BYTES }]);
  });

  it('readFile с явным maxBytes уважает потолок вызова', async () => {
    const calls: Array<{ path: string; maxBytes: number }> = [];
    const { port } = makePort({
      fs: {
        async download(path: string, maxBytes: number) {
          calls.push({ path, maxBytes });
          return Buffer.alloc(0);
        },
      },
    });
    const runtime = createPluginRuntime(port);

    await runtime.fs.readFile('/tmp/a', 1024);

    expect(calls[0]?.maxBytes).toBe(1024);
  });

  it('writeFile публикует байты с перезаписью существующего файла', async () => {
    const calls: Array<{ path: string; bytes: Buffer; ifExists: string | undefined }> = [];
    const { port } = makePort({
      fs: {
        async upload(path: string, bytes: Buffer, options?: { ifExists?: 'fail' | 'overwrite' }) {
          calls.push({ path, bytes, ifExists: options?.ifExists });
        },
      },
    });
    const runtime = createPluginRuntime(port);

    await runtime.fs.writeFile('/workspace/project/out.txt', 'данные');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/workspace/project/out.txt');
    expect(calls[0]?.bytes.toString('utf-8')).toBe('данные');
    expect(Buffer.isBuffer(calls[0]?.bytes)).toBe(true);
    expect(calls[0]?.ifExists).toBe('overwrite');
  });

  it('writeFile принимает Buffer как есть', async () => {
    const calls: Buffer[] = [];
    const { port } = makePort({
      fs: {
        async upload(_path: string, bytes: Buffer) {
          calls.push(bytes);
        },
      },
    });
    const runtime = createPluginRuntime(port);

    const payload = Buffer.from([1, 2, 3]);
    await runtime.fs.writeFile('/tmp/b.bin', payload);

    expect(calls[0]).toBe(payload);
  });

  it('stat/readdir/realpath делегируются порту', async () => {
    const { port } = makePort({
      fs: {
        async stat() {
          return { kind: 'file', size: 42, mtimeMs: 1000 };
        },
        async readdir() {
          return [{ name: 'a.txt', kind: 'file', size: 3 }];
        },
        async realpath(path: string) {
          return path;
        },
      },
    });
    const runtime = createPluginRuntime(port);

    expect(await runtime.fs.stat('/workspace/project/a.txt')).toEqual({
      kind: 'file',
      size: 42,
      mtimeMs: 1000,
    });
    expect(await runtime.fs.readdir('/workspace/project')).toEqual([
      { name: 'a.txt', kind: 'file', size: 3 },
    ]);
    expect(await runtime.fs.realpath('/workspace/project/a.txt')).toBe('/workspace/project/a.txt');
  });

  it('порт без FS — типизированный отказ по каждому файловому вызову', async () => {
    const { port } = makePort();
    const runtime = createPluginRuntime(port);

    await expect(runtime.fs.readFile('/tmp/a')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(runtime.fs.writeFile('/tmp/a', 'x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(runtime.fs.stat('/tmp/a')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(runtime.fs.readdir('/tmp')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(runtime.fs.realpath('/tmp/a')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });
});
