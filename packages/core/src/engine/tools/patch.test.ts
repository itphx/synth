import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, chmod, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext } from '@itphx/synth-shared';
import { patchTool, MAX_PATCH_EDITS } from './patch.js';
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
