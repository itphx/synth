/**
 * Загрузчик удалённого порта (ADR-077, шаг 7b) — fail-closed и секреты.
 *
 * Проверяется:
 * - токен читается из файла, указанного в `execution.remote.tokenSecret`
 *   (это **путь**, а не значение — инвариант 13);
 * - значение токена не попадает ни в текст ошибки, ни в конфигурацию;
 * - недоступность токена/адресов/пакета — **понятная ошибка**, а не молчаливый
 *   возврат в inline-исполнение.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, resolveExecutionConfig, type ToolContext } from '@itphx/synth-shared';
import { InlineExecutionPort } from './inline-execution-port.js';
import { createExecutionPortForConfig } from './factory.js';
import {
  RemoteExecutionPortWithExecutorMcp,
  RemoteExecutionUnavailableError,
  createRemoteExecutionPortFromConfig,
  isExecutorPackageAvailable,
  readExecutorToken,
} from './remote.js';
import type {
  ExecutionFs,
  ExecutionPort,
  ExecRequest,
  ExecResult,
} from './ports/index.js';
import { listDirectoryTool } from '../engine/tools/fs-read.js';
import { FS_UNAVAILABLE_TEXT } from './fs-perimeter.js';

const SECRET = 's3cr3t-executor-token-value';

/** Собрать эффективную секцию `execution` из куска конфигурации. */
function execution(overrides: { mode?: 'inline' | 'remote'; url?: string[]; tokenSecret?: string }) {
  return resolveExecutionConfig(
    {
      ...defaultConfig,
      execution: {
        mode: overrides.mode ?? 'inline',
        remote: {
          url: overrides.url ?? [],
          timeoutMs: 30_000,
          concurrency: 2,
          failMode: 'fail',
          tokenSecret: overrides.tokenSecret ?? '',
          // PROP-135 Ф4a: пулы/профили (в этом тесте — дефолтные).
          pooling: 'instance',
          defaultProfile: 'default',
          browserProfile: 'browser',
          browserProfiles: [],
          browserMcpServer: 'playwright',
          profiles: {},
          fallback: 'instance',
          // PROP-135 Ф4b-1: провайдер пулов и параметры provisioner'а.
          provider: 'static',
          provisioner: { url: '', tokenSecret: '', timeoutMs: 10_000 },
        },
      },
    },
    {},
  );
}

