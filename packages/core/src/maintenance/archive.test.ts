// ADR-091: тесты минимального потокового tar.gz (ustar) на временных каталогах.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveLimitError,
  ArchivePathError,
  listFilesForArchive,
  listTarGz,
  readFileFromTarGz,
  readTarGz,
  writeTarGz,
} from './archive.js';
import { rawTarHeader, tarContent } from '../test-helpers/archive-bomb.js';

describe('archive (tar.gz ustar)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-archive-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function buildRoundtripTree(): Promise<string> {
    const root = join(tmpDir, 'root');
    await mkdir(join(root, 'a', 'b'), { recursive: true, mode: 0o750 });
    await writeFile(join(root, 'a', 'file1.txt'), 'hello\n', 'utf-8');
    await chmod(join(root, 'a', 'file1.txt'), 0o640);
    await writeFile(join(root, 'a', 'b', 'empty.bin'), Buffer.alloc(0));
    await writeFile(join(root, 'кириллица.txt'), 'привет\n', 'utf-8');
    return root;
  }

  it('roundtrip: вложенные каталоги, пустой файл, кириллица, права', async () => {
    const root = await buildRoundtripTree();
    const sources = await listFilesForArchive(root, { exclude: () => false });
    const archive = join(tmpDir, 'out.tar.gz');
    await writeTarGz(archive, sources);

    const seen = new Map<string, { type: string; content: string; mode: number }>();
    await readTarGz(archive, (entry) => {
      seen.set(entry.path, {
        type: entry.type,
        content: entry.content.toString('utf-8'),
        mode: entry.mode,
      });
    });

    expect(seen.get('a')?.type).toBe('dir');
    expect(seen.get('a/file1.txt')?.content).toBe('hello\n');
    expect(seen.get('a/file1.txt')?.mode).toBe(0o640);
    expect(seen.get('a/b/empty.bin')?.content).toBe('');
    expect(seen.get('кириллица.txt')?.content).toBe('привет\n');

    const list = await listTarGz(archive);
    const paths = list.map((entry) => entry.path);
    expect(paths).toContain('a/b/empty.bin');
    expect(list.find((entry) => entry.path === 'a/file1.txt')?.size).toBe(6);
  });

  it('порядок списка детерминирован (сортировка)', async () => {
    const root = join(tmpDir, 'det');
    await mkdir(join(root, 'z'), { recursive: true });
    await writeFile(join(root, 'b.txt'), 'b', 'utf-8');
    await writeFile(join(root, 'a.txt'), 'a', 'utf-8');
    await writeFile(join(root, 'z', 'm.txt'), 'm', 'utf-8');

    const first = (await listFilesForArchive(root, { exclude: () => false })).map((s) => s.path);
    const second = (await listFilesForArchive(root, { exclude: () => false })).map((s) => s.path);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
    // Каталог идёт перед своим содержимым.
    expect(first.indexOf('z')).toBeLessThan(first.indexOf('z/m.txt'));
  });

  it('исключения пропускают каталог и его содержимое', async () => {
    const root = join(tmpDir, 'excl');
    await mkdir(join(root, 'keep'), { recursive: true });
    await mkdir(join(root, 'skip'), { recursive: true });
    await writeFile(join(root, 'keep', 'a.txt'), 'a', 'utf-8');
    await writeFile(join(root, 'skip', 'b.txt'), 'b', 'utf-8');

    const sources = await listFilesForArchive(root, { exclude: (rel) => rel.split('/')[0] === 'skip' });
    const paths = sources.map((s) => s.path);
    expect(paths).toContain('keep/a.txt');
    expect(paths).not.toContain('skip');
    expect(paths).not.toContain('skip/b.txt');
  });

  it('манифест (extraFile) читается, список включает manifest.json, хеши верны', async () => {
    const root = await buildRoundtripTree();
    const sources = await listFilesForArchive(root, { exclude: () => false });
    const archive = join(tmpDir, 'with-manifest.tar.gz');
    const manifest = Buffer.from(JSON.stringify({ tool: 'synth-backup' }), 'utf-8');

    const metas = await writeTarGz(archive, sources, {
      extraFile: { path: 'manifest.json', content: manifest },
    });

    const file1 = metas.find((meta) => meta.path === 'a/file1.txt');
    const expected = createHash('sha256').update('hello\n').digest('hex');
    expect(file1?.sha256).toBe(expected);
    expect(metas.every((meta) => meta.type === 'dir' || typeof meta.sha256 === 'string')).toBe(true);

    const readBack = await readFileFromTarGz(archive, 'manifest.json');
    expect(readBack?.toString('utf-8')).toBe(manifest.toString('utf-8'));

    const list = await listTarGz(archive);
    expect(list.map((entry) => entry.path)).toContain('manifest.json');
  });

  it('длинный путь >100 байт разбивается на prefix/name (ustar)', async () => {
    const root = join(tmpDir, 'long');
    const segment = 'p'.repeat(80);
    const fileName = `${'n'.repeat(80)}.txt`;
    await mkdir(join(root, segment), { recursive: true });
    await writeFile(join(root, segment, fileName), 'long', 'utf-8');

    const sources = await listFilesForArchive(root, { exclude: () => false });
    const archive = join(tmpDir, 'long.tar.gz');
    await writeTarGz(archive, sources);

    const list = await listTarGz(archive);
    const target = `${segment}/${fileName}`;
    expect(target.length).toBeGreaterThan(100);
    expect(list.map((entry) => entry.path)).toContain(target);
  });

  it('запись "." / ".." в архиве → ArchivePathError при чтении', async () => {
    const root = join(tmpDir, 'evil');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'real.txt'), 'x', 'utf-8');
    const archive = join(tmpDir, 'evil.tar.gz');

    await writeTarGz(archive, [
      { path: '../evil', type: 'file', absPath: join(root, 'real.txt'), mode: 0o600 },
    ]);

    await expect(readTarGz(archive, () => {})).rejects.toBeInstanceOf(ArchivePathError);
  });

  it('чтение неразбираемого файла → ошибка', async () => {
    const bogus = join(tmpDir, 'bogus.tar.gz');
    await writeFile(bogus, Buffer.from('not a gzip stream at all'));
    await expect(readTarGz(bogus, () => {})).rejects.toBeTruthy();
  });

  it('каталог в архиве записан с завершающим "/" (typeflag 5) и size 0', async () => {
    const root = join(tmpDir, 'dirtype');
    await mkdir(join(root, 'd'), { recursive: true });
    await writeFile(join(root, 'd', 'f.txt'), 'f', 'utf-8');
    const sources = await listFilesForArchive(root, { exclude: () => false });
    const archive = join(tmpDir, 'dirtype.tar.gz');
    await writeTarGz(archive, sources);

    const dirEntry = (await listTarGz(archive)).find((entry) => entry.path === 'd');
    expect(dirEntry?.type).toBe('dir');
    expect(dirEntry?.size).toBe(0);
    const info = await stat(archive);
    expect(info.size).toBeGreaterThan(0);
  });
});

