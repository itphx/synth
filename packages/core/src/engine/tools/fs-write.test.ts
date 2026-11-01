import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, stat, chmod, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileTool, createDirectoryTool, deleteFileTool, editFileTool } from './fs-write.js';
import { fileLockRegistrySize } from './file-lock.js';
import { MAX_TOOL_FILE_BYTES } from './file-limits.js';
import type { ToolContext } from '@itphx/synth-shared';

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

/**
 * Надёжность файловых правок: отказы до записи, согласованность переводов
 * строк, бинарь/размер, атомарная запись и сохранение прав файла.
 */
describe('fs-write tools — надёжность правок', () => {
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

  /** Бинарный файл: NUL-байты — верный признак для `sniffBinary`. */
  const BINARY_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x04, 0x05]);

  it('edit_file: одинаковые old_string и new_string — отказ, файл не меняется', async () => {
    const file = join(tmpDir, 'same.txt');
    await writeFile(file, 'hello\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'same.txt', old_string: 'hello', new_string: 'hello' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No changes to apply');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.no_changes');
    await expect(readFile(file, 'utf-8')).resolves.toBe('hello\n');
  });

  it('edit_file: пустой old_string при replace_all — отказ, файл не портится', async () => {
    const file = join(tmpDir, 'empty.txt');
    await writeFile(file, 'abc', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'empty.txt', old_string: '', new_string: 'X', replace_all: true },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('old_string must not be empty');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.empty_old_string');
    await expect(readFile(file, 'utf-8')).resolves.toBe('abc');
  });

  it('edit_file: пустой old_string без replace_all — тоже отказ', async () => {
    const file = join(tmpDir, 'empty2.txt');
    await writeFile(file, 'abc', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'empty2.txt', old_string: '', new_string: 'X' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    await expect(readFile(file, 'utf-8')).resolves.toBe('abc');
  });

  it('edit_file: CRLF-файл — правка находится (LF-вид) и \r\n сохраняются', async () => {
    const file = join(tmpDir, 'crlf.txt');
    await writeFile(file, 'line1\r\nline2\r\n', 'utf-8');

    // Текст из read_file приходит с LF — ищем именно его.
    const result = await editFileTool.execute(
      { file_path: 'crlf.txt', old_string: 'line1\nline2', new_string: 'X\nY' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const after = await readFile(file, 'utf-8');
    expect(after).toBe('X\r\nY\r\n');
    expect(after.split('\r\n').length - 1).toBe(2);
  });

  it('edit_file: CRLF-файл — old с \\r\\n и new с \\n — отказ (правка без изменений), файл не изменён', async () => {
    const file = join(tmpDir, 'crlf-noop.txt');
    await writeFile(file, 'line1\r\nline2\r\n', 'utf-8');

    // После нормализации CRLF пара превращается в «old == new» — замена
    // ничего не меняет, но гейт по сырым строкам её пропускал.
    const result = await editFileTool.execute(
      { file_path: 'crlf-noop.txt', old_string: 'line1\r\nline2', new_string: 'line1\nline2' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No changes to apply');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.no_changes');
    await expect(readFile(file, 'utf-8')).resolves.toBe('line1\r\nline2\r\n');
  });

  it('edit_file: CRLF-файл — replace_all с парой «old \\r\\n / new \\n» — отказ, файл не изменён', async () => {
    const file = join(tmpDir, 'crlf-noop-all.txt');
    await writeFile(file, 'a\r\nb\r\na\r\nb\r\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'crlf-noop-all.txt', old_string: 'a\r\nb', new_string: 'a\nb', replace_all: true },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.no_changes');
    await expect(readFile(file, 'utf-8')).resolves.toBe('a\r\nb\r\na\r\nb\r\n');
  });

  it('edit_file: файл не существует — понятный отказ, без исключения', async () => {
    const result = await editFileTool.execute(
      { file_path: 'missing.txt', old_string: 'a', new_string: 'b' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('file not found');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.file_not_found');
  });

  it('write_file/edit_file: каталог без прав (0555) и доступный на запись файл — запись успешна', async () => {
    const roDir = join(tmpDir, 'ro');
    await mkdir(roDir, { recursive: true });
    const file = join(roDir, 'keep.txt');
    await writeFile(file, 'old\n', 'utf-8');
    await chmod(file, 0o666);
    await chmod(roDir, 0o555);
    try {
      // Каталог не даёт создать tmp для атомарной записи — тул обязан
      // откатиться на прямую запись в доступный файл (прежнее поведение).
      const written = await writeFileTool.execute(
        { file_path: file, content: 'new\n' },
        makeCtx(),
      );
      expect(written.isError).toBeFalsy();
      await expect(readFile(file, 'utf-8')).resolves.toBe('new\n');
      expect((await stat(file)).mode & 0o777).toBe(0o666);

      const edited = await editFileTool.execute(
        { file_path: file, old_string: 'new', new_string: 'edited' },
        makeCtx(),
      );
      expect(edited.isError).toBeFalsy();
      await expect(readFile(file, 'utf-8')).resolves.toBe('edited\n');
      expect((await stat(file)).mode & 0o777).toBe(0o666);
    } finally {
      await chmod(roDir, 0o755);
    }
  });

  it('edit_file: CRLF-файл — replace_all сохраняет все \r\n', async () => {
    const file = join(tmpDir, 'crlf-all.txt');
    await writeFile(file, 'a\r\nb\r\na\r\nb\r\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'crlf-all.txt', old_string: 'a\nb', new_string: 'c\nd', replace_all: true },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const after = await readFile(file, 'utf-8');
    expect(after).toBe('c\r\nd\r\nc\r\nd\r\n');
    expect(after.includes('\n\n')).toBe(false);
    expect(after.split('\r\n').length - 1).toBe(4);
  });

  it('edit_file: смешанные переводы строк — отказ, файл не изменён', async () => {
    const file = join(tmpDir, 'mixed.txt');
    await writeFile(file, 'a\r\nb\nc\r\n', 'utf-8');
    const before = await readFile(file, 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'mixed.txt', old_string: 'b', new_string: 'B' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('mixed line endings');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.mixed_line_endings');
    await expect(readFile(file, 'utf-8')).resolves.toBe(before);
  });

  it('edit_file: бинарный файл — отказ (файл не читается как текст)', async () => {
    const file = join(tmpDir, 'bin.dat');
    await writeFile(file, BINARY_BYTES);

    const result = await editFileTool.execute(
      { file_path: 'bin.dat', old_string: 'a', new_string: 'b' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Cannot edit binary file');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.edit_binary');
    await expect(readFile(file)).resolves.toEqual(BINARY_BYTES);
  });

  it('write_file: перезапись бинарного файла — отказ', async () => {
    const file = join(tmpDir, 'bin.dat');
    await writeFile(file, BINARY_BYTES);

    const result = await writeFileTool.execute(
      { file_path: 'bin.dat', content: 'text' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Cannot overwrite binary file');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.write_binary');
    await expect(readFile(file)).resolves.toEqual(BINARY_BYTES);
  });

  it('edit_file: файл больше предела — отказ, файл не изменён', async () => {
    const file = join(tmpDir, 'big.txt');
    const content = 'a'.repeat(MAX_TOOL_FILE_BYTES + 1);
    await writeFile(file, content, 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'big.txt', old_string: 'aaa', new_string: 'b' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('too large');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.file_too_large');
    const after = await readFile(file, 'utf-8');
    expect(after.length).toBe(content.length);
  });

  it('write_file: контент больше предела — отказ, файл не создан', async () => {
    const result = await writeFileTool.execute(
      { file_path: 'huge.txt', content: 'a'.repeat(MAX_TOOL_FILE_BYTES + 1) },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('too large');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.file_too_large');
    await expect(access(join(tmpDir, 'huge.txt'))).rejects.toThrow();
  });

  it('edit_file: права файла сохраняются после правки', async () => {
    const file = join(tmpDir, 'script.sh');
    await writeFile(file, 'echo hi\n', 'utf-8');
    await chmod(file, 0o755);

    const result = await editFileTool.execute(
      { file_path: 'script.sh', old_string: 'echo hi', new_string: 'echo hello' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    await expect(readFile(file, 'utf-8')).resolves.toBe('echo hello\n');
  });

  it('write_file: права существующего файла сохраняются при перезаписи', async () => {
    const file = join(tmpDir, 'keep.sh');
    await writeFile(file, 'old\n', 'utf-8');
    await chmod(file, 0o640);

    const result = await writeFileTool.execute(
      { file_path: 'keep.sh', content: 'new\n' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await expect(readFile(file, 'utf-8')).resolves.toBe('new\n');
  });

  it('write_file: временный файл не остаётся в каталоге', async () => {
    const result = await writeFileTool.execute(
      { file_path: 'clean.txt', content: 'data\n' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const { readdir } = await import('node:fs/promises');
    await expect(readdir(tmpDir)).resolves.toEqual(['clean.txt']);
  });

  it('edit_file: симлинк не превращается в обычный файл (пишем в цель)', async () => {
    const target = join(tmpDir, 'target.txt');
    const link = join(tmpDir, 'link.txt');
    await writeFile(target, 'hello\n', 'utf-8');
    await symlink(target, link);

    const result = await editFileTool.execute(
      { file_path: 'link.txt', old_string: 'hello', new_string: 'bye' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, 'utf-8')).resolves.toBe('bye\n');
  });
});

/**
 * «Умное» сопоставление `old_string` (образец opencode): стратегии
 * exact → normalized → loose, применение только при однозначном совпадении.
 */
describe('fs-write tools — «умное» сопоставление old_string', () => {
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

  function strategyOf(result: { metadata?: Record<string, unknown> }): unknown {
    return result.metadata?.matchStrategy;
  }

  it('edit_file: типографские кавычки в файле и прямые в old_string — правка найдена (normalized)', async () => {
    const file = join(tmpDir, 'smart-quotes.txt');
    // В файле — типографские кавычки, модель прислала прямые.
    await writeFile(file, 'const greeting = “Привет”;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'smart-quotes.txt', old_string: 'const greeting = "Привет";', new_string: 'const greeting = "Пока";' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('const greeting = "Пока";\n');
  });

  it('edit_file: «ёлочки» в файле и прямые кавычки в old_string — правка найдена (normalized)', async () => {
    const file = join(tmpDir, 'guillemets.txt');
    await writeFile(file, 'say = «Привет»;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'guillemets.txt', old_string: 'say = "Привет";', new_string: 'say = "Пока";' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('say = "Пока";\n');
  });

  it('edit_file: типографское тире и NBSP — правка найдена (normalized)', async () => {
    const file = join(tmpDir, 'dash-nbsp.txt');
    await writeFile(file, 'const a = 1; — const b = 2;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'dash-nbsp.txt', old_string: 'const a = 1; - const b = 2;', new_string: 'const a = 1; - const b = 3;' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('const a = 1; - const b = 3;\n');
  });

  it('edit_file: замена применяется к оригинальному фрагменту — остальной файл не меняется', async () => {
    const file = join(tmpDir, 'keep-rest.txt');
    // Типографские кавычки в других местах файла должны остаться как есть.
    await writeFile(file, 'a = “one”;\nb = “two”;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'keep-rest.txt', old_string: 'a = "one";', new_string: 'a = 1;' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('a = 1;\nb = “two”;\n');
  });

  it('edit_file: trailing whitespace в строках old_string — правка найдена (loose)', async () => {
    const file = join(tmpDir, 'trailing.txt');
    await writeFile(file, 'function f() {\n  return 1;   \n}\n', 'utf-8');

    const result = await editFileTool.execute(
      {
        file_path: 'trailing.txt',
        old_string: 'function f() {\n  return 1;\n}',
        new_string: 'function f() {\n  return 2;\n}',
      },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('loose');
    await expect(readFile(file, 'utf-8')).resolves.toBe('function f() {\n  return 2;\n}\n');
  });

  it('edit_file: loose — ведущие отступы значимы (другая indentation не подходит)', async () => {
    const file = join(tmpDir, 'indent.txt');
    await writeFile(file, 'if (x) {\n    body();   \n}\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'indent.txt', old_string: 'if (x) {\n  body();\n}', new_string: 'if (x) {\n  body();\n} // done' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.replace_not_found');
    await expect(readFile(file, 'utf-8')).resolves.toBe('if (x) {\n    body();   \n}\n');
  });

  it('edit_file: неоднозначность по нормализации — прежний отказ replace_multiple', async () => {
    const file = join(tmpDir, 'ambiguous.txt');
    await writeFile(file, 'a = “x”;\nb = “x”;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'ambiguous.txt', old_string: '"x";', new_string: '1;' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('found 2 matches');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.replace_multiple');
    expect(strategyOf(result)).toBe('normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('a = “x”;\nb = “x”;\n');
  });

  it('edit_file: неоднозначность по loose — прежний отказ replace_multiple', async () => {
    const file = join(tmpDir, 'ambiguous-loose.txt');
    await writeFile(file, 'foo();   \nbar();\nfoo();   \nbar();\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'ambiguous-loose.txt', old_string: 'foo();\nbar();', new_string: 'baz();\nbar();' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('found 2 matches');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.replace_multiple');
    expect(strategyOf(result)).toBe('loose');
    await expect(readFile(file, 'utf-8')).resolves.toBe('foo();   \nbar();\nfoo();   \nbar();\n');
  });

  it('edit_file: совпадений нет ни в одной стратегии — прежний отказ replace_not_found', async () => {
    const file = join(tmpDir, 'not-found.txt');
    await writeFile(file, 'const a = 1;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'not-found.txt', old_string: 'const b = 2;', new_string: 'const b = 3;' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('replacement string not found');
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.replace_not_found');
    await expect(readFile(file, 'utf-8')).resolves.toBe('const a = 1;\n');
  });

  it('edit_file: exact имеет приоритет над normalized/loose', async () => {
    const file = join(tmpDir, 'priority.txt');
    // Первая строка совпадает точно, вторая — только после нормализации.
    await writeFile(file, 'a = "x";\nb = “x”;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'priority.txt', old_string: 'a = "x";', new_string: 'a = 1;' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('exact');
    // Правлена именно точная строка — вторая осталась как была.
    await expect(readFile(file, 'utf-8')).resolves.toBe('a = 1;\nb = “x”;\n');
  });

  it('edit_file: replace_all — прежнее поведение (только exact, все вхождения)', async () => {
    const file = join(tmpDir, 'replace-all.txt');
    await writeFile(file, 'x = 1;\nx = 1;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'replace-all.txt', old_string: 'x = 1;', new_string: 'x = 2;', replace_all: true },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('exact');
    expect((result.metadata as { replacements?: number }).replacements).toBe(2);
    await expect(readFile(file, 'utf-8')).resolves.toBe('x = 2;\nx = 2;\n');
  });

  it('edit_file: replace_all не расширяется «умными» стратегиями — нет совпадения', async () => {
    const file = join(tmpDir, 'replace-all-smart.txt');
    await writeFile(file, 'a = “x”;\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'replace-all-smart.txt', old_string: 'a = "x";', new_string: 'a = 1;', replace_all: true },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.replace_not_found');
    await expect(readFile(file, 'utf-8')).resolves.toBe('a = “x”;\n');
  });

  it('edit_file: CRLF-файл — нормализованное совпадение, \\r\\n сохраняются', async () => {
    const file = join(tmpDir, 'crlf-smart.txt');
    await writeFile(file, 'a = “x”;\r\nb = 2;\r\n', 'utf-8');

    const result = await editFileTool.execute(
      { file_path: 'crlf-smart.txt', old_string: 'a = "x";', new_string: 'a = 1;' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(strategyOf(result)).toBe('normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('a = 1;\r\nb = 2;\r\n');
  });

  it('edit_file: loose-правка, не меняющая файл, — отказ no_changes', async () => {
    const file = join(tmpDir, 'noop-loose.txt');
    await writeFile(file, 'value;\n', 'utf-8');

    // Текст в файле совпадает с new_string — правка ничего не меняет.
    const result = await editFileTool.execute(
      { file_path: 'noop-loose.txt', old_string: 'value;  ', new_string: 'value;' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect((result.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.no_changes');
    await expect(readFile(file, 'utf-8')).resolves.toBe('value;\n');
  });
});

/**
 * Сериализация правок одного файла: параллельные вызовы не перетирают друг
 * друга (read-modify-write под локом пути).
 */
describe('fs-write tools — сериализация правок по пути', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fslock-'));
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

  it('два параллельных edit_file одного файла — обе правки применены', async () => {
    const file = join(tmpDir, 'concurrent.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf-8');

    const [first, second] = await Promise.all([
      editFileTool.execute(
        { file_path: 'concurrent.txt', old_string: 'alpha', new_string: 'ALPHA' },
        makeCtx({ messageId: 'm1' }),
      ),
      editFileTool.execute(
        { file_path: 'concurrent.txt', old_string: 'gamma', new_string: 'GAMMA' },
        makeCtx({ messageId: 'm2' }),
      ),
    ]);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    // Второй вызов ждал первый и читал уже обновлённый файл: итог содержит
    // обе правки (без лока одна из них терялась — «последний выигравший»).
    await expect(readFile(file, 'utf-8')).resolves.toBe('ALPHA\nbeta\nGAMMA\n');
    // Реестр локов не остался с записями.
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('параллельные write_file и edit_file одного файла — итог целый, без смеси', async () => {
    const file = join(tmpDir, 'mixed.txt');
    await writeFile(file, 'keep\n', 'utf-8');

    const [written, edited] = await Promise.all([
      writeFileTool.execute({ file_path: 'mixed.txt', content: 'written\n' }, makeCtx({ messageId: 'm1' })),
      editFileTool.execute({ file_path: 'mixed.txt', old_string: 'keep', new_string: 'edited' }, makeCtx({ messageId: 'm2' })),
    ]);

    expect(written.isError).toBeFalsy();
    // Правка может не найти свой фрагмент (файл уже перезаписан) — это
    // штатный отказ, а не порча.
    const final = await readFile(file, 'utf-8');
    expect(['written\n', 'edited\n']).toContain(final);
    if (edited.isError) {
      expect((edited.metadata as { i18n?: { key: string } }).i18n?.key).toBe('fs.replace_not_found');
    }
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('write_file: два параллельных вызова одного файла — файл целый', async () => {
    const file = join(tmpDir, 'two-writes.txt');
    await writeFile(file, 'start\n', 'utf-8');

    await Promise.all([
      writeFileTool.execute({ file_path: 'two-writes.txt', content: 'first\n' }, makeCtx({ messageId: 'm1' })),
      writeFileTool.execute({ file_path: 'two-writes.txt', content: 'second\n' }, makeCtx({ messageId: 'm2' })),
    ]);

    const final = await readFile(file, 'utf-8');
    expect(['first\n', 'second\n']).toContain(final);
    expect(fileLockRegistrySize()).toBe(0);
  });
});
