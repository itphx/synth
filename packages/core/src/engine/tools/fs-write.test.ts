import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileTool, createDirectoryTool, deleteFileTool } from './fs-write.js';
import type { ToolContext } from '@synth/shared';

describe('fs-write tools — path resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fswrite-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('write_file: относительный путь создаёт вложенные директории', async () => {
    const result = await writeFileTool.execute({ file_path: 'notes/hello.txt', content: 'hi' }, makeCtx());
    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'notes', 'hello.txt'), 'utf-8')).resolves.toBe('hi');
  });

  it('write_file: абсолютный путь вне рабочего каталога разрешён', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-fswrite-out-'));
    try {
      const result = await writeFileTool.execute({ file_path: join(outside, 'o.txt'), content: 'x' }, makeCtx());
      expect(result.isError).toBeFalsy();
      await expect(readFile(join(outside, 'o.txt'), 'utf-8')).resolves.toBe('x');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('create_directory: относительный путь', async () => {
    const result = await createDirectoryTool.execute({ path: 'deep/nested' }, makeCtx());
    expect(result.isError).toBeFalsy();
    await expect(access(join(tmpDir, 'deep', 'nested'))).resolves.toBeUndefined();
  });

  it('delete_file: относительный путь', async () => {
    await writeFile(join(tmpDir, 'del.txt'), 'x');
    const result = await deleteFileTool.execute({ file_path: 'del.txt' }, makeCtx());
    expect(result.isError).toBeFalsy();
    await expect(access(join(tmpDir, 'del.txt'))).rejects.toThrow();
  });

  it('write_file: пустой путь отклоняется как мусор', async () => {
    await expect(writeFileTool.execute({ file_path: '', content: 'x' }, makeCtx())).rejects.toThrow();
  });

  it('create_directory: абсолютный путь', async () => {
    const result = await createDirectoryTool.execute({ path: join(tmpDir, 'abs') }, makeCtx());
    expect(result.isError).toBeFalsy();
    await expect(access(join(tmpDir, 'abs'))).resolves.toBeUndefined();
  });
});
