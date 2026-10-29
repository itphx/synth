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

  it('read_file: без пути — резолвится рабочий каталог (листинг, а не ошибка)', async () => {
    // аргументы проходят zod (file_path optional), резолвится workingDir;
    // путь-каталог отдаёт листинг (паритет с opencode)
    const result = await readFileTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.type).toBe('directory');
    expect(result.content).toContain('README.md');
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

describe('read_file — пагинация и усечение (паритет с opencode)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-page-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('offset/limit: возвращается только запрошенная страница, нумерация исходная 1-based', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(tmpDir, 'ten.txt'), lines.join('\n'));

    const result = await readFileTool.execute({ file_path: 'ten.txt', offset: 2, limit: 3 }, makeCtx());

    expect(result.isError).toBeFalsy();
    // offset 0-based → первая строка страницы имеет номер offset + 1;
    // за страницей есть ещё строки → маркер усечения
    const outLines = String(result.content).split('\n');
    expect(outLines.slice(0, 3)).toEqual(['3: line-3', '4: line-4', '5: line-5']);
    expect(outLines[3]).toContain('showing the first 3 lines');
    expect(result.metadata).toMatchObject({ type: 'file', totalLines: 10, offset: 2, limit: 3, truncated: true });
  });

  it('offset без limit: читаем до конца файла', async () => {
    await writeFile(join(tmpDir, 'five.txt'), 'a\nb\nc\nd\ne\n');
    const result = await readFileTool.execute({ file_path: 'five.txt', offset: 3 }, makeCtx());
    expect(result.content.split('\n')).toEqual(['4: d', '5: e']);
    expect(result.metadata).toMatchObject({ totalLines: 5, truncated: false });
  });

  it('offset за концом файла → понятный маркер, а не пустой вывод', async () => {
    await writeFile(join(tmpDir, 'two.txt'), 'a\nb\n');
    const result = await readFileTool.execute({ file_path: 'two.txt', offset: 10 }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('out of range');
  });

  it('пустой файл → отдельный маркер (не «вне диапазона»)', async () => {
    await writeFile(join(tmpDir, 'empty.txt'), '');
    const result = await readFileTool.execute({ file_path: 'empty.txt' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('(empty file)');
    expect(result.metadata).toMatchObject({ totalLines: 0, truncated: false });
  });

  it('дефолтный лимит — 2000 строк, при усечении маркер в конце', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `row-${i + 1}`);
    await writeFile(join(tmpDir, 'big.txt'), lines.join('\n'));

    const out = await readFileTool.execute({ file_path: 'big.txt' }, makeCtx());
    const outLines = String(out.content).split('\n');

    expect(outLines).toHaveLength(2001); // 2000 строк + маркер
    expect(outLines[0]).toBe('1: row-1');
    expect(outLines[1999]).toBe('2000: row-2000');
    expect(outLines[2000]).toContain('showing the first 2000 lines');
    expect(out.metadata).toMatchObject({ totalLines: 2100, truncated: true });
  });

  it('limit больше максимума обрезается до 2000', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `r${i + 1}`);
    await writeFile(join(tmpDir, 'big2.txt'), lines.join('\n'));

    const out = await readFileTool.execute({ file_path: 'big2.txt', limit: 5000 }, makeCtx());
    expect(out.metadata?.limit).toBe(2000);
    expect(String(out.content).split('\n')).toHaveLength(2001);
  });

  it('жёсткий cap 50 КБ: длинные строки не дают раздуть вывод', async () => {
    const line = 'x'.repeat(1000);
    const lines = Array.from({ length: 200 }, (_, i) => `${i + 1}-${line}`);
    await writeFile(join(tmpDir, 'wide.txt'), lines.join('\n'));

    const out = await readFileTool.execute({ file_path: 'wide.txt' }, makeCtx());
    const text = String(out.content);

    expect(out.metadata?.truncated).toBe(true);
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(50 * 1024 + 200);
    expect(text).toContain('showing the first');
    // далеко не все 200 строк попали в вывод
    expect((out.metadata?.bytes as number)).toBeLessThanOrEqual(50 * 1024);
  });

  it('длинная строка обрезается до 2000 символов с суффиксом', async () => {
    const long = 'y'.repeat(5000);
    await writeFile(join(tmpDir, 'long.txt'), `${long}\nshort\n`);

    const out = await readFileTool.execute({ file_path: 'long.txt' }, makeCtx());
    const [first, second] = String(out.content).split('\n');

    expect(first).toContain('(line truncated)');
    // префикс "1: " + 2000 символов + суффикс
    expect(first!.length).toBeLessThan(2100);
    expect(second).toBe('2: short');
  });

  it('бинарный файл → isError с подсказкой, содержимое не декодируется', async () => {
    await writeFile(join(tmpDir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]));

    const out = await readFileTool.execute({ file_path: 'blob.bin' }, makeCtx());

    expect(out.isError).toBe(true);
    expect(out.content).toContain('binary file');
    expect(out.content).toContain('attach_workspace_file');
    expect(out.content).toContain('execute_shell');
    expect(out.metadata).toMatchObject({ type: 'binary' });
  });

  it('путь-каталог: листинг (сначала каталоги), offset/limit по записям', async () => {
    await mkdir(join(tmpDir, 'zdir'));
    await mkdir(join(tmpDir, 'adir'));
    await writeFile(join(tmpDir, 'b.txt'), 'bb');
    await writeFile(join(tmpDir, 'a.txt'), 'a');

    const all = await readFileTool.execute({ file_path: '.' }, makeCtx());
    expect(all.metadata).toMatchObject({ type: 'directory', totalEntries: 4, truncated: false });
    const names = String(all.content).split('\n').map((l) => l.split(' ')[0]);
    expect(names).toEqual(['adir/', 'zdir/', 'a.txt', 'b.txt']);

    const page = await readFileTool.execute({ file_path: '.', offset: 2, limit: 1 }, makeCtx());
    expect(String(page.content).split('\n')[0]).toBe('a.txt (1 bytes)');
    expect(page.metadata).toMatchObject({ offset: 2, limit: 1 });
  });

  it('каталог: усечение по limit даёт маркер', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(tmpDir, `f${i}.txt`), 'x');
    const out = await readFileTool.execute({ file_path: '.', limit: 2 }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('showing the first 2 entries');
    expect(out.metadata).toMatchObject({ truncated: true, totalEntries: 5 });
  });
});

