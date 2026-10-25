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

import { collectTextFiles, isSecretFile, isTextExtension, matchesAnyGlob } from './corpus.js';

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

  it('исключает файлы и каталоги с секретами, не трогая обычные документы', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-corpus-secrets-'));
    tempDirs.push(dir);

    // Обычные файлы — должны остаться (в т.ч. документ со словом «secret» в имени).
    await writeFile(join(dir, 'readme.md'), 'readme\n', 'utf-8');
    await writeFile(join(dir, 'config.yaml'), 'ok: true\n', 'utf-8');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'secret-guide.md'), 'guide\n', 'utf-8');

    // Файлы с секретами по имени/расширению.
    for (const name of [
      'credentials.json',
      'secrets.yaml',
      'service-account-prod.json',
      '.env',
      '.env.local',
      '.npmrc',
      'id_rsa',
      'server.pem',
      'server.key',
      'terraform.tfstate',
    ]) {
      await writeFile(join(dir, name), 'secret\n', 'utf-8');
    }

    // Каталоги, где секреты живут по соглашению.
    for (const name of ['secrets', '.ssh', '.aws', '.kube', '.docker', '.terraform']) {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, 'notes.md'), 'secret\n', 'utf-8');
    }

    const paths = (await collectTextFiles(dir, { maxFileBytes: 100_000, exclude: [] })).map(
      (file) => file.path,
    );

    expect(paths).toContain('readme.md');
    expect(paths).toContain('config.yaml');
    expect(paths).toContain('docs/secret-guide.md');
    for (const hidden of [
      'credentials.json',
      'secrets.yaml',
      'service-account-prod.json',
      '.env',
      '.env.local',
      '.npmrc',
      'id_rsa',
      'server.pem',
      'server.key',
      'terraform.tfstate',
      'secrets/notes.md',
      '.ssh/notes.md',
      '.aws/notes.md',
      '.kube/notes.md',
      '.docker/notes.md',
      '.terraform/notes.md',
    ]) {
      expect(paths).not.toContain(hidden);
    }
  });

  it('isSecretFile: известные файлы секретов — да, документы — нет', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('.env.production')).toBe(true);
    expect(isSecretFile('credentials.json')).toBe(true);
    expect(isSecretFile('secrets.yaml')).toBe(true);
    expect(isSecretFile('service-account-prod.json')).toBe(true);
    expect(isSecretFile('id_ed25519')).toBe(true);
    expect(isSecretFile('server.pem')).toBe(true);
    expect(isSecretFile('credentials-guide.md')).toBe(false);
    expect(isSecretFile('secret-guide.md')).toBe(false);
    expect(isSecretFile('config.yaml')).toBe(false);
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
