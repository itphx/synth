/**
 * Контракт FS-части порта исполнения (PROP-135, Ф1) — прогон против
 * inline-реализации.
 *
 * Файловые операции агента — в том же контуре, что и команды (PROP-135
 * «Контракт порта»): реализации взаимозаменяемы (inline — локальная ФС,
 * remote — HTTP к исполнителю), а домен не различает физических исполнителей.
 * Проверяется **контракт**, а не конкретная ФС:
 *
 *   - `stat`: вид объекта, размер (у каталога — `0`), время изменения;
 *   - `readdir`: записи с размерами, порядок — файловый (сортировка — на
 *     стороне вызывающего);
 *   - `realpath`: канонический путь (симлинк разыменовывается);
 *   - **ошибки — типизированные**: `not_found` / `not_directory` /
 *     `permission` / `invalid` / `unresolvable` — вызывающий различает их
 *     без разбора текста.
 *
 * Эталон контракта на удалённом исполнителе проверяется отдельно
 * (`packages/executor/src/fs-routes.test.ts` — провод) и в core
 * (`execution/fs-contract.test.ts` — этот файл: поведение реализации).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InlineExecutionPort } from './inline-execution-port.js';
import { FsPathError, isFsPathError, type FsErrorCode } from './ports/index.js';

let root: string;
let dir: string;
let file: string;
let link: string;
let brokenLink: string;

const port = new InlineExecutionPort();

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'synth-fs-contract-')));
  dir = join(root, 'sub');
  await mkdir(dir, { recursive: true });
  file = join(root, 'a.txt');
  await writeFile(file, 'hello');
  link = join(root, 'link.txt');
  await symlink(file, link);
  brokenLink = join(root, 'broken.txt');
  await symlink(join(root, 'missing-target.txt'), brokenLink);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Ошибка FS-операции, снятая с промиса. */
async function captureFsError(promise: Promise<unknown>): Promise<FsPathError> {
  try {
    await promise;
  } catch (err) {
    if (!isFsPathError(err)) throw err;
    return err;
  }
  throw new Error('ожидалась ошибка FS-операции');
}

/** Код ошибки FS-операции (машинный — текст не разбираем). */
async function captureCode(promise: Promise<unknown>): Promise<FsErrorCode> {
  return (await captureFsError(promise)).code;
}

