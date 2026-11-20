import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';

import { buildPermissionPreview } from './preview.js';
import { editFileTool } from '../tools/fs-write.js';
import { patchTool } from '../tools/patch.js';

/**
 * Долларовые шаблоны **строки замены** `String.prototype.replace`: совпадение,
 * часть файла до совпадения (доллар + обратная кавычка — именно он давал
 * дубликат файла и в превью, и в самой правке), часть после, группы,
 * литеральный доллар. Собираются из частей, чтобы сам файл теста их не
 * содержал в готовом виде.
 */
const DOLLAR = '$';
const TICK = String.fromCharCode(96);
const PREFIX_TEMPLATE = `left ${DOLLAR}${TICK} right`;

describe('buildPermissionPreview — превью изменений в запросе подтверждения', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-preview-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write_file: новый файл — diff от /dev/null, deletions = 0', async () => {
    const preview = await buildPermissionPreview({
      toolName: 'write_file',
      args: { file_path: 'new.txt', content: 'привет\nмир\n' },
      workingDir: dir,
    });

    expect(preview).toBeDefined();
    expect(preview!.files).toHaveLength(1);
    const file = preview!.files[0]!;
    expect(file.path).toBe('new.txt');
    expect(file.diff).toContain('--- /dev/null');
    expect(file.diff).toContain('+++ b/new.txt');
    expect(file.additions).toBeGreaterThan(0);
    expect(file.deletions).toBe(0);
  });

  it('write_file: существующий файл — видно замену строки', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n', 'utf-8');

    const preview = await buildPermissionPreview({
      toolName: 'write_file',
      args: { file_path: 'a.txt', content: 'one\nTWO\nthree\n' },
      workingDir: dir,
    });

    expect(preview).toBeDefined();
    const file = preview!.files[0]!;
    expect(file.diff).toContain('-two');
    expect(file.diff).toContain('+TWO');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it('write_file: содержимое не изменилось — превью нет', async () => {
    await writeFile(join(dir, 'a.txt'), 'same\n', 'utf-8');
    const preview = await buildPermissionPreview({
      toolName: 'write_file',
      args: { file_path: 'a.txt', content: 'same\n' },
      workingDir: dir,
    });
    expect(preview).toBeUndefined();
  });

  it('edit_file: замена применяется в памяти, файл не меняется', async () => {
    const target = join(dir, 'b.txt');
    await writeFile(target, 'alpha\nbeta\ngamma\n', 'utf-8');

    const preview = await buildPermissionPreview({
      toolName: 'edit_file',
      args: { file_path: 'b.txt', old_string: 'beta', new_string: 'BETA' },
      workingDir: dir,
    });

    expect(preview).toBeDefined();
    const file = preview!.files[0]!;
    expect(file.path).toBe('b.txt');
    expect(file.diff).toContain('-beta');
    expect(file.diff).toContain('+BETA');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);

    // Файл на диске не тронут.
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(target, 'utf-8')).resolves.toBe('alpha\nbeta\ngamma\n');
  });

  it('edit_file: неоднозначная правка — превью нет', async () => {
    await writeFile(join(dir, 'c.txt'), 'x\nx\n', 'utf-8');
    const preview = await buildPermissionPreview({
      toolName: 'edit_file',
      args: { file_path: 'c.txt', old_string: 'x', new_string: 'y' },
      workingDir: dir,
    });
    expect(preview).toBeUndefined();
  });

  it('edit_file: отсутствующий файл — превью нет', async () => {
    const preview = await buildPermissionPreview({
      toolName: 'edit_file',
      args: { file_path: 'missing.txt', old_string: 'a', new_string: 'b' },
      workingDir: dir,
    });
    expect(preview).toBeUndefined();
  });

  it('patch: дифф по каждому файлу', async () => {
    await writeFile(join(dir, 'one.txt'), '1\n2\n', 'utf-8');
    await writeFile(join(dir, 'two.txt'), 'a\nb\n', 'utf-8');

    const preview = await buildPermissionPreview({
      toolName: 'patch',
      args: {
        edits: [
          { file_path: 'one.txt', old_string: '2', new_string: 'TWO' },
          { file_path: 'two.txt', old_string: 'b', new_string: 'B' },
        ],
      },
      workingDir: dir,
    });

    expect(preview).toBeDefined();
    expect(preview!.files.map((f) => f.path)).toEqual(['one.txt', 'two.txt']);
    expect(preview!.files[0]!.diff).toContain('+TWO');
    expect(preview!.files[1]!.diff).toContain('+B');
  });

  it('patch: патч «всё-или-ничего» — сбой одной правки убирает превью целиком', async () => {
    await writeFile(join(dir, 'one.txt'), '1\n', 'utf-8');

    const preview = await buildPermissionPreview({
      toolName: 'patch',
      args: {
        edits: [
          { file_path: 'one.txt', old_string: '1', new_string: 'ONE' },
          { file_path: 'missing.txt', old_string: 'x', new_string: 'y' },
        ],
      },
      workingDir: dir,
    });

    expect(preview).toBeUndefined();
  });

  it('бинарный файл — превью нет (запрос подтверждения не ломается)', async () => {
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));

    const preview = await buildPermissionPreview({
      toolName: 'write_file',
      args: { file_path: 'bin.dat', content: 'текст' },
      workingDir: dir,
    });

    expect(preview).toBeUndefined();
  });

  it('тул без превью — ничего не считаем', async () => {
    const preview = await buildPermissionPreview({
      toolName: 'execute_shell',
      args: { command: 'ls' },
      workingDir: dir,
    });
    expect(preview).toBeUndefined();
  });

  it('секреты из карты обфускации маскируются в диффе', async () => {
    await writeFile(join(dir, 'secret.txt'), 'token=OLD\n', 'utf-8');

    const preview = await buildPermissionPreview({
      toolName: 'write_file',
      args: { file_path: 'secret.txt', content: 'token=NEW\n' },
      workingDir: dir,
      secretsMap: { '⟦SYNTH_SECRET_1⟧': 'OLD' },
    });

    expect(preview).toBeDefined();
    const diff = preview!.files[0]!.diff;
    expect(diff).not.toContain('OLD');
    expect(diff).toContain('⟦SYNTH_SECRET_1⟧');
  });

  it('вложенный каталог: путь относительно рабочего каталога', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'deep.txt'), 'old\n', 'utf-8');

    const preview = await buildPermissionPreview({
      toolName: 'write_file',
      args: { file_path: 'sub/deep.txt', content: 'new\n' },
      workingDir: dir,
    });

    expect(preview).toBeDefined();
    expect(preview!.files[0]!.path).toBe('sub/deep.txt');
    expect(preview!.files[0]!.diff).toContain('-old');
    expect(preview!.files[0]!.diff).toContain('+new');
  });

  /** Строки, которые дифф обещает добавить (без заголовка `+++`). */
  function addedLines(diff: string): string[] {
    return diff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));
  }

  function makeCtx(): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: dir };
  }

  it('edit_file: долларовые шаблоны в new_string — превью совпадает с реальной правкой', async () => {
    const target = join(dir, 'pfx.txt');
    await writeFile(target, 'alpha\nbeta\ngamma\n', 'utf-8');
    const args = { file_path: 'pfx.txt', old_string: 'beta', new_string: PREFIX_TEMPLATE };

    const preview = await buildPermissionPreview({ toolName: 'edit_file', args, workingDir: dir });

    expect(preview).toBeDefined();
    const file = preview!.files[0]!;
    // Одна строка добавлена, одна удалена: дубликата префикса файла нет.
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);

    // Реальная правка теми же аргументами — ровно тот же результат.
    const result = await editFileTool.execute(args, makeCtx());
    expect(result.isError).toBeFalsy();
    const actual = await readFile(target, 'utf-8');
    expect(actual).toBe(`alpha\n${PREFIX_TEMPLATE}\ngamma\n`);
    // Превью и правка не расходятся: добавленная строка диффа — та же строка файла.
    expect(addedLines(file.diff)).toEqual([PREFIX_TEMPLATE]);
  });

  it('edit_file (replace_all): долларовые шаблоны — превью совпадает с реальной правкой', async () => {
    const target = join(dir, 'pfx-all.txt');
    await writeFile(target, 'x\nx\nx\n', 'utf-8');
    const args = { file_path: 'pfx-all.txt', old_string: 'x', new_string: PREFIX_TEMPLATE, replace_all: true };

    const preview = await buildPermissionPreview({ toolName: 'edit_file', args, workingDir: dir });

    expect(preview).toBeDefined();
    const file = preview!.files[0]!;
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(3);

    const result = await editFileTool.execute(args, makeCtx());
    expect(result.isError).toBeFalsy();
    await expect(readFile(target, 'utf-8')).resolves.toBe(
      `${PREFIX_TEMPLATE}\n${PREFIX_TEMPLATE}\n${PREFIX_TEMPLATE}\n`,
    );
    expect(addedLines(file.diff)).toEqual([PREFIX_TEMPLATE, PREFIX_TEMPLATE, PREFIX_TEMPLATE]);
  });

  it('patch: долларовые шаблоны в new_string — превью совпадает с реальной правкой', async () => {
    const target = join(dir, 'pfx-patch.txt');
    await writeFile(target, 'one\ntwo\nthree\n', 'utf-8');
    const args = {
      edits: [{ op: 'update', file_path: 'pfx-patch.txt', old_string: 'two', new_string: PREFIX_TEMPLATE }],
    };

    const preview = await buildPermissionPreview({ toolName: 'patch', args, workingDir: dir });

    expect(preview).toBeDefined();
    const file = preview!.files[0]!;
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);

    const result = await patchTool.execute(args, makeCtx());
    expect(result.isError).toBeFalsy();
    await expect(readFile(target, 'utf-8')).resolves.toBe(`one\n${PREFIX_TEMPLATE}\nthree\n`);
    expect(addedLines(file.diff)).toEqual([PREFIX_TEMPLATE]);
  });
});
