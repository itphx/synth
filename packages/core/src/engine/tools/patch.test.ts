import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, chmod, lstat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext } from '@itphx/synth-shared';
import { patchTool, MAX_PATCH_EDITS } from './patch.js';
import { executeToolDef } from './tool-execution.js';
import { writeFileTool } from './fs-write.js';
import { fileLockRegistrySize } from './file-lock.js';
import { ALL_BUILTIN_TOOLS, createToolRegistry } from './index.js';
import { PermissionEvaluator, extractPaths } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';

const CWD = '/workspace/project';

function evalCheck(
  rules: Record<string, unknown>,
  toolName: string,
  params: Record<string, unknown>,
  capabilities?: readonly string[],
) {
  return new PermissionEvaluator({ rules, askTimeoutMs: 30_000 } as never).check({
    toolName,
    params,
    workingDir: CWD,
    capabilities,
  });
}

describe('patch — атомарная мультифайловая правка', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-patch-'));
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

  it('две правки в двух файлах — оба изменены, сводка верна', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await writeFile(join(tmpDir, 'b.ts'), 'const b = 2;\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 10;' },
        { file_path: 'b.ts', old_string: 'const b = 2;', new_string: 'const b = 20;' },
      ],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Patch applied: 2 files, 2 replacements');
    expect(result.content).toContain('a.ts: 1 replacements');
    expect(result.content).toContain('b.ts: 1 replacements');
    await expect(readFile(join(tmpDir, 'a.ts'), 'utf-8')).resolves.toBe('const a = 10;\n');
    await expect(readFile(join(tmpDir, 'b.ts'), 'utf-8')).resolves.toBe('const b = 20;\n');

    const meta = result.metadata as { files: Array<{ path: string; replacements: number; diff?: string }>; totalReplacements: number };
    expect(meta.totalReplacements).toBe(2);
    expect(meta.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(meta.files.every((f) => f.replacements === 1)).toBe(true);
    expect(meta.files[0]!.diff).toContain('--- a/a.ts');
    expect(meta.files[0]!.diff).toContain('+const a = 10;');
  });

  it('несколько правок в одном файле применяются последовательно', async () => {
    await writeFile(join(tmpDir, 'x.txt'), 'first\nsecond\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        // Первая правка создаёт текст, который ищет вторая, — доказательство
        // последовательного применения в памяти.
        { file_path: 'x.txt', old_string: 'first', new_string: 'middle' },
        { file_path: 'x.txt', old_string: 'middle', new_string: 'last' },
      ],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'x.txt'), 'utf-8')).resolves.toBe('last\nsecond\n');
    const meta = result.metadata as { files: Array<{ path: string; replacements: number }>; totalReplacements: number };
    expect(meta.files).toHaveLength(1);
    expect(meta.files[0]!.replacements).toBe(2);
    expect(meta.totalReplacements).toBe(2);
  });

  it('ошибка во втором файле (old_string не найден) — первый файл не изменён', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');
    await writeFile(join(tmpDir, 'b.txt'), 'beta\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' },
        { file_path: 'b.txt', old_string: 'nope', new_string: 'NOPE' },
      ],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('patch edit #2');
    expect(result.content).toContain('b.txt');
    await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('alpha\n');
    await expect(readFile(join(tmpDir, 'b.txt'), 'utf-8')).resolves.toBe('beta\n');
  });

  it('неоднозначный old_string без replace_all — ошибка с количеством; с replace_all — все заменены', async () => {
    await writeFile(join(tmpDir, 'dup.txt'), 'foo foo foo\n', 'utf-8');

    const ambiguous = await patchTool.execute({
      edits: [{ file_path: 'dup.txt', old_string: 'foo', new_string: 'bar' }],
    }, makeCtx());

    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain('3 times');
    await expect(readFile(join(tmpDir, 'dup.txt'), 'utf-8')).resolves.toBe('foo foo foo\n');

    const all = await patchTool.execute({
      edits: [{ file_path: 'dup.txt', old_string: 'foo', new_string: 'bar', replace_all: true }],
    }, makeCtx());

    expect(all.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'dup.txt'), 'utf-8')).resolves.toBe('bar bar bar\n');
    const meta = all.metadata as { totalReplacements: number };
    expect(meta.totalReplacements).toBe(3);
  });

  it('путь вне периметра — отказ, файл не изменён', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-patch-out-'));
    try {
      const target = join(outside, 'out.txt');
      await writeFile(target, 'outside\n', 'utf-8');

      const result = await patchTool.execute({
        edits: [{ file_path: target, old_string: 'outside', new_string: 'changed' }],
      }, makeCtx());

      expect(result.isError).toBe(true);
      await expect(readFile(target, 'utf-8')).resolves.toBe('outside\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('symlink-escape — отказ, файл вне периметра не изменён', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-patch-link-'));
    try {
      const target = join(outside, 'secret.txt');
      await writeFile(target, 'secret\n', 'utf-8');
      await symlink(target, join(tmpDir, 'link.txt'));

      const result = await patchTool.execute({
        edits: [{ file_path: 'link.txt', old_string: 'secret', new_string: 'leaked' }],
      }, makeCtx());

      expect(result.isError).toBe(true);
      await expect(readFile(target, 'utf-8')).resolves.toBe('secret\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('бинарный файл — понятная ошибка, файл не изменён', async () => {
    const path = join(tmpDir, 'bin.dat');
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await writeFile(path, bytes);

    const result = await patchTool.execute({
      edits: [{ file_path: 'bin.dat', old_string: 'a', new_string: 'b' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain('binary');
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it('CRLF-файл — old_string в LF-виде (как из read_file) — правка применяется, \\r\\n сохранены', async () => {
    await writeFile(join(tmpDir, 'crlf.txt'), 'line1\r\nline2\r\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ file_path: 'crlf.txt', old_string: 'line1\nline2', new_string: 'X\nY' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'crlf.txt'), 'utf-8')).resolves.toBe('X\r\nY\r\n');
  });

  it('CRLF-файл — replace_all сохраняет все \\r\\n', async () => {
    await writeFile(join(tmpDir, 'crlf-all.txt'), 'a\r\nb\r\na\r\nb\r\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ file_path: 'crlf-all.txt', old_string: 'a\nb', new_string: 'c\nd', replace_all: true }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    const after = await readFile(join(tmpDir, 'crlf-all.txt'), 'utf-8');
    expect(after).toBe('c\r\nd\r\nc\r\nd\r\n');
    expect(after.split('\r\n').length - 1).toBe(4);
  });

  it('old_string == new_string — отказ, файл не изменён', async () => {
    await writeFile(join(tmpDir, 'same.txt'), 'alpha\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ file_path: 'same.txt', old_string: 'alpha', new_string: 'alpha' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No changes to apply');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.no_changes');
    await expect(readFile(join(tmpDir, 'same.txt'), 'utf-8')).resolves.toBe('alpha\n');
  });

  it('CRLF-файл — old с \\r\\n и new с \\n — отказ (правка без изменений), файл не изменён', async () => {
    await writeFile(join(tmpDir, 'crlf-noop.txt'), 'line1\r\nline2\r\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ file_path: 'crlf-noop.txt', old_string: 'line1\r\nline2', new_string: 'line1\nline2' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.no_changes');
    await expect(readFile(join(tmpDir, 'crlf-noop.txt'), 'utf-8')).resolves.toBe('line1\r\nline2\r\n');
  });

  it('смешанные переводы строк — отказ, файл не изменён', async () => {
    await writeFile(join(tmpDir, 'mixed.txt'), 'a\r\nb\nc\r\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ file_path: 'mixed.txt', old_string: 'b', new_string: 'B' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('mixed line endings');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.mixed_line_endings');
    await expect(readFile(join(tmpDir, 'mixed.txt'), 'utf-8')).resolves.toBe('a\r\nb\nc\r\n');
  });

  it('смешанные переводы строк во втором файле — отказ всего патча, первый файл не изменён', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');
    await writeFile(join(tmpDir, 'mixed.txt'), 'a\r\nb\nc\r\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' },
        { file_path: 'mixed.txt', old_string: 'b', new_string: 'B' },
      ],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.mixed_line_endings');
    await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('alpha\n');
    await expect(readFile(join(tmpDir, 'mixed.txt'), 'utf-8')).resolves.toBe('a\r\nb\nc\r\n');
  });

  it('права файла сохраняются после патча', async () => {
    const file = join(tmpDir, 'keep.sh');
    await writeFile(file, 'echo hi\n', 'utf-8');
    await chmod(file, 0o640);

    const result = await patchTool.execute({
      edits: [{ file_path: 'keep.sh', old_string: 'echo hi', new_string: 'echo hello' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await expect(readFile(file, 'utf-8')).resolves.toBe('echo hello\n');
  });

  it('симлинк не превращается в обычный файл (пишем в цель)', async () => {
    const target = join(tmpDir, 'target.txt');
    const link = join(tmpDir, 'link.txt');
    await writeFile(target, 'hello\n', 'utf-8');
    await symlink(target, link);

    const result = await patchTool.execute({
      edits: [{ file_path: 'link.txt', old_string: 'hello', new_string: 'bye' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, 'utf-8')).resolves.toBe('bye\n');
  });

  it('несуществующий файл и каталог — отказ до записи', async () => {
    const missing = await patchTool.execute({
      edits: [{ file_path: 'missing.txt', old_string: 'a', new_string: 'b' }],
    }, makeCtx());
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('not found');

    const dir = await patchTool.execute({
      edits: [{ file_path: '.', old_string: 'a', new_string: 'b' }],
    }, makeCtx());
    expect(dir.isError).toBe(true);
    expect(dir.content).toContain('not a regular file');
  });

  it('пустой/слишком большой список правок — ошибка аргументов', async () => {
    const empty = await patchTool.execute({ edits: [] }, makeCtx());
    expect(empty.isError).toBe(true);

    const tooMany = await patchTool.execute({
      edits: Array.from({ length: MAX_PATCH_EDITS + 1 }, () => ({
        file_path: 'a.txt',
        old_string: 'a',
        new_string: 'b',
      })),
    }, makeCtx());
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toContain('edits');
  });

  it('ровно 50 правок — допустимый предел', async () => {
    const result = await patchTool.execute({
      edits: Array.from({ length: MAX_PATCH_EDITS }, () => ({
        op: 'add' as const,
        file_path: `f-${Math.random().toString(36).slice(2)}.txt`,
        content: 'x',
      })),
    }, makeCtx());
    expect(result.isError).toBeFalsy();
  });

  it('зарегистрирован в ALL_BUILTIN_TOOLS и createToolRegistry', () => {
    const tool = ALL_BUILTIN_TOOLS.find((t) => t.name === 'patch');
    expect(tool, 'patch не зарегистрирован в ALL_BUILTIN_TOOLS').toBeDefined();
    expect(tool!.capabilities).toContain(ToolCapability.FILE_WRITE);
    expect(tool!.description).toMatch(/atomic/i);
    expect(tool!.description).toMatch(/all-or-nothing/i);
    expect(tool!.description).not.toMatch(/unified diff/i);

    expect(createToolRegistry().get('patch')).toBeDefined();
  });
});

describe('patch — permission-слой', () => {
  it('группа write (edit) и plan-режим блокируют тул', () => {
    expect(getToolGroups('patch', [ToolCapability.FILE_WRITE])).toContain('edit');

    const decision = evalCheck(
      { '*': 'allow' },
      'patch',
      { edits: [{ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }] },
      [ToolCapability.FILE_WRITE],
    );
    expect(decision.action).toBe('allow');

    const plan = new PermissionEvaluator({ rules: { '*': 'allow' }, askTimeoutMs: 30_000 } as never).check({
      toolName: 'patch',
      params: { edits: [{ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }] },
      workingDir: CWD,
      capabilities: [ToolCapability.FILE_WRITE],
      sessionMode: 'plan',
    });
    expect(plan.action).toBe('deny');
    expect(plan.matchedRule).toBe('plan.deny');
  });

  it('extractPaths собирает вложенные edits[].file_path', () => {
    expect(extractPaths('patch', {
      edits: [
        { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
        { file_path: 'sub/b.ts', old_string: 'c', new_string: 'd' },
        { old_string: 'no-path', new_string: 'x' },
      ],
    }, CWD)).toEqual([join(CWD, 'a.ts'), join(CWD, 'sub/b.ts')]);
  });

  it('extractPaths собирает from/to у rename', () => {
    expect(extractPaths('patch', {
      edits: [
        { op: 'rename', from: 'a.ts', to: 'sub/b.ts' },
        { op: 'delete', file_path: 'c.ts' },
        { op: 'add', file_path: 'd.ts', content: 'x' },
      ],
    }, CWD)).toEqual([join(CWD, 'a.ts'), join(CWD, 'sub/b.ts'), join(CWD, 'c.ts'), join(CWD, 'd.ts')]);
  });

  it('внешний путь у rename уходит в external_directory (ask по умолчанию)', () => {
    const decision = evalCheck(
      {},
      'patch',
      { edits: [{ op: 'rename', from: 'a.ts', to: '../outside.txt' }] },
      [ToolCapability.FILE_WRITE],
    );
    expect(decision.action).toBe('ask');
    expect(decision.matchedRule).toBe('external_directory.default');
  });

  it('file-паттерн правила edit применяется к путям из edits[]', () => {
    const decision = evalCheck(
      { edit: { 'src/*.ts': 'deny' } },
      'patch',
      {
        edits: [
          { file_path: 'README.md', old_string: 'a', new_string: 'b' },
          { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        ],
      },
      [ToolCapability.FILE_WRITE],
    );
    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('edit.src/*.ts');
  });

  it('внешний путь из edits[] уходит в external_directory (ask по умолчанию)', () => {
    const decision = evalCheck(
      {},
      'patch',
      { edits: [{ file_path: '../outside.txt', old_string: 'a', new_string: 'b' }] },
      [ToolCapability.FILE_WRITE],
    );
    expect(decision.action).toBe('ask');
    expect(decision.matchedRule).toBe('external_directory.default');
  });

  it('protected_paths проверяются по путям из edits[]', () => {
    const decision = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 } as never).check({
      toolName: 'patch',
      params: { edits: [{ file_path: '/etc/passwd', old_string: 'a', new_string: 'b' }] },
      workingDir: CWD,
      capabilities: [ToolCapability.FILE_WRITE],
      protectedPaths: {
        deniedPaths: ['/etc/passwd'],
        deniedPrefixes: [],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      },
      protectedPathsEnabled: true,
    });
    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('protected-paths.deny');
  });
});

/**
 * Сериализация мультифайловой правки: патч и параллельная запись одного из
 * его файлов не дедлочатся и не портят содержимое.
 */
describe('patch — сериализация правок по пути', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-patch-lock-'));
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

  it('patch двух файлов + параллельный write одного из них — без дедлока и порчи', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf-8');
    await writeFile(join(tmpDir, 'b.ts'), 'const b = 2;\n', 'utf-8');

    const [patched, written] = await Promise.all([
      patchTool.execute({
        edits: [
          { file_path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 10;' },
          { file_path: 'b.ts', old_string: 'const b = 2;', new_string: 'const b = 20;' },
        ],
      }, makeCtx({ messageId: 'm1' })),
      writeFileTool.execute(
        { file_path: 'a.ts', content: 'const a = 1;\nconst b = 3;\n' },
        makeCtx({ messageId: 'm2' }),
      ),
    ]);

    // Патч завершился (не завис на локе) и не упал.
    expect(patched.isError).toBeFalsy();
    expect(written.isError).toBeFalsy();

    // b.ts патча не касалась параллельная запись — правка на месте.
    await expect(readFile(join(tmpDir, 'b.ts'), 'utf-8')).resolves.toBe('const b = 20;\n');

    // a.ts — целая версия (патч до записи, запись до патча или патч после
    // записи): смеси двух правок в одном файле быть не может.
    const aContent = await readFile(join(tmpDir, 'a.ts'), 'utf-8');
    expect([
      'const a = 10;\nconst b = 2;\n', // патч записался первым
      'const a = 10;\nconst b = 3;\n', // патч применился поверх записи
      'const a = 1;\nconst b = 3;\n',  // запись перекрыла патч
    ]).toContain(aContent);

    // Реестр локов не остался с записями.
    expect(fileLockRegistrySize()).toBe(0);
  });
});

/**
 * Операции патча `add`/`delete`/`rename` (по образцу opencode) — всё-или-ничего
 * сохраняется: сначала валидация всех правок, потом применение.
 */
describe('patch — операции add/delete/rename', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-patch-ops-'));
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

  /** Файл существует? */
  async function exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null;
  }

  it('add — файл создан, каталоги созданы', async () => {
    const result = await patchTool.execute({
      edits: [{ op: 'add', file_path: 'sub/dir/new.txt', content: 'hello\n' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'sub/dir/new.txt'), 'utf-8')).resolves.toBe('hello\n');
    expect(result.content).toContain('sub/dir/new.txt: created');
    expect(result.content).toContain('Operations: 1 added, 0 updated, 0 deleted, 0 renamed');

    const meta = result.metadata as { files: Array<Record<string, unknown>>; summary: { added: number } };
    expect(meta.summary.added).toBe(1);
    expect(meta.files).toEqual([{ path: 'sub/dir/new.txt', op: 'add' }]);
  });

  it('add — файл уже существует — отказ, содержимое не изменено', async () => {
    await writeFile(join(tmpDir, 'exists.txt'), 'original\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ op: 'add', file_path: 'exists.txt', content: 'new\n' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_add_exists');
    await expect(readFile(join(tmpDir, 'exists.txt'), 'utf-8')).resolves.toBe('original\n');
  });

  it('delete — файл удалён', async () => {
    await writeFile(join(tmpDir, 'gone.txt'), 'bye\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ op: 'delete', file_path: 'gone.txt' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(await exists(join(tmpDir, 'gone.txt'))).toBe(false);
    expect(result.content).toContain('gone.txt: deleted');
    expect(result.content).toContain('Operations: 0 added, 0 updated, 1 deleted, 0 renamed');

    const meta = result.metadata as { files: Array<Record<string, unknown>> };
    expect(meta.files).toEqual([{ path: 'gone.txt', op: 'delete' }]);
  });

  it('delete — файла нет — отказ', async () => {
    const result = await patchTool.execute({
      edits: [{ op: 'delete', file_path: 'missing.txt' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_delete_missing');
  });

  it('rename — файл перемещён, содержимое сохранено, источник удалён', async () => {
    await writeFile(join(tmpDir, 'old-name.txt'), 'move me\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ op: 'rename', from: 'old-name.txt', to: 'sub/new-name.txt' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'sub/new-name.txt'), 'utf-8')).resolves.toBe('move me\n');
    expect(await exists(join(tmpDir, 'old-name.txt'))).toBe(false);
    expect(result.content).toContain('old-name.txt: renamed to sub/new-name.txt');
    expect(result.content).toContain('Operations: 0 added, 0 updated, 0 deleted, 1 renamed');

    const meta = result.metadata as { files: Array<Record<string, unknown>> };
    expect(meta.files).toEqual([
      { path: 'sub/new-name.txt', op: 'rename', from: 'old-name.txt', to: 'sub/new-name.txt' },
    ]);
  });

  it('rename — цель уже существует — отказ, оба файла на месте', async () => {
    await writeFile(join(tmpDir, 'src.txt'), 'src\n', 'utf-8');
    await writeFile(join(tmpDir, 'dst.txt'), 'dst\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ op: 'rename', from: 'src.txt', to: 'dst.txt' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_rename_exists');
    await expect(readFile(join(tmpDir, 'src.txt'), 'utf-8')).resolves.toBe('src\n');
    await expect(readFile(join(tmpDir, 'dst.txt'), 'utf-8')).resolves.toBe('dst\n');
  });

  it('rename — источника нет — отказ', async () => {
    const result = await patchTool.execute({
      edits: [{ op: 'rename', from: 'missing.txt', to: 'new.txt' }],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_rename_missing');
    expect(await exists(join(tmpDir, 'new.txt'))).toBe(false);
  });

  it('rename — цель вне периметра — отказ (containment)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-patch-out-'));
    try {
      await writeFile(join(tmpDir, 'src.txt'), 'src\n', 'utf-8');

      const absolute = await patchTool.execute({
        edits: [{ op: 'rename', from: 'src.txt', to: join(outside, 'escaped.txt') }],
      }, makeCtx());
      expect(absolute.isError).toBe(true);
      expect((absolute.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_path_escapes');

      const relative = await patchTool.execute({
        edits: [{ op: 'rename', from: 'src.txt', to: '../escaped.txt' }],
      }, makeCtx());
      expect(relative.isError).toBe(true);
      expect((relative.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_path_escapes');

      // Источник не тронут, цель не появилась.
      await expect(readFile(join(tmpDir, 'src.txt'), 'utf-8')).resolves.toBe('src\n');
      expect(await exists(join(outside, 'escaped.txt'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('смешанный вызов add+update+delete+rename — всё применено', async () => {
    await writeFile(join(tmpDir, 'edit.txt'), 'alpha\n', 'utf-8');
    await writeFile(join(tmpDir, 'gone.txt'), 'bye\n', 'utf-8');
    await writeFile(join(tmpDir, 'old-name.txt'), 'move me\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        { op: 'add', file_path: 'new.txt', content: 'fresh\n' },
        { op: 'update', file_path: 'edit.txt', old_string: 'alpha', new_string: 'ALPHA' },
        { op: 'delete', file_path: 'gone.txt' },
        { op: 'rename', from: 'old-name.txt', to: 'new-name.txt' },
      ],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'new.txt'), 'utf-8')).resolves.toBe('fresh\n');
    await expect(readFile(join(tmpDir, 'edit.txt'), 'utf-8')).resolves.toBe('ALPHA\n');
    expect(await exists(join(tmpDir, 'gone.txt'))).toBe(false);
    await expect(readFile(join(tmpDir, 'new-name.txt'), 'utf-8')).resolves.toBe('move me\n');
    expect(await exists(join(tmpDir, 'old-name.txt'))).toBe(false);

    expect(result.content).toContain('Operations: 1 added, 1 updated, 1 deleted, 1 renamed');

    const meta = result.metadata as {
      files: Array<Record<string, unknown>>;
      summary: { added: number; updated: number; deleted: number; renamed: number };
      totalReplacements: number;
    };
    expect(meta.summary).toEqual({ added: 1, updated: 1, deleted: 1, renamed: 1 });
    expect(meta.totalReplacements).toBe(1);
    expect(meta.files.map((f) => f.op ?? 'update')).toEqual(['add', 'update', 'delete', 'rename']);
  });

  it('ошибка во второй правке — ничего не изменено (созданный файл отсутствует)', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        { op: 'add', file_path: 'created.txt', content: 'x\n' },
        { op: 'update', file_path: 'missing.txt', old_string: 'a', new_string: 'b' },
      ],
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect(await exists(join(tmpDir, 'created.txt'))).toBe(false);
    await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('alpha\n');
  });

  it('сбой записи — откат: созданный файл удалён, изменённый восстановлен', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');
    // Каталог без прав на запись — запись в него падает (EACCES).
    const roDir = join(tmpDir, 'ro');
    await mkdir(roDir, { recursive: true });
    await chmod(roDir, 0o555);
    try {
      const result = await patchTool.execute({
        edits: [
          { op: 'update', file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' },
          { op: 'add', file_path: 'created.txt', content: 'x\n' },
          { op: 'add', file_path: 'ro/nested.txt', content: 'y\n' },
        ],
      }, makeCtx());

      expect(result.isError).toBe(true);
      expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.patch_write_failed');
      // Откат: созданный файл убран, изменённый — возвращён к оригиналу.
      expect(await exists(join(tmpDir, 'created.txt'))).toBe(false);
      await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('alpha\n');
    } finally {
      await chmod(roDir, 0o755).catch(() => undefined);
    }
  });

  it('старый формат (без op) работает как раньше — и в общем вызове', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [
        { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' },
        { op: 'add', file_path: 'b.txt', content: 'b\n' },
      ],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('ALPHA\n');
    await expect(readFile(join(tmpDir, 'b.txt'), 'utf-8')).resolves.toBe('b\n');

    const meta = result.metadata as { files: Array<Record<string, unknown>>; totalReplacements: number };
    expect(meta.totalReplacements).toBe(1);
    expect(meta.files[0]).toMatchObject({ path: 'a.txt', replacements: 1 });
  });

  it('явный op:update — то же, что и вызов без op', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');

    const result = await patchTool.execute({
      edits: [{ op: 'update', file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' }],
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('ALPHA\n');
  });

  it('неизвестный op — ошибка аргументов', async () => {
    const result = await patchTool.execute({
      edits: [{ op: 'move', file_path: 'a.txt' }],
    }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('центральный исполнитель (executeToolDef) принимает старый формат и новые op', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n', 'utf-8');

    // Старый формат (без op) — схема тула его принимает (executeToolDef
    // разбирает аргументы до вызова execute).
    const legacy = await executeToolDef(
      patchTool,
      { edits: [{ file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' }] },
      makeCtx(),
      'patch',
    );
    expect(legacy.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('ALPHA\n');

    // Явные операции — тоже.
    const ops = await executeToolDef(
      patchTool,
      { edits: [{ op: 'add', file_path: 'b.txt', content: 'b\n' }, { op: 'delete', file_path: 'a.txt' }] },
      makeCtx(),
      'patch',
    );
    expect(ops.isError).toBeFalsy();
    await expect(readFile(join(tmpDir, 'b.txt'), 'utf-8')).resolves.toBe('b\n');
    expect(await exists(join(tmpDir, 'a.txt'))).toBe(false);
  });
});