describe('ExecutionFs (inline): stat', () => {
  it('файл — вид, размер и время изменения', async () => {
    const stat = await port.fs!.stat(file);
    expect(stat.kind).toBe('file');
    expect(stat.size).toBe(5);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it('каталог — вид "directory", размер 0', async () => {
    const stat = await port.fs!.stat(dir);
    expect(stat.kind).toBe('directory');
    expect(stat.size).toBe(0);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it('отсутствующий путь — not_found', async () => {
    expect(await captureCode(port.fs!.stat(join(root, 'nope')))).toBe('not_found');
  });

  it('пустой путь — invalid', async () => {
    expect(await captureCode(port.fs!.stat(''))).toBe('invalid');
  });

  it('путь с NUL — invalid', async () => {
    expect(await captureCode(port.fs!.stat(`${root}/a\u0000b`))).toBe('invalid');
  });
});

describe('ExecutionFs (inline): readdir', () => {
  it('записи каталога — с размерами и видами', async () => {
    const entries = await port.fs!.readdir(root);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get('a.txt')).toMatchObject({ kind: 'file', size: 5 });
    expect(byName.get('sub')).toMatchObject({ kind: 'directory' });
    expect(byName.get('link.txt')).toMatchObject({ kind: 'other' });
  });

  it('порядок — файловый (сортировку делает вызывающий)', async () => {
    const entries = await port.fs!.readdir(root);
    const names = entries.map((entry) => entry.name);
    // Контракт не обещает порядок: сортировка — на стороне вызывающего.
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
    expect(entries.every((entry) => typeof entry.name === 'string' && entry.name.length > 0)).toBe(true);
  });

  it('каталог пуст — пустой список', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    expect(await port.fs!.readdir(empty)).toEqual([]);
  });

  it('путь-файл вместо каталога — not_directory', async () => {
    expect(await captureCode(port.fs!.readdir(file))).toBe('not_directory');
  });

  it('отсутствующий каталог — not_found', async () => {
    expect(await captureCode(port.fs!.readdir(join(root, 'nope')))).toBe('not_found');
  });
});

describe('ExecutionFs (inline): realpath', () => {
  it('симлинк — канонический путь цели', async () => {
    expect(await port.fs!.realpath(link)).toBe(file);
  });

  it('обычный путь — сам путь', async () => {
    expect(await port.fs!.realpath(file)).toBe(file);
  });

  it('битый симлинк — unresolvable (fail-closed)', async () => {
    expect(await captureCode(port.fs!.realpath(brokenLink))).toBe('unresolvable');
  });

  it('отсутствующий путь — not_found', async () => {
    expect(await captureCode(port.fs!.realpath(join(root, 'nope')))).toBe('not_found');
  });
});

describe('ExecutionFs (inline): readText', () => {
  it('строки с исходной 1-based нумерацией, totalLines и размер вывода', async () => {
    const page = await port.fs!.readText(file);

    expect(page.lines).toEqual(['1: hello']);
    expect(page.totalLines).toBe(1);
    expect(page.truncated).toBe(false);
    expect(page.bytes).toBe(Buffer.byteLength('1: hello', 'utf-8'));
  });

  it('offset/limit: страница с исходной нумерацией, totalLines — по всему файлу', async () => {
    const many = join(root, 'many.txt');
    await writeFile(many, 'a\nb\nc\nd\n');

    const page = await port.fs!.readText(many, { offset: 1, limit: 2 });

    expect(page.lines).toEqual(['2: b', '3: c']);
    expect(page.totalLines).toBe(4);
    expect(page.truncated).toBe(true);
  });

  it('усечение по лимиту байт: страница короче, truncated — true', async () => {
    const many = join(root, 'bytes.txt');
    await writeFile(many, 'первая\nвторая\nтретья\n');

    const page = await port.fs!.readText(many, { maxBytes: 10 });

    expect(page.truncated).toBe(true);
    expect(page.lines.length).toBeLessThan(3);
    expect(page.bytes).toBeLessThanOrEqual(10);
  });

  it('пустой файл — пустая страница', async () => {
    const empty = join(root, 'empty.txt');
    await writeFile(empty, '');

    const page = await port.fs!.readText(empty);

    expect(page.lines).toEqual([]);
    expect(page.totalLines).toBe(0);
    expect(page.truncated).toBe(false);
  });

  it('отсутствующий файл — not_found', async () => {
    expect(await captureCode(port.fs!.readText(join(root, 'nope.txt')))).toBe('not_found');
  });
});

describe('ExecutionFs (inline): sniff', () => {
  it('текстовый файл — не бинарь', async () => {
    const result = await port.fs!.sniff(file);

    expect(result.binary).toBe(false);
    expect(result.mime).toBeUndefined();
  });

  it('бинарный файл — binary: true', async () => {
    const blob = join(root, 'blob.bin');
    await writeFile(blob, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]));

    const result = await port.fs!.sniff(blob);

    expect(result.binary).toBe(true);
  });

  it('PNG — MIME по сигнатуре', async () => {
    const png = join(root, 'shot.png');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));

    const result = await port.fs!.sniff(png);

    expect(result.binary).toBe(true);
    expect(result.mime).toBe('image/png');
  });

  it('отсутствующий файл — not_found', async () => {
    expect(await captureCode(port.fs!.sniff(join(root, 'nope.png')))).toBe('not_found');
  });
});

