import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool, listDirectoryTool, globTool } from './fs-read.js';
import type { ToolContext } from '@itphx/synth-shared';

describe('fs-read tools — path resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(tmpDir, 'README.md'), '# Hello\n');
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

  it('read_file: относительный путь резолвится относительно рабочего каталога', async () => {
    const result = await readFileTool.execute({ file_path: 'src/a.ts' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export const a = 1');
  });

  it('read_file: абсолютный путь', async () => {
    const result = await readFileTool.execute({ file_path: join(tmpDir, 'src', 'a.ts') }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a = 1');
  });

  it('read_file: абсолютный путь вне рабочего каталога разрешён', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-fsread-out-'));
    try {
      await writeFile(join(outside, 'x.txt'), 'outside');
      const result = await readFileTool.execute({ file_path: join(outside, 'x.txt') }, makeCtx());
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('read_file: без пути — резолвится рабочий каталог (ошибка чтения, а не валидации)', async () => {
    // аргументы проходят zod (file_path optional), резолвится workingDir;
    // чтение директории как файла даёт ошибку файловой системы
    await expect(readFileTool.execute({}, makeCtx())).rejects.toThrow();
  });

  it('list_directory: относительный путь', async () => {
    const result = await listDirectoryTool.execute({ path: 'src' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a.ts');
  });

  it('list_directory: без пути — рабочий каталог', async () => {
    const result = await listDirectoryTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('src');
    expect(result.content).toContain('README.md');
  });

  it('glob: относительный путь', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: 'src' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a.ts');
  });
});