/**
 * Сырой ustar-заголовок с ЗАЯВЛЕННЫМ размером записи: позволяет собрать
 * archive-«бомбу» (заголовок обещает гигабайты, а данных в архиве — килобайты).
 */

describe('archive: лимиты разбора (защита от archive-бомб)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-archive-limits-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('лимит одной записи: превышение отсекается по заголовку, содержимое не буферизуется', async () => {
    // Заголовок объявляет 1 ГиБ, а в архиве — 8 байт данных.
    const header = rawTarHeader('workspace/huge.bin', 1024 * 1024 * 1024);
    const archive = join(tmpDir, 'bomb.tar.gz');
    await writeFile(archive, gzipSync(Buffer.concat([header, tarContent(Buffer.alloc(8))])));

    const seen: string[] = [];
    let caught: unknown;
    try {
      await readTarGz(archive, (entry) => { seen.push(entry.path); }, { maxEntryBytes: 1024 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArchiveLimitError);
    expect((caught as ArchiveLimitError).limit).toBe('entry-size');
    expect((caught as ArchiveLimitError).limitValue).toBe(1024);
    // Ключевое: обработчик не вызван — содержимое огромной записи не буферизовалось.
    expect(seen).toEqual([]);
    // Файл архива на диске при этом маленький — распаковать его не успели.
    expect((await stat(archive)).size).toBeLessThan(64 * 1024);
  });

  it('лимит числа записей: превышение обрывает разбор', async () => {
    const archive = join(tmpDir, 'many.tar.gz');
    await writeFile(archive, gzipSync(Buffer.concat([
      rawTarHeader('a.txt', 1),
      tarContent(Buffer.from('a')),
      rawTarHeader('b.txt', 1),
      tarContent(Buffer.from('b')),
      rawTarHeader('c.txt', 1),
      tarContent(Buffer.from('c')),
    ])));

    let caught: unknown;
    try {
      await readTarGz(archive, () => {}, { maxEntries: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArchiveLimitError);
    expect((caught as ArchiveLimitError).limit).toBe('entries');
  });

  it('лимит суммарного объёма: превышение обрывает разбор', async () => {
    const archive = join(tmpDir, 'total.tar.gz');
    await writeFile(archive, gzipSync(Buffer.concat([
      rawTarHeader('a.bin', 100),
      tarContent(Buffer.alloc(100)),
      rawTarHeader('b.bin', 100),
      tarContent(Buffer.alloc(100)),
    ])));

    let caught: unknown;
    try {
      await readTarGz(archive, () => {}, { maxTotalBytes: 150 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArchiveLimitError);
    expect((caught as ArchiveLimitError).limit).toBe('total-size');
    expect((caught as ArchiveLimitError).actual).toBe(200);
  });

  it('в пределах лимитов архив читается как обычно', async () => {
    const archive = join(tmpDir, 'ok.tar.gz');
    await writeFile(archive, gzipSync(Buffer.concat([
      rawTarHeader('a.txt', 5),
      tarContent(Buffer.from('hello')),
    ])));

    const seen: string[] = [];
    await readTarGz(archive, (entry) => { seen.push(entry.path); }, {
      maxEntries: 10,
      maxEntryBytes: 1024,
      maxTotalBytes: 4096,
    });
    expect(seen).toEqual(['a.txt']);
  });

  it('readFileFromTarGz тоже ограничен (манифест читается в тех же рамках)', async () => {
    const archive = join(tmpDir, 'manifest-bomb.tar.gz');
    await writeFile(archive, gzipSync(Buffer.concat([
      rawTarHeader('manifest.json', 1024 * 1024 * 1024),
      tarContent(Buffer.alloc(8)),
    ])));

    await expect(readFileFromTarGz(archive, 'manifest.json', { maxEntryBytes: 1024 })).rejects
      .toBeInstanceOf(ArchiveLimitError);
  });
});