describe('glob — hidden/limit/сортировка (через rg --files)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-glob-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(join(tmpDir, '.git'), { recursive: true });
    await writeFile(join(tmpDir, 'b.ts'), 'b');
    await writeFile(join(tmpDir, 'a.ts'), 'a');
    await writeFile(join(tmpDir, 'src', 'c.ts'), 'c');
    await writeFile(join(tmpDir, '.hidden.ts'), 'h');
    await writeFile(join(tmpDir, '.git', 'config'), 'gitconfig');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('скрытые файлы по умолчанию не попадают в вывод', async () => {
    const out = await globTool.execute({ pattern: '*.ts' }, makeCtx());
    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain('.hidden.ts');
  });

  it('hidden=true включает скрытые, но не .git', async () => {
    const out = await globTool.execute({ pattern: '**/*', hidden: true }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toContain('.hidden.ts');
    expect(lines.some((l) => l.startsWith('.git/'))).toBe(false);
  });

  it('результат отсортирован по возрастанию', async () => {
    const out = await globTool.execute({ pattern: '*.ts' }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toEqual([...lines].sort());
    expect(lines).toEqual(['a.ts', 'b.ts', 'src/c.ts']);
  });

  it('limit обрезает вывод и добавляет маркер', async () => {
    const out = await globTool.execute({ pattern: '*.ts', limit: 2 }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(['a.ts', 'b.ts']);
    expect(lines[2]).toContain('showing the first 2 of 3 files');
    expect(out.metadata).toMatchObject({ count: 2, total: 3, truncated: true });
  });

  it('нет совпадений → сообщение, а не ошибка', async () => {
    const out = await globTool.execute({ pattern: '*.nope' }, makeCtx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('no files found');
    expect(out.metadata).toMatchObject({ count: 0, total: 0 });
  });

  it('описание не обещает сортировку по mtime', async () => {
    expect(globTool.description ?? '').not.toContain('modification time');
    expect(globTool.description ?? '').toContain('sorted by name');
  });
});