describe('ExecutionFs (inline): readBytes', () => {
  it('байты файла — в base64, размер совпадает', async () => {
    const result = await port.fs!.readBytes(file, 1024);

    expect(result.size).toBe(5);
    expect(Buffer.from(result.dataBase64, 'base64').toString('utf-8')).toBe('hello');
  });

  it('файл больше лимита — too_large (файл не читается)', async () => {
    const err = await captureFsError(port.fs!.readBytes(file, 2));
    expect(err.code).toBe('too_large');
    // Сообщение содержит лимит — по нему модель понимает, что уменьшить.
    expect(err.message).toContain('2');
  });

  it('отсутствующий файл — not_found', async () => {
    expect(await captureCode(port.fs!.readBytes(join(root, 'nope.txt'), 1024))).toBe('not_found');
  });
});

/**
 * Запись файла (PROP-135, Ф2) — общие правила для обеих топологий:
 * атомарная запись, права существующего файла, создание родительских
 * каталогов, разыменование симлинка.
 */
describe('ExecutionFs (inline): writeFile', () => {
  it('новый файл — создан с нужным содержимым', async () => {
    const target = join(root, 'written.txt');

    await port.fs!.writeFile(target, 'first\n');

    await expect(readFile(target, 'utf-8')).resolves.toBe('first\n');
  });

  it('перезапись — содержимое заменено', async () => {
    const target = join(root, 'overwritten.txt');
    await writeFile(target, 'old\n');

    await port.fs!.writeFile(target, 'new\n');

    await expect(readFile(target, 'utf-8')).resolves.toBe('new\n');
  });

  it('права существующего файла сохраняются (0640)', async () => {
    const target = join(root, 'mode.txt');
    await writeFile(target, 'old');
    await chmod(target, 0o640);

    await port.fs!.writeFile(target, 'new');

    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it('родительские каталоги создаются', async () => {
    const target = join(root, 'deep', 'nested', 'file.txt');

    await port.fs!.writeFile(target, 'deep\n');

    await expect(readFile(target, 'utf-8')).resolves.toBe('deep\n');
  });

  it('запись через симлинк — пишем в цель, симлинк остаётся симлинком', async () => {
    const target = join(root, 'sym-target.txt');
    const link = join(root, 'sym-link.txt');
    await writeFile(target, 'old\n');
    await symlink(target, link);

    await port.fs!.writeFile(link, 'new\n');

    await expect(readFile(target, 'utf-8')).resolves.toBe('new\n');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('временный файл записи не остаётся в каталоге', async () => {
    const target = join(root, 'atomic.txt');

    await port.fs!.writeFile(target, 'data\n');

    const names = await (await import('node:fs/promises')).readdir(root);
    expect(names.filter((name) => name.includes('.synth-tmp-'))).toEqual([]);
  });

  it('пустой путь — invalid', async () => {
    expect(await captureCode(port.fs!.writeFile('', 'x'))).toBe('invalid');
  });
});

describe('ExecutionFs (inline): mkdir', () => {
  it('каталог создан (с родительскими)', async () => {
    const target = join(root, 'made', 'nested');

    await port.fs!.mkdir(target);

    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('существующий каталог — ошибки нет (идемпотентно)', async () => {
    const target = join(root, 'made-twice');

    await port.fs!.mkdir(target);
    await expect(port.fs!.mkdir(target)).resolves.toBeUndefined();
  });

  it('путь-файл вместо каталога — invalid', async () => {
    expect(await captureCode(port.fs!.mkdir(file))).toBe('invalid');
  });

  it('пустой путь — invalid', async () => {
    expect(await captureCode(port.fs!.mkdir(''))).toBe('invalid');
  });
});

describe('ExecutionFs (inline): remove', () => {
  it('файл удалён', async () => {
    const target = join(root, 'to-remove.txt');
    await writeFile(target, 'x');

    await port.fs!.remove(target);

    await expect(stat(target)).rejects.toThrow();
  });

  it('пустой каталог удалён', async () => {
    const target = join(root, 'empty-dir');
    await mkdir(target, { recursive: true });

    await port.fs!.remove(target);

    await expect(stat(target)).rejects.toThrow();
  });

  it('непустой каталог — invalid (рекурсивного удаления нет)', async () => {
    const target = join(root, 'full-dir');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'inner.txt'), 'x');

    expect(await captureCode(port.fs!.remove(target))).toBe('invalid');
    // Каталог на месте — содержимое не тронуто.
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('отсутствующий путь — not_found', async () => {
    expect(await captureCode(port.fs!.remove(join(root, 'nope.txt')))).toBe('not_found');
  });

  it('пустой путь — invalid', async () => {
    expect(await captureCode(port.fs!.remove(''))).toBe('invalid');
  });
});

/**
 * «Сырой» текст файла (PROP-135, Ф2) — нужен тулам правки: они
 * сопоставляют правку с **точным** содержимым файла, а `readText` отдаёт
 * готовые строки вывода (`N: текст`).
 */
describe('ExecutionFs (inline): readRawText', () => {
  it('текст — как есть, без нумерации строк', async () => {
    const target = join(root, 'raw.txt');
    await writeFile(target, 'первая\nвторая\n', 'utf-8');

    const raw = await port.fs!.readRawText(target, 1024);

    expect(raw.text).toBe('первая\nвторая\n');
    // Размер — в байтах (UTF-8), а не в символах.
    expect(raw.size).toBe(Buffer.byteLength('первая\nвторая\n', 'utf-8'));
  });

  it('CRLF сохраняется — «как есть»', async () => {
    const target = join(root, 'raw-crlf.txt');
    await writeFile(target, 'a\r\nb\r\n', 'utf-8');

    const raw = await port.fs!.readRawText(target, 1024);

    expect(raw.text).toBe('a\r\nb\r\n');
  });

  it('файл больше лимита — too_large (файл не читается)', async () => {
    const target = join(root, 'raw-big.txt');
    await writeFile(target, '0123456789', 'utf-8');

    const err = await captureFsError(port.fs!.readRawText(target, 4));
    expect(err.code).toBe('too_large');
    expect(err.message).toContain('4');
  });

  it('отсутствующий файл — not_found', async () => {
    expect(await captureCode(port.fs!.readRawText(join(root, 'nope.txt'), 1024))).toBe('not_found');
  });
});

/**
 * Перенос файла (PROP-135, Ф2) — те же правила в обеих топологиях.
 */
describe('ExecutionFs (inline): rename', () => {
  it('файл перенесён под новым именем', async () => {
    const from = join(root, 'rename-from.txt');
    const to = join(root, 'rename-to.txt');
    await writeFile(from, 'payload\n', 'utf-8');

    await port.fs!.rename(from, to);

    await expect(readFile(to, 'utf-8')).resolves.toBe('payload\n');
    await expect(stat(from)).rejects.toThrow();
  });

  it('каталог перенесён', async () => {
    const from = join(root, 'rename-dir');
    const to = join(root, 'rename-dir-moved');
    await mkdir(from, { recursive: true });

    await port.fs!.rename(from, to);

    expect((await stat(to)).isDirectory()).toBe(true);
    await expect(stat(from)).rejects.toThrow();
  });

  it('источника нет — not_found', async () => {
    expect(await captureCode(port.fs!.rename(join(root, 'nope.txt'), join(root, 'to.txt')))).toBe('not_found');
  });

  it('цель уже существует — invalid (цель не перезаписана)', async () => {
    const from = join(root, 'rename-src.txt');
    const to = join(root, 'rename-dst.txt');
    await writeFile(from, 'one\n', 'utf-8');
    await writeFile(to, 'two\n', 'utf-8');

    expect(await captureCode(port.fs!.rename(from, to))).toBe('invalid');
    await expect(readFile(to, 'utf-8')).resolves.toBe('two\n');
  });

  it('пустой путь — invalid', async () => {
    expect(await captureCode(port.fs!.rename('', join(root, 'to.txt')))).toBe('invalid');
  });
});
