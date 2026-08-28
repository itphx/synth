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

describe('fs-read tools — прерывание по «Стоп» (abortSignal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-abort-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
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

  it('read_file: pre-aborted — мгновенный маркер прерывания, файл не читается', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await readFileTool.execute(
      { file_path: 'src/a.ts' },
      makeCtx({ abortSignal: ac.signal }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).not.toContain('export const a = 1');
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
  });

  it('list_directory и glob: pre-aborted — мгновенный маркер прерывания', async () => {
    const ac = new AbortController();
    ac.abort();

    const listResult = await listDirectoryTool.execute({}, makeCtx({ abortSignal: ac.signal }));
    expect(listResult.metadata?.interrupted).toBe(true);

    const globResult = await globTool.execute({ pattern: '*.ts' }, makeCtx({ abortSignal: ac.signal }));
    expect(globResult.metadata?.interrupted).toBe(true);
  });

  it('без abortSignal — чтение работает как раньше (обратная совместимость)', async () => {
    const result = await readFileTool.execute({ file_path: 'src/a.ts' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export const a = 1');
    expect(result.metadata?.interrupted).toBeUndefined();
  });
});
