/**
 * ADR-115 × ADR-077: медиа-раннер — единая точка запуска `ffmpeg`.
 *
 * Проверяются обе реализации: inline (инъектированный spawn, argv без shell,
 * временный каталог удалён) и remote (инъектированный порт, `requires:
 * ['ffmpeg']`, cwd на общем томе, файлы результата, уборка temp). Настоящий
 * `ffmpeg` не нужен.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionError, type ExecRequest, type ExecResult, type ExecutionPort } from '../../execution/ports/index.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import { createMediaRunner, type MediaSpawnInput } from './runner.js';

const BLOB_PATH = 'attachments/aa/deadbeef';

async function blobWith(bytes: Buffer): Promise<MemoryBlobStore> {
  const blobs = new MemoryBlobStore();
  await blobs.write(BLOB_PATH, bytes);
  return blobs;
}

describe('MediaRunner: inline', () => {
  it('вызывает инъектированный spawn: argv без shell, вход — путь, temp удалён', async () => {
    const blobs = await blobWith(Buffer.from('video-bytes'));
    const dirs: string[] = [];
    let inputBytes: Buffer | undefined;
    const spawn = vi.fn(async (input: MediaSpawnInput) => {
      dirs.push(input.cwd);
      // Файл читается, пока временный каталог ещё жив (чистится в finally).
      const inputPath = input.args[2]!;
      inputBytes = await readFile(inputPath);
      return { ok: true, stdout: Buffer.from('OUTPUT'), stderr: '' };
    });
    const runner = createMediaRunner({ blobs, spawn });

    const result = await runner.run({
      args: ['-hide_banner', '-i', 'pipe:0', 'pipe:1'],
      inputBlobPath: BLOB_PATH,
    });

    expect(result).toEqual({ ok: true, outputs: [Buffer.from('OUTPUT')] });
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = spawn.mock.calls[0]![0];
    // shell не используется: аргументы переданы массивом.
    expect(call.args[2]).not.toBe('pipe:0');
    expect(call.args[2]!.endsWith('input.bin')).toBe(true);
    expect(call.args[3]).toBe('pipe:1');
    expect(inputBytes).toEqual(Buffer.from('video-bytes'));
    // Временный каталог удалён в finally.
    expect(dirs[0]).toBeTruthy();
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it('ошибка запуска — типизированный результат без исключения', async () => {
    const blobs = await blobWith(Buffer.from('x'));
    const runner = createMediaRunner({
      blobs,
      spawn: async () => ({ ok: false, stdout: Buffer.alloc(0), stderr: '', reason: 'no_ffmpeg', error: 'ENOENT' }),
    });
    const result = await runner.run({ args: ['-i', 'pipe:0', 'pipe:1'], inputBlobPath: BLOB_PATH });
    expect(result).toMatchObject({ ok: false, reason: 'no_ffmpeg' });
  });

  it('выходной файл больше maxOutputBytes → max_output, readFile не вызывается', async () => {
    const blobs = await blobWith(Buffer.from('audio-bytes'));
    const readFile = vi.fn(async () => Buffer.from('SHOULD-NOT-READ'));
    const runner = createMediaRunner({
      blobs,
      fs: { readFile },
      spawn: async (input: MediaSpawnInput) => {
        // Файл результата — больше лимита (создаётся процессом, не раннером).
        const output = input.args[input.args.length - 1]!;
        await writeFile(output, Buffer.alloc(1024));
        return { ok: true, stdout: Buffer.alloc(0), stderr: '' };
      },
    });

    const result = await runner.run({
      args: ['{input}', '{output}'],
      inputBlobPath: BLOB_PATH,
      capture: 'file',
      outputName: 'out.wav',
      maxOutputBytes: 16,
    });

    expect(result).toMatchObject({ ok: false, reason: 'max_output', outputs: [] });
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('MediaRunner: remote (split-режим)', () => {
  it('порт получает requires:["ffmpeg"], cwd на общем томе; результат читается из файла', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-media-root-'));
    try {
      const blobs = await blobWith(Buffer.from('video-bytes'));
      let captured: ExecRequest | undefined;
      const port = {
        isRemote: true,
        execute: vi.fn(async (req: ExecRequest): Promise<ExecResult> => {
          captured = req;
          const args = req.command.kind === 'argv' ? (req.command.args ?? []) : [];
          const output = args[args.length - 1]!;
          await writeFile(output, 'REMOTE-OUTPUT');
          return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
        }),
      } as unknown as ExecutionPort;
      const runner = createMediaRunner({ blobs, executionPort: port, workspacesRoot: root, uuid: () => 'u-1' });

      const result = await runner.run({
        args: ['-i', '{input}', '{output}'],
        inputBlobPath: BLOB_PATH,
        outputName: 'out.bin',
      });

      expect(result).toEqual({ ok: true, outputs: [Buffer.from('REMOTE-OUTPUT')] });
      expect(captured?.command).toMatchObject({ kind: 'argv', file: 'ffmpeg' });
      expect(captured?.requires).toEqual(['ffmpeg']);
      expect(captured?.cwd).toBe(join(root, '.synth-media', 'u-1'));
      // Временный каталог на общем томе убран.
      expect(existsSync(join(root, '.synth-media', 'u-1'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires не покрыт пулом → dependency_missing, temp всё равно убран', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-media-root-'));
    try {
      const blobs = await blobWith(Buffer.from('x'));
      let cwd = '';
      const port = {
        isRemote: true,
        execute: vi.fn(async (req: ExecRequest): Promise<ExecResult> => {
          cwd = req.cwd ?? '';
          throw new ExecutionError({ message: 'в пуле: 0 из 1', reason: 'dependency_missing', code: 'EDEPENDENCY' });
        }),
      } as unknown as ExecutionPort;
      const runner = createMediaRunner({ blobs, executionPort: port, workspacesRoot: root, uuid: () => 'u-2' });

      const result = await runner.run({
        args: ['-i', '{input}', '{output}'],
        inputBlobPath: BLOB_PATH,
        outputName: 'out.bin',
      });

      expect(result).toMatchObject({ ok: false, reason: 'dependency_missing' });
      expect(cwd).toBe(join(root, '.synth-media', 'u-2'));
      expect(existsSync(cwd)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