describe('ADR-077: чтение токена исполнителя', () => {
  it('читает значение из файла и обрезает пробелы', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'token');
      await writeFile(file, `  ${SECRET}\n`, 'utf-8');
      expect(await readExecutorToken(file)).toBe(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('пустой путь — ошибка (токен не настроен)', async () => {
    await expect(readExecutorToken('')).rejects.toBeInstanceOf(RemoteExecutionUnavailableError);
  });

  it('несуществующий файл — понятная ошибка (путь — в тексте, значение токена — нет)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'missing-token');
      const err = await readExecutorToken(file).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteExecutionUnavailableError);
      expect((err as Error).message).toContain(file);
      expect((err as Error).message).not.toContain(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('пустой файл — понятная ошибка', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'empty-token');
      await writeFile(file, '   \n', 'utf-8');
      await expect(readExecutorToken(file)).rejects.toBeInstanceOf(RemoteExecutionUnavailableError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ADR-077: загрузчик удалённого порта — fail-closed', () => {
  it('пустой список адресов — ошибка (не молчаливый inline)', async () => {
    const err = await createRemoteExecutionPortFromConfig(execution({ mode: 'remote' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteExecutionUnavailableError);
    expect((err as Error).message).toContain('execution.remote.url');
  });

  it('нечитаемый токен — ошибка (значение токена в тексте ошибки нет)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'token');
      await writeFile(file, SECRET, 'utf-8');
      // Секрет испорчен: путь указывает на каталог — чтение невозможно.
      const err = await createRemoteExecutionPortFromConfig(
        execution({ mode: 'remote', url: ['http://127.0.0.1:59999'], tokenSecret: dir }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteExecutionUnavailableError);
      expect((err as Error).message).not.toContain(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ADR-077: фабрика выбора порта по режиму', () => {
  it('inline — исполнение в процессе (прежнее поведение)', async () => {
    const port = await createExecutionPortForConfig(execution({ mode: 'inline' }));
    expect(port).toBeInstanceOf(InlineExecutionPort);
    expect(port.isRemote).toBe(false);
  });

  it('конфиг не задан — тоже inline (fail-safe для сборок без секции)', async () => {
    const port = await createExecutionPortForConfig(undefined);
    expect(port).toBeInstanceOf(InlineExecutionPort);
    expect(port.isRemote).toBe(false);
  });
});

/**
 * Remote-режим целиком — только при установленном пакете исполнителя
 * (`@itphx/synth-executor` — опциональная зависимость core). Без собранного
 * пакета блок пропускается явно.
 */
describe.skipIf(!(await isExecutorPackageAvailable()))('ADR-077: фабрика в remote-режиме', () => {
  it('remote — порт не inline (исполнение уходит к исполнителю)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'token');
      await writeFile(file, `${SECRET}\n`, 'utf-8');
      const port = await createExecutionPortForConfig(
        execution({ mode: 'remote', url: ['http://127.0.0.1:59999'], tokenSecret: file }),
      );
      expect(port).not.toBeInstanceOf(InlineExecutionPort);
      expect(port.isRemote).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** FS-реализация порта с подменой отдельных методов (образец — `fs-read.test.ts`). */
function makeFs(overrides: Partial<ExecutionFs> = {}): ExecutionFs {
  return {
    realpath: async (path) => path,
    stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    readdir: async () => [],
    readText: async () => ({ lines: [], totalLines: 0, truncated: false, bytes: 0 }),
    sniff: async () => ({ binary: false }),
    readBytes: async () => ({ dataBase64: '', size: 0 }),
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    remove: async () => undefined,
    readRawText: async () => ({ text: '', size: 0 }),
    rename: async () => undefined,
    download: async () => Buffer.alloc(0),
    upload: async () => undefined,
    hash: async () => '',
    ...overrides,
  };
}

/** Внутренний порт обёртки: только `execute` (+ необязательная FS-часть). */
function fakePort(fs?: ExecutionFs): ExecutionPort {
  return {
    async execute(_req: ExecRequest): Promise<ExecResult> {
      return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
    },
    ...(fs ? { fs } : {}),
  };
}

/**
 * PROP-135: обёртка `RemoteExecutionPortWithExecutorMcp` не теряет FS-часть
 * порта. Регресс 0.13.9: без делегирования `fs` файловые тулы в remote-режиме
 * отвечали «Filesystem operations are unavailable…», хотя исполнитель FS умеет.
 */
describe('PROP-135: обёртка удалённого порта делегирует FS-часть', () => {
  it('fs отдаётся как у внутреннего порта; stat/realpath/readdir делегируются', async () => {
    const calls: string[] = [];
    const innerFs = makeFs({
      realpath: async (path) => {
        calls.push(`realpath:${path}`);
        return path;
      },
      stat: async (path) => {
        calls.push(`stat:${path}`);
        return { kind: 'directory', size: 0, mtimeMs: 0 };
      },
      readdir: async (path) => {
        calls.push(`readdir:${path}`);
        return [{ name: 'a.txt', kind: 'file', size: 3 }];
      },
    });
    const wrapper = new RemoteExecutionPortWithExecutorMcp(
      fakePort(innerFs),
      ['http://127.0.0.1:1'],
      'token',
    );

    expect(wrapper.fs).toBe(innerFs);
    expect(await wrapper.fs!.realpath('/workspace')).toBe('/workspace');
    expect((await wrapper.fs!.stat('/workspace')).kind).toBe('directory');
    expect(await wrapper.fs!.readdir('/workspace')).toEqual([
      { name: 'a.txt', kind: 'file', size: 3 },
    ]);
    expect(calls).toEqual(['realpath:/workspace', 'stat:/workspace', 'readdir:/workspace']);
  });

  it('внутренний порт без FS — fs не определён (fail-closed на уровне тулов)', () => {
    const wrapper = new RemoteExecutionPortWithExecutorMcp(fakePort(), [], 'token');
    expect(wrapper.fs).toBeUndefined();
  });

  it('list_directory через обёртку не отдаёт «FS недоступна» (регресс 0.13.9)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-remote-fs-'));
    try {
      const innerFs = makeFs({
        stat: async () => ({ kind: 'directory', size: 0, mtimeMs: 0 }),
        readdir: async () => [{ name: 'remote.txt', kind: 'file', size: 7 }],
      });
      const wrapper = new RemoteExecutionPortWithExecutorMcp(
        fakePort(innerFs),
        ['http://127.0.0.1:1'],
        'token',
      );
      const ctx: ToolContext = {
        sessionId: 's1',
        messageId: 'm1',
        workingDir: dir,
        extra: { executionPort: wrapper },
      };

      const result = await listDirectoryTool.execute({ path: '.' }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toBe(FS_UNAVAILABLE_TEXT);
      expect(result.content).not.toContain('Filesystem operations are unavailable');
      expect(result.content).toContain('remote.txt (7 bytes)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
