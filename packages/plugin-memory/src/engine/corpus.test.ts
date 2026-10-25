/**
 * М2: тесты сбора корпуса файлов.
 *
 * Проверяются правила отбора: текстовые расширения, исключаемые каталоги и
 * файлы, бинарность, лимит размера, относительные POSIX-пути и glob-фильтр
 * источника.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectTextFiles, isTextExtension, matchesAnyGlob } from './corpus.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Каталог со смешанным содержимым. */
async function makeTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-corpus-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'readme.md'), 'readme\n', 'utf-8');
  await writeFile(join(dir, 'main.ts'), 'export const a = 1;\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '# lock\n', 'utf-8');
  await writeFile(join(dir, 'bundle.min.js'), 'var a=1\n', 'utf-8');
  await writeFile(join(dir, 'main.js.map'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'image.png'), 'binary\n', 'utf-8');
  await writeFile(join(dir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]));
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'module\n', 'utf-8');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'docs', 'guide.md'), 'guide\n', 'utf-8');
  return dir;
}

describe('сбор корпуса файлов', () => {
  it('берёт только текстовые файлы, пути — относительные POSIX', async () => {
    const dir = await makeTree();
    const files = await collectTextFiles(dir, { maxFileBytes: 100_000, exclude: [] });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('readme.md');
    expect(paths).toContain('main.ts');
    expect(paths).toContain('docs/guide.md');
    expect(paths.every((path) => !path.startsWith('/'))).toBe(true);
    expect(paths.every((path) => !path.includes('\\'))).toBe(true);
  });

  it('исключает служебные каталоги, lock/min/map и бинарные файлы', async () => {
    const dir = await makeTree();
    const paths = (await collectTextFiles(dir, { maxFileBytes: 100_000, exclude: [] })).map(
      (file) => file.path,
    );

    expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
    expect(paths).not.toContain('yarn.lock');
    expect(paths).not.toContain('bundle.min.js');
    expect(paths).not.toContain('main.js.map');
    expect(paths).not.toContain('image.png');
    expect(paths).not.toContain('data.bin');
  });

  it('предикат хоста отсекает каталоги и файлы до include/exclude', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-corpus-policy-'));
    tempDirs.push(dir);

    await writeFile(join(dir, 'readme.md'), 'readme\n', 'utf-8');
    await writeFile(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
    await writeFile(join(dir, 'private.txt'), 'hidden\n', 'utf-8');
    await mkdir(join(dir, 'vault'), { recursive: true });
    await writeFile(join(dir, 'vault', 'note.md'), 'hidden\n', 'utf-8');

    const seen: string[] = [];
    const files = await collectTextFiles(dir, {
      maxFileBytes: 100_000,
      exclude: [],
      isSecretName: (name, kind) => {
        seen.push(`${kind}:${name}`);
        return name === 'private.txt' || name === 'vault';
      },
    });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('readme.md');
    expect(paths).toContain('keep.txt');
    expect(paths).not.toContain('private.txt');
    expect(paths.some((path) => path.startsWith('vault/'))).toBe(false);
    // Предикат спрашивают и для каталогов, и для файлов.
    expect(seen).toContain('directory:vault');
    expect(seen).toContain('file:private.txt');
  });

  it('файлы больше лимита размера пропускаются', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-corpus-big-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'small.md'), 'ok\n', 'utf-8');
    await writeFile(join(dir, 'big.md'), 'x'.repeat(5000), 'utf-8');

    const paths = (await collectTextFiles(dir, { maxFileBytes: 1024, exclude: [] })).map(
      (file) => file.path,
    );
    expect(paths).toEqual(['small.md']);
  });

  it('glob-включение ограничивает корпус', async () => {
    const dir = await makeTree();
    const paths = (
      await collectTextFiles(dir, { maxFileBytes: 100_000, exclude: [], include: 'docs/**' })
    ).map((file) => file.path);
    expect(paths).toEqual(['docs/guide.md']);
  });

  it('glob-исключение из настроек убирает файлы', async () => {
    const dir = await makeTree();
    const paths = (
      await collectTextFiles(dir, { maxFileBytes: 100_000, exclude: ['docs/**'] })
    ).map((file) => file.path);
    expect(paths.some((path) => path.startsWith('docs/'))).toBe(false);
    expect(paths).toContain('readme.md');
  });

  it('несуществующий каталог → пустой корпус (без ошибки)', async () => {
    expect(await collectTextFiles('/нет/такого/каталога', { maxFileBytes: 1000, exclude: [] })).toEqual(
      [],
    );
  });

  it('расширения: текстовые — да, служебные — нет', () => {
    expect(isTextExtension('a.md')).toBe(true);
    expect(isTextExtension('a.ts')).toBe(true);
    expect(isTextExtension('a.png')).toBe(false);
    expect(isTextExtension('a.min.js')).toBe(false);
    expect(isTextExtension('a.lock')).toBe(false);
    expect(isTextExtension('a.js.map')).toBe(false);
  });

  it('glob: `*` — внутри сегмента, `**` — через сегменты', () => {
    expect(matchesAnyGlob('docs/a.md', ['docs/*'])).toBe(true);
    expect(matchesAnyGlob('docs/sub/a.md', ['docs/*'])).toBe(false);
    expect(matchesAnyGlob('docs/sub/a.md', ['docs/**'])).toBe(true);
    expect(matchesAnyGlob('other/a.md', ['docs/**'])).toBe(false);
  });
});
