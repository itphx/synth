// ADR-091: тесты минимального потокового tar.gz (ustar) на временных каталогах.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchivePathError,
  listFilesForArchive,
  listTarGz,
  readFileFromTarGz,
  readTarGz,
  writeTarGz,
} from './archive.js';

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
